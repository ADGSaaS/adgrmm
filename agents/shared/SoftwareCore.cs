using System.Text;
using System.Text.RegularExpressions;

namespace AdgRmm.Agent.Shared;

/// <summary>A software_install task, checked strictly before anything runs.</summary>
public sealed class SoftwareInstallRequest
{
    public string Action { get; private set; } = "install";
    public string Name { get; private set; } = "";
    public string MatchText { get; private set; } = "";
    public string? RunAsUser { get; private set; }
    public string? WingetId { get; private set; }
    public string? ChocolateyParams { get; private set; }
    public string? ChocolateyInstallArgs { get; private set; }
    public string Method { get; private set; } = "chocolatey";
    public string? ChocolateyId { get; private set; }
    public Uri? InstallerUrl { get; private set; }
    public string? InstallerSha256 { get; private set; }
    public string InstallerKind { get; private set; } = "exe";
    public IReadOnlyList<string> SilentArgs { get; private set; } = Array.Empty<string>();
    /// <summary>For action "upgrade": the versions the scan saw, kept for the message.</summary>
    public string? FromVersion { get; private set; }
    public string? ToVersion { get; private set; }

    private static readonly Regex ChocoId = new("^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$", RegexOptions.Compiled);
    private static readonly Regex WingetIdRx = new("^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$", RegexOptions.Compiled);
    private static readonly Regex Hex64 = new("^[0-9a-fA-F]{64}$", RegexOptions.Compiled);

    /// <summary>Builds a request from the payload. <paramref name="read"/> returns the named field as text, or null when absent.</summary>
    /// <summary>An upgrade runs for the whole PC (system account) through winget or Chocolatey, by package id.</summary>
    private static bool TryParseUpgrade(Func<string, string?> Get, string? method, out SoftwareInstallRequest request, out string error)
    {
        request = new SoftwareInstallRequest { Action = "upgrade" };
        error = "";
        if (method is not ("winget" or "chocolatey")) { error = "an upgrade must use winget or chocolatey."; return false; }
        if (Get("runAs.user") is not null) { error = "An upgrade runs for the whole PC, not for one user."; return false; }
        var matchText = Get("matchText");
        if (matchText is null || matchText.Length > 200) { error = "matchText is missing or too long."; return false; }
        request.Method = method;
        request.MatchText = matchText;
        var name = Get("name");
        request.Name = name is null ? "the software" : (name.Length > 200 ? name[..200] : name);
        foreach (var key in new[] { "fromVersion", "toVersion" })
        {
            var v = Get(key);
            if (v is null) continue;
            if (v.Length > 100 || v.Any(char.IsControl)) { error = key + " is too long or has control characters."; return false; }
            if (key == "fromVersion") request.FromVersion = v; else request.ToVersion = v;
        }
        if (method == "winget")
        {
            var wid = Get("wingetId");
            if (wid is null || !WingetIdRx.IsMatch(wid)) { error = "wingetId is missing or not a valid winget package id."; return false; }
            request.WingetId = wid;
        }
        else
        {
            var id = Get("chocolateyId");
            if (id is null || !ChocoId.IsMatch(id)) { error = "chocolateyId is missing or not a valid Chocolatey package id."; return false; }
            request.ChocolateyId = id;
        }
        return true;
    }

    public static bool TryParse(Func<string, string?> read, out SoftwareInstallRequest request, out string error)
    {
        request = new SoftwareInstallRequest();
        error = "";
        string? Get(string k) { var v = read(k); return string.IsNullOrWhiteSpace(v) ? null : v.Trim(); }

        var action = Get("action")?.ToLowerInvariant();
        if (action is not ("install" or "uninstall" or "upgrade")) { error = "action must be install, uninstall or upgrade."; return false; }
        var method = Get("method")?.ToLowerInvariant();
        if (method is not ("chocolatey" or "direct" or "winget")) { error = "method must be chocolatey, direct or winget."; return false; }

        if (action == "upgrade") return TryParseUpgrade(Get, method, out request, out error);

        // runAs: install for one signed-in user, in their own session. Chocolatey needs elevation, so it is never used that way.
        var runAs = Get("runAs.user");
        if (runAs is not null)
        {
            if (!SoftwareInventoryCore.TryParseAccount(runAs, out _, out _)) { error = "runAs.user must look like DOMAIN\\name or MACHINE\\name."; return false; }
            if (method == "chocolatey") { error = "Chocolatey cannot install for a specific user. Use winget or a direct installer."; return false; }
            if (action == "uninstall" && method != "winget") { error = "Uninstalling for a specific user only works with winget."; return false; }
        }
        else if (method == "winget") { error = "winget installs need a user (runAs.user)."; return false; }
        request.RunAsUser = runAs;

        var matchText = Get("matchText");
        if (matchText is null || matchText.Length > 200) { error = "matchText is missing or too long."; return false; }
        request.MatchText = matchText;
        request.Action = action;
        request.Method = method;
        var name = Get("name");
        request.Name = name is null ? "the software" : (name.Length > 200 ? name[..200] : name);

        if (method == "winget")
        {
            var wid = Get("wingetId");
            if (wid is null || !WingetIdRx.IsMatch(wid)) { error = "wingetId is missing or not a valid winget package id."; return false; }
            request.WingetId = wid;
            return true;
        }

        if (method == "chocolatey")
        {
            var id = Get("chocolateyId");
            if (id is null || !ChocoId.IsMatch(id)) { error = "chocolateyId is missing or not a valid Chocolatey package id."; return false; }
            request.ChocolateyId = id;
            foreach (var key in new[] { "chocolateyParams", "chocolateyInstallArgs" })
            {
                var v = Get(key);
                if (v is null) continue;
                if (v.Length > 200 || v.Any(char.IsControl)) { error = key + " is longer than 200 characters or has control characters."; return false; }
                if (key == "chocolateyParams") request.ChocolateyParams = v; else request.ChocolateyInstallArgs = v;
            }
            return true;
        }

        if (action == "uninstall") { error = "Uninstalling a directly downloaded program is not supported."; return false; }

        var url = Get("installerUrl");
        if (url is null || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps
            || !string.IsNullOrEmpty(uri.UserInfo) || string.IsNullOrEmpty(uri.Host))
        { error = "installerUrl must be an https address without a user name or password."; return false; }
        request.InstallerUrl = uri;

        var sha = Get("installerSha256");
        if (sha is null || !Hex64.IsMatch(sha)) { error = "installerSha256 must be 64 hexadecimal characters."; return false; }
        request.InstallerSha256 = sha.ToLowerInvariant();

        var kind = Get("installerKind")?.ToLowerInvariant() ?? "exe";
        if (kind is not ("exe" or "msi")) { error = "installerKind must be exe or msi."; return false; }
        request.InstallerKind = kind;

        var args = Get("silentArgs");
        if (args is not null)
        {
            if (args.Length > 500 || args.Any(char.IsControl)) { error = "silentArgs is too long or has control characters."; return false; }
            if (kind == "exe") request.SilentArgs = SoftwareInstall.SplitArgs(args);
        }
        return true;
    }
}

public sealed record ProcessOutcome(int? ExitCode, string Stdout, string Stderr, bool TimedOut, bool NotFound = false);

public sealed record SoftwareInstallResult(bool Ok, string Method, string Action, int? ExitCode, string Message, string Stdout, string Stderr, bool Verified);

/// <summary>Everything the installer does to the machine. Tests replace it so nothing touches the network or runs a process.</summary>
public interface ISoftwareInstallHost
{
    string ChocolateyExe { get; }
    bool FileExists(string path);
    Task<ProcessOutcome> RunAsync(string file, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct);
    Task DownloadAsync(Uri url, string destinationPath, CancellationToken ct);
    Task<string> Sha256Async(string path, CancellationToken ct);
    /// <summary>Display names of installed programs: machine list plus real users own installs (not SYSTEM and service profiles).</summary>
    /// <param name="user">When set, only that user's own programs; otherwise machine programs plus every real user's.</param>
    Task<IReadOnlyList<string>> ListInstalledNamesAsync(string? user, CancellationToken ct);
    /// <summary>True when the account has an Active or Connected session right now.</summary>
    Task<bool> IsUserSignedInAsync(string user, CancellationToken ct);
    /// <summary>Runs a process in the user's session. A file name without a folder is looked for in that user's WindowsApps folder, then their PATH; <c>NotFound</c> is set when it is not there.</summary>
    Task<ProcessOutcome> RunAsUserAsync(string user, string file, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct);
    Task DelayAsync(TimeSpan delay, CancellationToken ct);
    /// <param name="readableBy">An account that must be able to read the folder (the user the installer runs as).</param>
    string CreateTempDir(string? readableBy);
    void DeleteDir(string path);
}

public static class SoftwareInstall
{
    public const int MaxOutputBytes = 8 * 1024;
    public static readonly TimeSpan Limit = TimeSpan.FromMinutes(30);

    public static string[] ChocolateyArgs(string action, string id, string? chocoParams = null, string? installArgs = null)
    {
        var list = new List<string> { action == "uninstall" ? "uninstall" : "install", id };
        if (action != "uninstall")
        {
            if (!string.IsNullOrEmpty(chocoParams)) { list.Add("--params"); list.Add(chocoParams); }
            if (!string.IsNullOrEmpty(installArgs)) { list.Add("--install-arguments"); list.Add(installArgs); }
        }
        list.AddRange(new[] { "-y", "--no-progress", "--limit-output" });
        return list.ToArray();
    }

    public static bool NameMatches(string displayName, string matchText) =>
        !string.IsNullOrWhiteSpace(matchText) && displayName.Contains(matchText.Trim(), StringComparison.OrdinalIgnoreCase);

    public static readonly TimeSpan SettleDelay = TimeSpan.FromSeconds(3);
    public const int VerifyAttempts = 3;

    /// <summary>
    /// After a clean exit: is the program really there (install) or really gone (uninstall)? Looks up to
    /// <see cref="VerifyAttempts"/> times, <see cref="SettleDelay"/> apart, so a slow installer can finish registering.
    /// Returns whether the wanted state was seen, or null when the list could not be read.
    /// </summary>
    public static async Task<bool?> VerifyAsync(SoftwareInstallRequest req, ISoftwareInstallHost host, CancellationToken ct)
    {
        var want = req.Action != "uninstall";
        for (var i = 0; i < VerifyAttempts; i++)
        {
            if (i > 0) await host.DelayAsync(SettleDelay, ct);
            IReadOnlyList<string> names;
            try { names = await host.ListInstalledNamesAsync(req.RunAsUser, ct); }
            catch (OperationCanceledException) { throw; }
            catch { return null; }
            var present = names.Any(n => NameMatches(n, req.MatchText));
            if (present == want) return true;
        }
        return false;
    }

    public static string VerifiedMessage(SoftwareInstallRequest req, bool? seen, bool reboot, string output)
    {
        var install = req.Action != "uninstall";
        var via = req.Method == "chocolatey" ? "Chocolatey" : req.Method == "winget" ? "winget" : "The installer";
        var sys = output.Contains("systemprofile", StringComparison.OrdinalIgnoreCase);
        var restart = reboot ? " A restart is needed to finish." : "";
        if (seen == true)
            return install ? $"Installed {req.Name}{(req.RunAsUser is null ? "" : " for " + req.RunAsUser)} and confirmed it is present.{restart}"
                : req.RunAsUser is not null ? $"Removed {req.Name} for {req.RunAsUser} and confirmed it is gone.{restart}"
                : $"Uninstalled {req.Name} and confirmed it is gone.{restart}";
        if (seen is null)
            return $"{via} said it finished, but the list of installed programs could not be read, so {req.Name} could not be confirmed.";
        if (install && req.RunAsUser is not null)
            return $"{via} said the install finished, but {req.Name} was not found in {req.RunAsUser}'s own programs afterwards.";
        if (install)
            return $"{via} said the install finished, but {req.Name} is not installed for any user on this PC. It may have installed into the system account's own profile (the installer is per user)."
                + (sys ? " The installer output mentions systemprofile, which confirms this." : "")
                + " Try the library entry's Chocolatey arguments, or a machine-wide installer.";
        if (req.RunAsUser is not null)
            return $"{req.Name} is still installed for {req.RunAsUser}.";
        return $"{via} said the uninstall finished, but {req.Name} is still installed." + (sys ? " The installer output mentions systemprofile, so it may belong to the system account's own profile." : "");
    }

    public static string[] BootstrapArgs() => new[]
    {
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        "Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; " +
        "iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))"
    };

    public static string[] WingetArgs(string id, string action = "install") => action == "uninstall"
        ? new[] { "uninstall", "--id", id, "--exact", "--silent", "--accept-source-agreements", "--disable-interactivity" }
        : new[]
        {
            "install", "--id", id, "--exact", "--scope", "user", "--silent",
            "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"
        };

    /// <summary>winget exit code 0x8A150014 ("no installed package found").</summary>
    public const int WingetNoPackageExit = -1978335212;

    public static bool WingetNoPackage(int? exitCode, string output) =>
        exitCode == WingetNoPackageExit || output.Contains("No installed package found matching input criteria", StringComparison.OrdinalIgnoreCase);

    public static bool ChocoNothingToUninstall(string output) =>
        output.Contains("is not installed. Cannot uninstall a non-existent package", StringComparison.OrdinalIgnoreCase);

    /// <summary>Joins arguments into one Windows command line (CommandLineToArgvW rules), for CreateProcessAsUser.</summary>
    public static string QuoteCommandLine(string file, IEnumerable<string> args) =>
        string.Join(" ", new[] { file }.Concat(args).Select(QuoteArg));

    public static string QuoteArg(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        var sb = new StringBuilder("\"");
        var slashes = 0;
        foreach (var c in a)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { sb.Append('\\', slashes * 2 + 1).Append('"'); }
            else { sb.Append('\\', slashes).Append(c); }
            slashes = 0;
        }
        sb.Append('\\', slashes * 2).Append('"');
        return sb.ToString();
    }

    public static string[] MsiArgs(string path) => new[] { "/i", path, "/qn", "/norestart" };

    /// <summary>0 is success; 1641 and 3010 are success with a restart needed.</summary>
    public static bool IsSuccess(int exitCode, out bool rebootNeeded)
    {
        rebootNeeded = exitCode is 1641 or 3010;
        return exitCode is 0 or 1641 or 3010;
    }

    public static string Truncate(string? text, int maxBytes = MaxOutputBytes)
    {
        if (string.IsNullOrEmpty(text)) return "";
        if (Encoding.UTF8.GetByteCount(text) <= maxBytes) return text;
        var sb = new StringBuilder();
        var used = 0;
        foreach (var rune in text.EnumerateRunes())
        {
            var n = rune.Utf8SequenceLength;
            if (used + n > maxBytes) break;
            sb.Append(rune.ToString());
            used += n;
        }
        return sb.Append("\n[output truncated]").ToString();
    }

    public static bool Sha256Matches(string expectedHex, string actualHex) =>
        string.Equals(expectedHex?.Trim(), actualHex?.Trim(), StringComparison.OrdinalIgnoreCase);

    /// <summary>Splits a command line on spaces, keeping "quoted parts" together. No shell is involved.</summary>
    public static string[] SplitArgs(string text)
    {
        var list = new List<string>();
        var sb = new StringBuilder();
        var inQuote = false;
        var has = false;
        foreach (var c in text)
        {
            if (c == '"') { inQuote = !inQuote; has = true; }
            else if (char.IsWhiteSpace(c) && !inQuote) { if (has) { list.Add(sb.ToString()); sb.Clear(); has = false; } }
            else { sb.Append(c); has = true; }
        }
        if (has) list.Add(sb.ToString());
        return list.ToArray();
    }

    /// <summary>A safe file name for the downloaded installer, with the right extension.</summary>
    public static string InstallerFileName(Uri url, string kind)
    {
        var raw = Path.GetFileName(Uri.UnescapeDataString(url.AbsolutePath));
        var clean = new string((raw ?? "").Where(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '_').ToArray()).Trim('.');
        if (clean.Length > 80) clean = clean[^80..];
        var ext = "." + kind;
        if (clean.Length == 0) return "installer" + ext;
        return clean.EndsWith(ext, StringComparison.OrdinalIgnoreCase) ? clean : clean + ext;
    }

    public static async Task<SoftwareInstallResult> RunAsync(SoftwareInstallRequest req, ISoftwareInstallHost host, CancellationToken ct)
    {
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        SoftwareInstallResult Done(bool ok, int? code, string message, bool verified = false) =>
            new(ok, req.Method, req.Action, code, message, Truncate(stdout.ToString()), Truncate(stderr.ToString()), verified);

        // A clean exit is not enough: check the program is (or is no longer) really there.
        async Task<SoftwareInstallResult> Finish(ProcessOutcome o)
        {
            if (o.TimedOut || o.ExitCode is not int c || !IsSuccess(c, out var reboot))
                return Done(false, o.ExitCode, Verdict(o));
            var seen = await VerifyAsync(req, host, ct);
            return Done(seen == true, o.ExitCode, VerifiedMessage(req, seen, reboot, stdout.ToString() + stderr), seen == true);
        }

        ProcessOutcome Note(ProcessOutcome o)
        {
            stdout.Append(o.Stdout); stderr.Append(o.Stderr);
            return o;
        }

        string Verdict(ProcessOutcome o)
        {
            var verb = req.Action == "uninstall" ? "uninstall" : "install";
            if (o.TimedOut) return $"The {verb} of {req.Name} did not finish within {(int)Limit.TotalMinutes} minutes and was stopped.";
            if (o.ExitCode is null) return $"The {verb} of {req.Name} did not return an exit code.";
            if (IsSuccess(o.ExitCode.Value, out var reboot))
                return $"{req.Name} was {(req.Action == "uninstall" ? "uninstalled" : "installed")}." + (reboot ? " A restart is needed to finish." : "");
            return $"The {verb} of {req.Name} failed (exit code {o.ExitCode}).";
        }

        if (req.Action == "upgrade")
            return host is ISoftwareUpgradeHost up ? await SoftwareUpgrade.RunAsync(req, up, ct) : Done(false, null, "This host cannot run updates.");

        try
        {
            if (req.Method == "chocolatey")
            {
                if (!host.FileExists(host.ChocolateyExe))
                {
                    var boot = Note(await host.RunAsync("powershell.exe", BootstrapArgs(), Limit, ct));
                    if (boot.TimedOut || boot.ExitCode != 0 || !host.FileExists(host.ChocolateyExe))
                        return Done(false, boot.ExitCode, "Chocolatey is not installed and could not be set up.");
                }
                var o = Note(await host.RunAsync(host.ChocolateyExe, ChocolateyArgs(req.Action, req.ChocolateyId!, req.ChocolateyParams, req.ChocolateyInstallArgs), Limit, ct));
                if (req.Action == "uninstall" && o.ExitCode is not (0 or 1641 or 3010) && ChocoNothingToUninstall(o.Stdout + o.Stderr))
                    return Done(false, o.ExitCode, $"Chocolatey has no record of {req.Name} on this PC, so it has nothing to uninstall. If it was installed for one user, use Remove for that user.");
                return await Finish(o);
            }

            // For a specific user the installer runs in their session. Stop early when they are not signed in.
            if (req.RunAsUser is not null && !await host.IsUserSignedInAsync(req.RunAsUser, ct))
                return Done(false, null, $"{req.RunAsUser} is not signed in on this PC right now, so the {(req.Action == "uninstall" ? "uninstall" : "install")} cannot run in their session.");

            if (req.Method == "winget")
            {
                var w = Note(await host.RunAsUserAsync(req.RunAsUser!, "winget.exe", WingetArgs(req.WingetId!, req.Action), Limit, ct));
                if (w.NotFound) return Done(false, null, $"winget is not available for {req.RunAsUser} on this PC.");
                if (req.Action == "uninstall" && WingetNoPackage(w.ExitCode, w.Stdout + w.Stderr))
                {
                    // winget found nothing to remove. That is fine only if the user really has no such program.
                    bool gone;
                    try { gone = !(await host.ListInstalledNamesAsync(req.RunAsUser, ct)).Any(n => NameMatches(n, req.MatchText)); }
                    catch (OperationCanceledException) { throw; }
                    catch { gone = false; }
                    return gone
                        ? Done(true, w.ExitCode, $"{req.Name} was not installed for {req.RunAsUser}, nothing to remove.", true)
                        : Done(false, w.ExitCode, $"winget could not find {req.Name} to remove for {req.RunAsUser}, but it still appears in their programs. See the output for details.");
                }
                return await Finish(w);
            }

            var dir = host.CreateTempDir(req.RunAsUser);
            try
            {
                var file = Path.Combine(dir, InstallerFileName(req.InstallerUrl!, req.InstallerKind));
                await host.DownloadAsync(req.InstallerUrl!, file, ct);
                var actual = await host.Sha256Async(file, ct);
                if (!Sha256Matches(req.InstallerSha256!, actual))
                    return Done(false, null, "The downloaded installer does not match the expected SHA-256, so it was not run.");

                var exe = req.InstallerKind == "msi" ? "msiexec.exe" : file;
                var exeArgs = req.InstallerKind == "msi" ? MsiArgs(file) : req.SilentArgs;
                var o = Note(req.RunAsUser is null
                    ? await host.RunAsync(exe, exeArgs, Limit, ct)
                    : await host.RunAsUserAsync(req.RunAsUser, exe, exeArgs, Limit, ct));
                return await Finish(o);
            }
            finally
            {
                try { host.DeleteDir(dir); } catch { /* best effort */ }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return Done(false, null, "The install was cancelled.");
        }
        catch (Exception ex)
        {
            stderr.AppendLine(ex.Message);
            return Done(false, null, $"The {req.Action} of {req.Name} failed: {ex.Message}");
        }
    }
}
