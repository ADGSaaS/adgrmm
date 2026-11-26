// Linux patching: finds the package manager, lists the updates it offers (with a security flag where the distribution
// says which are security updates), installs them without asking questions, and reports whether a restart is needed.
//
// This file holds the logic and no platform code: everything that touches the machine goes through ILinuxPatchHost, so
// the parsing and the sequence of commands are tested against real output of apt, dnf and zypper.
//
// Supported: apt (Debian, Ubuntu), dnf and yum (Fedora, RHEL, Rocky, Alma, CentOS), zypper (openSUSE Leap, SLES).
// Anything else (apk, pacman, rolling openSUSE Tumbleweed) is refused with a message instead of guessed at.
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace AdgRmm.Agent.Shared;

public enum LinuxPackageManager { None, Apt, Dnf, Yum, Zypper }

/// <summary>One update the package manager offers. Id is what an install task names it by.</summary>
public sealed class LinuxPatch
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Title { get; set; } = "";
    public string? Current { get; set; }
    public string? Available { get; set; }
    public bool Security { get; set; }
    /// <summary>Critical, Important, Moderate or Low where the distribution says; security updates without a rating are Important.</summary>
    public string? Severity { get; set; }
    public bool RequiresReboot { get; set; }
    public string[] Advisories { get; set; } = Array.Empty<string>();
    public string? Source { get; set; }
}

public sealed record LinuxPatchSkip(string Id, string Reason);

public sealed class LinuxScanResult
{
    public LinuxPackageManager Manager { get; set; }
    public List<LinuxPatch> Patches { get; } = new();
    /// <summary>Packages the manager is not offering right now: held, kept back, or not yet released to this machine (phased).</summary>
    public List<LinuxPatchSkip> Skipped { get; } = new();
    public bool RebootRequired { get; set; }
    public string? RebootReason { get; set; }
    public string Log { get; set; } = "";
}

public sealed class LinuxInstallRequest
{
    /// <summary>"selected" (the ids), "security" (every security update) or "all".</summary>
    public string Mode { get; set; } = "selected";
    public string[] Ids { get; set; } = Array.Empty<string>();
    public bool IncludeOptional { get; set; }
}

public sealed class LinuxInstallResult
{
    public bool Ok { get; set; }
    public string Message { get; set; } = "";
    public List<string> Installed { get; } = new();
    public List<string> Failed { get; } = new();
    public List<LinuxPatchSkip> Skipped { get; } = new();
    public bool RebootRequired { get; set; }
    public string Log { get; set; } = "";
}

/// <summary>Something the task cannot do and says so plainly: no supported package manager, locked too long, and so on.</summary>
public sealed class LinuxPatchException : Exception
{
    public string Log { get; }
    public LinuxPatchException(string message, string log = "") : base(message) { Log = log; }
}

public sealed record PatchProcResult(int ExitCode, string Stdout, string Stderr, bool TimedOut);

/// <summary>Everything the engine needs from the machine.</summary>
public interface ILinuxPatchHost
{
    bool HasCommand(string name);
    string? ReadText(string path);
    bool FileExists(string path);
    Task<PatchProcResult> RunAsync(string file, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct);
    Task DelayAsync(TimeSpan delay, CancellationToken ct);
}

// ─── Parsers ────────────────────────────────────────────────────────────────

public static class LinuxPatchParsers
{
    public sealed record AptInst(string Name, string? Current, string Available, string Origins);

    public sealed class AptSimulation
    {
        public List<AptInst> Upgrades { get; } = new();
        /// <summary>Packages that would be newly installed (dependencies, and a new kernel).</summary>
        public List<AptInst> NewInstalls { get; } = new();
        public List<string> Removals { get; } = new();
        public List<string> KeptBack { get; } = new();
        public List<string> Phased { get; } = new();
    }

    // Inst base-files [11ubuntu5.6] (11ubuntu5.8 Ubuntu:22.04/jammy-updates [amd64])
    // Inst linux-image-5.15.0-91-generic (5.15.0-91.101 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])
    private static readonly Regex AptInstLine = new(@"^Inst\s+(?<name>\S+)(?:\s+\[(?<cur>[^\]]*)\])?\s+\((?<new>\S+)\s*(?<origins>.*?)(?:\s+\[(?<arch>[^\[\]]*)\])?\)", RegexOptions.Compiled);

    /// <summary>
    /// Reads "apt-get -s ..." output. The Inst and Remv words are never translated, so the packages are found in any
    /// language; the "kept back" and "deferred" lists are only recognised in English, which is why the commands are run
    /// with LC_ALL=C and why held packages are also asked for separately.
    /// </summary>
    public static AptSimulation ParseAptSimulation(string text)
    {
        var sim = new AptSimulation();
        List<string>? section = null;
        foreach (var raw in (text ?? "").Replace("\r", "").Split('\n'))
        {
            if (raw.StartsWith("Inst ", StringComparison.Ordinal))
            {
                section = null;
                var m = AptInstLine.Match(raw);
                if (!m.Success) continue;
                var inst = new AptInst(m.Groups["name"].Value, m.Groups["cur"].Success ? m.Groups["cur"].Value : null, m.Groups["new"].Value, m.Groups["origins"].Value.Trim());
                (inst.Current is null ? sim.NewInstalls : sim.Upgrades).Add(inst);
                continue;
            }
            if (raw.StartsWith("Remv ", StringComparison.Ordinal))
            {
                section = null;
                var parts = raw.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length > 1) sim.Removals.Add(parts[1]);
                continue;
            }
            if (raw.StartsWith("Conf ", StringComparison.Ordinal)) { section = null; continue; }

            if (raw.Length > 0 && !char.IsWhiteSpace(raw[0]))
            {
                section = raw.StartsWith("The following packages have been kept back", StringComparison.Ordinal) ? sim.KeptBack
                    : raw.StartsWith("The following upgrades have been deferred due to phasing", StringComparison.Ordinal) ? sim.Phased
                    : null;
                continue;
            }
            if (section is not null && raw.Length > 0)
                section.AddRange(raw.Split(' ', StringSplitOptions.RemoveEmptyEntries));
        }
        return sim;
    }

    /// <summary>"apt-mark showhold": one package per line.</summary>
    public static HashSet<string> ParseLines(string text) =>
        new((text ?? "").Replace("\r", "").Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0), StringComparer.Ordinal);

    /// <summary>Security archives are named like jammy-security, bookworm-security, Debian-Security, focal-infra-security (ESM).</summary>
    public static bool AptOriginIsSecurity(string origins) => Regex.IsMatch(origins ?? "", "security", RegexOptions.IgnoreCase);

    public sealed record RpmUpdate(string Name, string Arch, string Available, string Repo)
    {
        public string Id => $"{Name}.{Arch}";
    }

    /// <summary>
    /// Reads "dnf check-update" / "yum check-update": "name.arch  version  repo" per line. Everything after an
    /// "Obsoleting Packages" heading is replacements for other packages, not updates. Old yum wraps a long name onto its
    /// own line, so a line of one word is joined with the next.
    /// </summary>
    public static List<RpmUpdate> ParseCheckUpdate(string text)
    {
        var list = new List<RpmUpdate>();
        string? pendingName = null;
        foreach (var raw in (text ?? "").Replace("\r", "").Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0) { pendingName = null; continue; }
            if (line.StartsWith("Obsoleting Packages", StringComparison.OrdinalIgnoreCase)) break;
            if (line.StartsWith("Security:", StringComparison.OrdinalIgnoreCase)) continue;
            if (line.Contains(':') && line.Contains(' ') && Regex.IsMatch(line, @"^(Last metadata|Updating|Loaded plugins|Repositories loaded|Waiting|Extra|Copr|No match)", RegexOptions.IgnoreCase)) continue;

            var parts = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (pendingName is not null && parts.Length == 2) { parts = new[] { pendingName, parts[0], parts[1] }; pendingName = null; }
            if (parts.Length == 1 && Regex.IsMatch(parts[0], @"^[A-Za-z0-9_.+\-]+\.[A-Za-z0-9_]+$")) { pendingName = parts[0]; continue; }
            pendingName = null;
            if (parts.Length != 3) continue;

            var dot = parts[0].LastIndexOf('.');
            if (dot <= 0 || !Regex.IsMatch(parts[1], @"^\S*\d\S*$")) continue;
            var arch = parts[0][(dot + 1)..];
            if (!Regex.IsMatch(arch, @"^(x86_64|i[3-6]86|aarch64|ppc64le|s390x|armv7hl|noarch|src)$")) continue;
            list.Add(new RpmUpdate(parts[0][..dot], arch, parts[1], parts[2]));
        }
        return list;
    }

    public sealed record Advisory(string Id, string Kind, string? Severity, string Name, string Arch);

    /// <summary>
    /// Reads "dnf updateinfo list --updates": "RHSA-2024:1234 Important/Sec. openssl-3.0.7-27.el9.x86_64". Fedora and
    /// Rocky write the same columns; a plain "bugfix" or "enhancement" has no severity.
    /// </summary>
    public static List<Advisory> ParseUpdateInfo(string text)
    {
        var list = new List<Advisory>();
        foreach (var raw in (text ?? "").Replace("\r", "").Split('\n'))
        {
            var parts = raw.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 3) continue;
            var nevra = parts[^1];
            var m = Regex.Match(nevra, @"^(?<name>.+)-[^-]+-[^-]+\.(?<arch>[A-Za-z0-9_]+)\.rpm$|^(?<name>.+)-[^-]+-[^-]+\.(?<arch>[A-Za-z0-9_]+)$");
            if (!m.Success) continue;

            var type = parts[^2];
            string kind; string? sev = null;
            var slash = type.IndexOf('/');
            if (slash > 0) { sev = type[..slash]; kind = type[(slash + 1)..]; }
            else kind = type;
            kind = kind.TrimEnd('.').ToLowerInvariant();
            if (kind is "sec") kind = "security";
            if (sev is not null && sev.Equals("None", StringComparison.OrdinalIgnoreCase)) sev = null;
            list.Add(new Advisory(parts[0], kind, sev is null ? null : char.ToUpperInvariant(sev[0]) + sev[1..].ToLowerInvariant(), m.Groups["name"].Value, m.Groups["arch"].Value));
        }
        return list;
    }

    /// <summary>"rpm -qa --qf '%{NAME}.%{ARCH} %{EVR}\n'": the installed version of each package (the newest, for kernels).</summary>
    public static Dictionary<string, string> ParseInstalled(string text)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in (text ?? "").Replace("\r", "").Split('\n'))
        {
            var sp = raw.IndexOf(' ');
            if (sp <= 0) continue;
            map[raw[..sp]] = raw[(sp + 1)..].Trim();
        }
        return map;
    }

    public sealed record ZypperPatch(string Name, string Category, string? Severity, bool Restart, bool Interactive, bool PackageManager, string Summary, string? Edition);

    /// <summary>Reads "zypper --xmlout list-patches": one update element per patch that applies to this machine.</summary>
    public static List<ZypperPatch> ParseZypperPatches(string xml)
    {
        var list = new List<ZypperPatch>();
        var start = xml?.IndexOf("<?xml", StringComparison.Ordinal) ?? -1;
        if (start < 0) return list;
        XDocument doc;
        try { doc = XDocument.Parse(xml![start..]); }
        catch (System.Xml.XmlException) { return list; }

        foreach (var u in doc.Descendants("update"))
        {
            var kind = (string?)u.Attribute("kind");
            if (kind is not null && kind != "patch") continue;
            var name = (string?)u.Attribute("name");
            if (string.IsNullOrWhiteSpace(name)) continue;
            var status = (string?)u.Attribute("status");
            if (status is not null && status != "needed") continue;
            bool Flag(string a) => string.Equals((string?)u.Attribute(a), "true", StringComparison.OrdinalIgnoreCase);
            var sev = (string?)u.Attribute("severity");
            list.Add(new ZypperPatch(name, ((string?)u.Attribute("category") ?? "").ToLowerInvariant(),
                string.IsNullOrWhiteSpace(sev) || sev == "unspecified" ? null : char.ToUpperInvariant(sev[0]) + sev[1..].ToLowerInvariant(),
                Flag("restart") || Flag("reboot"), Flag("interactive"), Flag("pkgmanager"),
                (u.Element("summary")?.Value ?? "").Trim(), (string?)u.Attribute("edition")));
        }
        return list;
    }

    /// <summary>Package names and patch names go onto a command line, so they must be plain names and never options.</summary>
    public static bool IsSafeId(string? id) =>
        !string.IsNullOrEmpty(id) && id.Length <= 200 && Regex.IsMatch(id, @"^[A-Za-z0-9][A-Za-z0-9_.+:~\-]*$");

    /// <summary>Keeps the end of long output, where errors are, and says that it did.</summary>
    public static string Truncate(string? text, int max = 12_000)
    {
        text ??= "";
        if (text.Length <= max) return text;
        var head = max / 4;
        return text[..head] + "\n...[output shortened]...\n" + text[^(max - head)..];
    }
}

// ─── Engine ─────────────────────────────────────────────────────────────────

public sealed class LinuxPatchEngine
{
    private readonly ILinuxPatchHost _host;
    private readonly StringBuilder _log = new();

    /// <summary>How long a command waits for another package tool to let go of the lock before giving up.</summary>
    public TimeSpan LockWait { get; set; } = TimeSpan.FromMinutes(10);
    public TimeSpan LockRetryEvery { get; set; } = TimeSpan.FromSeconds(15);
    public TimeSpan RefreshTimeout { get; set; } = TimeSpan.FromMinutes(10);
    public TimeSpan QueryTimeout { get; set; } = TimeSpan.FromMinutes(5);
    public TimeSpan InstallTimeout { get; set; } = TimeSpan.FromMinutes(90);

    public LinuxPatchEngine(ILinuxPatchHost host) => _host = host;

    // Each command's own words, for the log, never mixed with the log of another task.
    public string Log => _log.ToString();

    // ─── Detection ──────────────────────────────────────────────────────────

    /// <summary>The package manager to use, or a plain reason there is none.</summary>
    public static LinuxPackageManager Detect(ILinuxPatchHost host, out string refusal)
    {
        refusal = "";
        var osRelease = host.ReadText("/etc/os-release") ?? "";
        var id = Regex.Match(osRelease, @"^ID=(?<v>.+)$", RegexOptions.Multiline).Groups["v"].Value.Trim().Trim('"', '\'').ToLowerInvariant();

        if (host.HasCommand("apt-get") && host.HasCommand("dpkg")) return LinuxPackageManager.Apt;
        if (host.HasCommand("dnf")) return LinuxPackageManager.Dnf;
        if (host.HasCommand("yum")) return LinuxPackageManager.Yum;
        if (host.HasCommand("zypper"))
        {
            if (id.Contains("tumbleweed") || id.Contains("slowroll"))
            {
                refusal = "openSUSE Tumbleweed is a rolling release updated with \"zypper dup\", which ADG RMM does not run for you. Patching supports Leap and SUSE Linux Enterprise.";
                return LinuxPackageManager.None;
            }
            return LinuxPackageManager.Zypper;
        }

        var other = new[] { "apk", "pacman", "emerge", "xbps-install", "nix-env", "swupd", "rpm-ostree" }.FirstOrDefault(host.HasCommand);
        var distro = string.IsNullOrEmpty(id) ? "this Linux distribution" : id;
        refusal = other is null
            ? $"No supported package manager was found on {distro}. Patching supports apt, dnf, yum and zypper."
            : $"Patching is not supported on {distro}: it uses {other}. Patching supports apt, dnf, yum and zypper.";
        return LinuxPackageManager.None;
    }

    // ─── Running commands ───────────────────────────────────────────────────

    private static readonly string[] LockMarkers =
    {
        "Could not get lock", "Unable to acquire the dpkg frontend lock", "Unable to lock directory", "dpkg frontend lock",
        "is another process using it", "Resource temporarily unavailable",
        "Another app is currently holding the yum lock", "Existing lock /var/run/yum.pid", "waiting for lock",
        "System management is locked by the application", "Could not open the rpm database lock", "cannot get lock",
    };

    private static bool LooksLocked(PatchProcResult r) =>
        r.ExitCode != 0 && !r.TimedOut && LockMarkers.Any(m => r.Stdout.Contains(m, StringComparison.OrdinalIgnoreCase) || r.Stderr.Contains(m, StringComparison.OrdinalIgnoreCase));

    private async Task<PatchProcResult> Exec(string file, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct, bool retryOnLock = true, string? note = null)
    {
        var waited = TimeSpan.Zero;
        while (true)
        {
            var r = await _host.RunAsync(file, args, timeout, ct);
            _log.Append("$ ").Append(file).Append(' ').AppendLine(string.Join(' ', args));
            var body = (r.Stdout + (string.IsNullOrWhiteSpace(r.Stderr) ? "" : "\n" + r.Stderr)).Trim();
            if (body.Length > 0) _log.AppendLine(LinuxPatchParsers.Truncate(body, 6_000));
            _log.AppendLine(r.TimedOut ? "[timed out]" : $"[exit {r.ExitCode}]");

            if (!retryOnLock || !LooksLocked(r)) return r;
            if (waited >= LockWait)
                throw new LinuxPatchException($"Another package tool has held the package lock for more than {(int)LockWait.TotalMinutes} minutes, so this was skipped. It will be tried again later.", Log);
            _log.AppendLine($"[package lock is held by another process; waiting {(int)LockRetryEvery.TotalSeconds}s]");
            await _host.DelayAsync(LockRetryEvery, ct);
            waited += LockRetryEvery;
        }
    }

    // ─── Scan ───────────────────────────────────────────────────────────────

    public async Task<LinuxScanResult> ScanAsync(bool includeOptional, CancellationToken ct)
    {
        var manager = Detect(_host, out var refusal);
        if (manager == LinuxPackageManager.None) throw new LinuxPatchException(refusal);

        var result = manager switch
        {
            LinuxPackageManager.Apt => await ScanApt(ct),
            LinuxPackageManager.Dnf or LinuxPackageManager.Yum => await ScanRpm(manager, ct),
            _ => await ScanZypper(includeOptional, ct),
        };
        result.Manager = manager;
        await DetectReboot(manager, result, ct);
        result.Log = Log;
        return result;
    }

    private static readonly string[] AptCommon = { "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "-o", "APT::Color=0" };

    private async Task<LinuxScanResult> ScanApt(CancellationToken ct)
    {
        var result = new LinuxScanResult();
        // The package lists are what "available" means, so they are refreshed first. A failing mirror is not fatal: the
        // old lists still say what was true at the last refresh, and the log says the refresh failed.
        var update = await Exec("apt-get", new[] { "update", "-q", "-o", "DPkg::Lock::Timeout=120", "-o", "APT::Color=0" }, RefreshTimeout, ct);
        if (update.ExitCode != 0)
            _log.AppendLine("[the package lists could not be refreshed, so this scan may be out of date]");

        var sim = await Exec("apt-get", new[] { "-s", "-q", "--no-remove", "-o", "Debug::NoLocking=1", "dist-upgrade" }, QueryTimeout, ct, retryOnLock: false);
        if (sim.ExitCode != 0)
            throw new LinuxPatchException("apt could not work out the available updates: " + Brief(sim), Log);

        var parsed = LinuxPatchParsers.ParseAptSimulation(sim.Stdout);
        var held = LinuxPatchParsers.ParseLines((await Exec("apt-mark", new[] { "showhold" }, QueryTimeout, ct, retryOnLock: false)).Stdout);

        foreach (var u in parsed.Upgrades)
        {
            if (held.Contains(u.Name)) continue;
            var sec = LinuxPatchParsers.AptOriginIsSecurity(u.Origins);
            result.Patches.Add(new LinuxPatch
            {
                Id = u.Name, Name = u.Name, Current = u.Current, Available = u.Available, Security = sec,
                Severity = sec ? "Important" : null, Source = u.Origins,
                Title = $"{u.Name} {u.Current} to {u.Available}",
            });
        }

        // A kernel update arrives as a new package (linux-image-5.15.0-91-generic), not as an upgrade of an installed one.
        foreach (var n in parsed.NewInstalls.Where(n => Regex.IsMatch(n.Name, @"^linux-image-\d")))
        {
            var sec = LinuxPatchParsers.AptOriginIsSecurity(n.Origins);
            result.Patches.Add(new LinuxPatch
            {
                Id = n.Name, Name = n.Name, Current = null, Available = n.Available, Security = sec, Severity = sec ? "Important" : null,
                RequiresReboot = true, Source = n.Origins, Title = $"Kernel {n.Name} {n.Available}",
            });
        }

        foreach (var h in held) result.Skipped.Add(new LinuxPatchSkip(h, "held"));
        foreach (var k in parsed.KeptBack.Where(k => !held.Contains(k))) result.Skipped.Add(new LinuxPatchSkip(k, "kept back (needs packages removed or other changes)"));
        foreach (var p in parsed.Phased) result.Skipped.Add(new LinuxPatchSkip(p, "phased: not released to this machine yet"));
        return result;
    }

    private string[] RpmTool(LinuxPackageManager m) => new[] { m == LinuxPackageManager.Yum ? "yum" : "dnf" };

    private async Task<LinuxScanResult> ScanRpm(LinuxPackageManager manager, CancellationToken ct)
    {
        var tool = RpmTool(manager)[0];
        var result = new LinuxScanResult();
        var refresh = manager == LinuxPackageManager.Dnf ? new[] { "--refresh" } : Array.Empty<string>();

        // Exit code 100 means updates exist, 0 means none, anything else is an error.
        var all = await Exec(tool, new[] { "-q", "check-update" }.Concat(refresh).ToArray(), RefreshTimeout, ct);
        if (all.ExitCode != 0 && all.ExitCode != 100)
            throw new LinuxPatchException($"{tool} could not list the available updates: " + Brief(all), Log);
        var updates = LinuxPatchParsers.ParseCheckUpdate(all.Stdout);

        var securityIds = new HashSet<string>(StringComparer.Ordinal);
        var secArgs = manager == LinuxPackageManager.Dnf ? new[] { "-q", "check-update", "--security" } : new[] { "-q", "--security", "check-update" };
        var sec = await Exec(tool, secArgs, QueryTimeout, ct, retryOnLock: false);
        if (sec.ExitCode is 0 or 100)
            foreach (var u in LinuxPatchParsers.ParseCheckUpdate(sec.Stdout)) securityIds.Add(u.Id);

        var advisories = new Dictionary<string, List<LinuxPatchParsers.Advisory>>(StringComparer.Ordinal);
        if (manager == LinuxPackageManager.Dnf && updates.Count > 0)
        {
            var info = await Exec(tool, new[] { "-q", "updateinfo", "list", "--updates" }, QueryTimeout, ct, retryOnLock: false);
            if (info.ExitCode == 0)
                foreach (var a in LinuxPatchParsers.ParseUpdateInfo(info.Stdout))
                    (advisories.TryGetValue($"{a.Name}.{a.Arch}", out var l) ? l : advisories[$"{a.Name}.{a.Arch}"] = new()).Add(a);
        }

        var installed = new Dictionary<string, string>(StringComparer.Ordinal);
        if (updates.Count > 0 && _host.HasCommand("rpm"))
        {
            var q = await _host.RunAsync("rpm", new[] { "-qa", "--qf", "%{NAME}.%{ARCH} %{EVR}\\n" }, QueryTimeout, ct);
            if (q.ExitCode == 0) installed = LinuxPatchParsers.ParseInstalled(q.Stdout);
        }

        foreach (var u in updates)
        {
            advisories.TryGetValue(u.Id, out var adv);
            var isSecurity = securityIds.Contains(u.Id) || (adv?.Any(a => a.Kind == "security") ?? false);
            string? severity = null;
            if (isSecurity)
            {
                var rated = adv?.Where(a => a.Kind == "security" && a.Severity is not null).Select(a => a.Severity!).ToList() ?? new();
                severity = new[] { "Critical", "Important", "Moderate", "Low" }.FirstOrDefault(s => rated.Contains(s)) ?? "Important";
            }
            installed.TryGetValue(u.Id, out var current);
            var isKernel = Regex.IsMatch(u.Name, @"^kernel(-core|-modules|-default)?$");
            result.Patches.Add(new LinuxPatch
            {
                Id = u.Id, Name = u.Name, Current = current, Available = u.Available, Security = isSecurity, Severity = severity,
                RequiresReboot = isKernel || Regex.IsMatch(u.Name, @"^(glibc|systemd|linux-firmware|dbus(-broker)?)$"),
                Advisories = adv?.Select(a => a.Id).Distinct().ToArray() ?? Array.Empty<string>(),
                Source = u.Repo, Title = $"{u.Name} {(current is null ? "" : current + " to ")}{u.Available}",
            });
        }

        if (_host.HasCommand("rpm"))
        {
            // Versionlock (dnf) and exclude= already keep those packages out of check-update; naming them tells the operator why.
            var locks = manager == LinuxPackageManager.Dnf ? await Exec("dnf", new[] { "-q", "versionlock", "list" }, QueryTimeout, ct, retryOnLock: false) : null;
            if (locks is { ExitCode: 0 })
                foreach (var l in locks.Stdout.Replace("\r", "").Split('\n').Select(x => x.Trim()).Where(x => x.Length > 0 && !x.StartsWith("Last metadata")))
                {
                    var m = Regex.Match(l, @"^(?:\d+:)?(?<name>.+?)-[^-]+-[^-]+\.[A-Za-z0-9_]+(?:\.\*)?$");
                    if (m.Success) result.Skipped.Add(new LinuxPatchSkip(m.Groups["name"].Value, "held (version lock)"));
                }
        }
        return result;
    }

    private async Task<LinuxScanResult> ScanZypper(bool includeOptional, CancellationToken ct)
    {
        var result = new LinuxScanResult();
        var env = new[] { "--non-interactive", "--xmlout" };
        var refresh = await Exec("zypper", env.Concat(new[] { "refresh" }).ToArray(), RefreshTimeout, ct);
        if (refresh.ExitCode != 0)
            _log.AppendLine("[the repositories could not all be refreshed, so this scan may be out of date]");

        var args = env.Concat(new[] { "list-patches" }).ToList();
        if (includeOptional) args.Add("--with-optional");
        var list = await Exec("zypper", args, QueryTimeout, ct);
        if (list.ExitCode != 0 && list.ExitCode != 100 && list.ExitCode != 106)
            throw new LinuxPatchException("zypper could not list the available patches: " + Brief(list), Log);

        foreach (var p in LinuxPatchParsers.ParseZypperPatches(list.Stdout))
        {
            if (p.Interactive)
            {
                result.Skipped.Add(new LinuxPatchSkip(p.Name, "needs a person to accept a licence or choose, so it cannot be installed unattended"));
                continue;
            }
            var security = p.Category == "security";
            result.Patches.Add(new LinuxPatch
            {
                Id = p.Name, Name = p.Name, Available = p.Edition, Security = security,
                Severity = p.Severity ?? (security ? "Important" : null),
                RequiresReboot = p.Restart, Title = string.IsNullOrWhiteSpace(p.Summary) ? p.Name : p.Summary,
                Source = p.Category.Length > 0 ? p.Category : null,
            });
        }
        return result;
    }

    // ─── Restart needed ─────────────────────────────────────────────────────

    private async Task DetectReboot(LinuxPackageManager manager, LinuxScanResult result, CancellationToken ct)
    {
        var (needed, reason) = await RebootNeeded(manager, ct);
        result.RebootRequired = needed;
        result.RebootReason = reason;
    }

    public async Task<(bool Needed, string? Reason)> RebootNeeded(LinuxPackageManager manager, CancellationToken ct)
    {
        switch (manager)
        {
            case LinuxPackageManager.Apt:
                {
                    if (!_host.FileExists("/var/run/reboot-required") && !_host.FileExists("/run/reboot-required")) return (false, null);
                    var pkgs = (_host.ReadText("/var/run/reboot-required.pkgs") ?? _host.ReadText("/run/reboot-required.pkgs") ?? "")
                        .Replace("\r", "").Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).Distinct().Take(8).ToList();
                    return (true, pkgs.Count > 0 ? "Restart needed for " + string.Join(", ", pkgs) : "Restart needed");
                }
            case LinuxPackageManager.Zypper:
                {
                    if (_host.FileExists("/run/reboot-needed") || _host.FileExists("/var/run/reboot-needed")) return (true, "Restart needed");
                    if (_host.HasCommand("zypper"))
                    {
                        // 102 means a restart is needed; 0 means not. Older zypper has no such command and says so with another code.
                        var r = await _host.RunAsync("zypper", new[] { "--non-interactive", "needs-rebooting" }, QueryTimeout, ct);
                        _log.AppendLine("$ zypper needs-rebooting").AppendLine($"[exit {r.ExitCode}]");
                        if (r.ExitCode == 102) return (true, "Restart needed");
                    }
                    return (false, null);
                }
            default:
                {
                    // needs-restarting -r exits 1 when a restart is needed (dnf-utils, dnf-plugins-core, yum-utils).
                    foreach (var args in new[] { new[] { "needs-restarting", "-r" }, new[] { "dnf", "needs-restarting", "-r" } })
                    {
                        if (!_host.HasCommand(args[0])) continue;
                        var r = await _host.RunAsync(args[0], args.Skip(1).ToArray(), QueryTimeout, ct);
                        _log.AppendLine("$ " + string.Join(' ', args)).AppendLine($"[exit {r.ExitCode}]");
                        // Exit 1 also means "no such command" when the plugin is missing, so it only counts with the tool's own words.
                        if (r.ExitCode == 1 && Regex.IsMatch(r.Stdout, "have been updated since|reboot is required", RegexOptions.IgnoreCase)) return (true, "Restart needed");
                        if (r.ExitCode == 0 && Regex.IsMatch(r.Stdout, "core libraries or services", RegexOptions.IgnoreCase)) return (false, null);
                    }
                    return await KernelNewerThanRunning(ct);
                }
        }
    }

    // Without needs-restarting, a restart is needed when the newest installed kernel is not the one that is running.
    private async Task<(bool, string?)> KernelNewerThanRunning(CancellationToken ct)
    {
        if (!_host.HasCommand("rpm") || !_host.HasCommand("uname")) return (false, null);
        var running = (await _host.RunAsync("uname", new[] { "-r" }, QueryTimeout, ct)).Stdout.Trim();
        var q = await _host.RunAsync("rpm", new[] { "-q", "--qf", "%{INSTALLTIME} %{VERSION}-%{RELEASE}.%{ARCH}\\n", "kernel-core", "kernel" }, QueryTimeout, ct);
        var newest = q.Stdout.Replace("\r", "").Split('\n')
            .Select(l => l.Split(' ', 2)).Where(p => p.Length == 2 && long.TryParse(p[0], out _))
            .OrderByDescending(p => long.Parse(p[0])).Select(p => p[1].Trim()).FirstOrDefault();
        if (running.Length == 0 || newest is null || newest == running) return (false, null);
        return (true, $"A newer kernel ({newest}) is installed than the one running ({running})");
    }

    // ─── Install ────────────────────────────────────────────────────────────

    private static string Brief(PatchProcResult r)
    {
        var text = (r.Stderr.Trim().Length > 0 ? r.Stderr : r.Stdout).Trim();
        var lines = text.Replace("\r", "").Split('\n').Where(l => l.Trim().Length > 0).TakeLast(4);
        var s = string.Join(" ", lines);
        return r.TimedOut ? "it did not finish in time." : s.Length > 0 ? LinuxPatchParsers.Truncate(s, 400) : $"exit code {r.ExitCode}.";
    }

    public async Task<LinuxInstallResult> InstallAsync(LinuxInstallRequest request, CancellationToken ct)
    {
        var mode = (request.Mode ?? "selected").ToLowerInvariant();
        if (mode is not ("selected" or "security" or "all"))
            throw new LinuxPatchException($"Unknown install mode: {request.Mode}");

        var manager = Detect(_host, out var refusal);
        if (manager == LinuxPackageManager.None) throw new LinuxPatchException(refusal);

        var ids = request.Ids.Select(i => i.Trim()).Where(i => i.Length > 0).Distinct(StringComparer.Ordinal).ToList();
        if (mode == "selected")
        {
            if (ids.Count == 0) throw new LinuxPatchException("payload.ids is required");
            var bad = ids.FirstOrDefault(i => !LinuxPatchParsers.IsSafeId(i));
            if (bad is not null) throw new LinuxPatchException($"\"{bad}\" is not a valid package or patch name.");
        }

        // What is on offer now, not what was offered when the task was queued.
        var before = await ScanAsync(request.IncludeOptional, ct);
        var result = new LinuxInstallResult();

        List<LinuxPatch> targets;
        if (mode == "selected")
        {
            var offered = before.Patches.ToDictionary(p => p.Id, StringComparer.Ordinal);
            targets = new();
            foreach (var id in ids)
            {
                if (offered.TryGetValue(id, out var p)) targets.Add(p);
                else
                {
                    var skip = before.Skipped.FirstOrDefault(s => s.Id == id || s.Id == id.Split('.')[0]);
                    result.Skipped.Add(new LinuxPatchSkip(id, skip is not null ? skip.Reason : "no update is offered for it now"));
                }
            }
        }
        else if (mode == "security") targets = before.Patches.Where(p => p.Security).ToList();
        else targets = before.Patches.ToList();

        if (targets.Count == 0)
        {
            result.Ok = true;
            result.Message = result.Skipped.Count > 0 ? "Nothing to install: " + string.Join("; ", result.Skipped.Select(s => $"{s.Id} ({s.Reason})")) : "Nothing to install: no matching updates.";
            result.RebootRequired = before.RebootRequired;
            result.Skipped.AddRange(before.Skipped.Where(s => mode != "selected"));
            result.Log = Log;
            return result;
        }

        var run = await RunInstall(manager, mode, targets, request.IncludeOptional, ct);

        // The proof an update went in is that it is no longer on offer.
        var after = await ScanAfter(manager, request.IncludeOptional, ct);
        var remaining = new HashSet<string>(after.Patches.Select(p => p.Id), StringComparer.Ordinal);
        foreach (var t in targets)
            (remaining.Contains(t.Id) ? result.Failed : result.Installed).Add(t.Id);

        result.Skipped.AddRange(before.Skipped.Where(s => mode != "selected"));
        result.RebootRequired = after.RebootRequired || run.RebootHint || targets.Any(t => t.RequiresReboot && result.Installed.Contains(t.Id));
        result.Ok = result.Failed.Count == 0 && run.ExitOk;
        result.Message = result.Ok
            ? $"Installed {result.Installed.Count} update(s)." + (result.RebootRequired ? " A restart is needed." : "")
            : $"{result.Installed.Count} installed, {result.Failed.Count} not installed. {run.Problem}".Trim();
        result.Log = Log;
        return result;
    }

    // After an install the package lists are as fresh as they were a minute ago, so the apt and zypper refresh is skipped.
    private async Task<LinuxScanResult> ScanAfter(LinuxPackageManager manager, bool includeOptional, CancellationToken ct)
    {
        LinuxScanResult r;
        switch (manager)
        {
            case LinuxPackageManager.Apt:
                {
                    r = new LinuxScanResult();
                    var sim = await Exec("apt-get", new[] { "-s", "-q", "--no-remove", "-o", "Debug::NoLocking=1", "dist-upgrade" }, QueryTimeout, ct, retryOnLock: false);
                    var parsed = LinuxPatchParsers.ParseAptSimulation(sim.Stdout);
                    foreach (var u in parsed.Upgrades) r.Patches.Add(new LinuxPatch { Id = u.Name, Name = u.Name });
                    foreach (var n in parsed.NewInstalls.Where(n => Regex.IsMatch(n.Name, @"^linux-image-\d"))) r.Patches.Add(new LinuxPatch { Id = n.Name, Name = n.Name });
                    break;
                }
            case LinuxPackageManager.Zypper:
                {
                    r = new LinuxScanResult();
                    var args = new List<string> { "--non-interactive", "--xmlout", "list-patches" };
                    if (includeOptional) args.Add("--with-optional");
                    var list = await Exec("zypper", args, QueryTimeout, ct);
                    foreach (var p in LinuxPatchParsers.ParseZypperPatches(list.Stdout)) r.Patches.Add(new LinuxPatch { Id = p.Name, Name = p.Name });
                    break;
                }
            default:
                {
                    r = new LinuxScanResult();
                    var tool = manager == LinuxPackageManager.Yum ? "yum" : "dnf";
                    var all = await Exec(tool, new[] { "-q", "check-update" }, RefreshTimeout, ct);
                    foreach (var u in LinuxPatchParsers.ParseCheckUpdate(all.Stdout)) r.Patches.Add(new LinuxPatch { Id = u.Id, Name = u.Name });
                    break;
                }
        }
        var (needed, reason) = await RebootNeeded(manager, ct);
        r.RebootRequired = needed;
        r.RebootReason = reason;
        return r;
    }

    private sealed record InstallRun(bool ExitOk, bool RebootHint, string Problem);

    private async Task<InstallRun> RunInstall(LinuxPackageManager manager, string mode, List<LinuxPatch> targets, bool includeOptional, CancellationToken ct)
    {
        string file;
        List<string> args;
        var names = targets.Select(t => t.Id).ToList();

        switch (manager)
        {
            case LinuxPackageManager.Apt:
                {
                    file = "apt-get";
                    // Held packages stay held: an explicit install of a held name would otherwise override the hold.
                    var held = LinuxPatchParsers.ParseLines((await Exec("apt-mark", new[] { "showhold" }, QueryTimeout, ct, retryOnLock: false)).Stdout);
                    names = names.Where(n => !held.Contains(n)).ToList();
                    if (names.Count == 0) return new InstallRun(true, false, "");
                    args = new List<string> { "-y", "-q", "--no-remove", "-o", "DPkg::Lock::Timeout=300" };
                    args.AddRange(AptCommon);
                    if (mode == "all") args.Add("dist-upgrade");
                    else { args.Add("install"); args.AddRange(names); }
                    break;
                }
            case LinuxPackageManager.Zypper:
                {
                    file = "zypper";
                    args = new List<string> { "--non-interactive", "patch" };
                    if (mode == "security") args.AddRange(new[] { "--category", "security" });
                    else if (mode == "selected") args = new List<string> { "--non-interactive", "install", "-t", "patch" }.Concat(names).ToList();
                    else if (includeOptional) args.Add("--with-optional");
                    break;
                }
            default:
                {
                    file = manager == LinuxPackageManager.Yum ? "yum" : "dnf";
                    args = new List<string> { "-y", "upgrade" };
                    if (mode == "security") args.Add("--security");
                    else if (mode == "selected") args.AddRange(names);
                    break;
                }
        }

        var r = await Exec(file, args, InstallTimeout, ct);
        if (manager == LinuxPackageManager.Zypper && r.ExitCode == 103)
        {
            // zypper updated itself first and asks to be run again.
            r = await Exec(file, args, InstallTimeout, ct);
        }

        // zypper uses 100-106 for "information", of which 102 is "restart needed".
        var okCode = r.ExitCode == 0 || (manager == LinuxPackageManager.Zypper && r.ExitCode is 100 or 101 or 102 or 103 or 104 or 106);
        var hint = manager == LinuxPackageManager.Zypper && r.ExitCode == 102;
        return new InstallRun(okCode && !r.TimedOut, hint, r.TimedOut ? "The install did not finish in time." : okCode ? "" : Brief(r));
    }
}
