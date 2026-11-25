using System.Text;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace RemoteIQ.Agent.Shared;

/// <summary>One program with a newer version available, as reported to the server.</summary>
public sealed class OutdatedApp
{
    [JsonPropertyName("source")] public string Source { get; set; } = "winget";
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("installedVersion")] public string? InstalledVersion { get; set; }
    [JsonPropertyName("availableVersion")] public string AvailableVersion { get; set; } = "";
    /// <summary>winget only knows an upper bound for the installed version ("&lt; 1.2.3"), so this may be a false alarm.</summary>
    [JsonPropertyName("approximate")] public bool Approximate { get; set; }
}

/// <summary>Reads the table <c>winget upgrade</c> prints. It never depends on the words winget prints (they are translated): it finds the
/// header by the line of dashes under it and cuts every row at the header's columns, counting wide (East Asian) characters as two columns.</summary>
public static class WingetTable
{
    private static readonly Regex DashLine = new(@"^-{8,}\s*$", RegexOptions.Compiled);
    private static readonly Regex IdShape = new(@"^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$", RegexOptions.Compiled);

    /// <summary>Display width of one character: 2 for the wide East Asian ranges and emoji, 0 for combining marks, otherwise 1.</summary>
    public static int Width(int cp)
    {
        if (cp < 0x300) return 1;
        if (cp is >= 0x300 and <= 0x36F or 0x200B or 0xFE0F) return 0;
        if (cp is >= 0x1100 and <= 0x115F or >= 0x2E80 and <= 0xA4CF or >= 0xAC00 and <= 0xD7A3 or >= 0xF900 and <= 0xFAFF
            or >= 0xFE30 and <= 0xFE6F or >= 0xFF00 and <= 0xFF60 or >= 0xFFE0 and <= 0xFFE6 or >= 0x1F300 and <= 0x1FAFF or >= 0x20000 and <= 0x3FFFD) return 2;
        return 1;
    }

    /// <summary>Cuts a line at display columns <paramref name="starts"/> (the first is 0). A character belongs to the column where it begins.</summary>
    public static string[] Slice(string line, IReadOnlyList<int> starts)
    {
        var cells = new StringBuilder[starts.Count];
        for (var i = 0; i < cells.Length; i++) cells[i] = new StringBuilder();
        var col = 0;
        foreach (var rune in line.EnumerateRunes())
        {
            var idx = 0;
            for (var i = starts.Count - 1; i >= 0; i--) if (col >= starts[i]) { idx = i; break; }
            cells[idx].Append(rune.ToString());
            col += Width(rune.Value);
        }
        return cells.Select(c => c.ToString().Trim()).ToArray();
    }

    /// <summary>Display column where each header word begins. Words are separated by two or more spaces (a single space is part of a translated title).</summary>
    private static List<int> HeaderStarts(string header, out List<string> titles)
    {
        var starts = new List<int>();
        titles = new List<string>();
        var col = 0;
        var wordStart = -1;
        var spaces = 0;
        var sb = new StringBuilder();
        foreach (var rune in header.EnumerateRunes())
        {
            var w = Width(rune.Value);
            if (rune.Value == ' ')
            {
                spaces++;
                if (wordStart >= 0 && spaces >= 2) { starts.Add(wordStart); titles.Add(sb.ToString().TrimEnd()); wordStart = -1; sb.Clear(); }
                else if (wordStart >= 0) sb.Append(' ');
            }
            else
            {
                spaces = 0;
                if (wordStart < 0) wordStart = col;
                sb.Append(rune.ToString());
            }
            col += w;
        }
        if (wordStart >= 0) { starts.Add(wordStart); titles.Add(sb.ToString().TrimEnd()); }
        return starts;
    }

    /// <summary>Lines with the progress spinner and carriage returns winget writes to a redirected output removed.</summary>
    public static IEnumerable<string> CleanLines(string text)
    {
        foreach (var raw in (text ?? "").Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            var cr = line.LastIndexOf('\r');
            if (cr >= 0) line = line[(cr + 1)..];
            yield return line.TrimEnd();
        }
    }

    public static bool LooksUnknown(string? version) =>
        string.IsNullOrWhiteSpace(version) || !version.Any(char.IsAsciiDigit);

    /// <summary>
    /// Every upgradable program in the output. Several tables are fine (winget prints a second one for packages that need explicit
    /// targeting). A table with 4 columns is Name, Id, Version, Available; a fifth is the Source. Rows without a valid id or an
    /// available version (the footer lines) are dropped, as are programs whose installed version cannot be read at all.
    /// </summary>
    public static List<OutdatedApp> Parse(string? text, string defaultSource = "winget")
    {
        var result = new List<OutdatedApp>();
        var lines = CleanLines(text ?? "").ToList();
        for (var i = 0; i + 1 < lines.Count; i++)
        {
            if (!DashLine.IsMatch(lines[i + 1]) || string.IsNullOrWhiteSpace(lines[i])) continue;
            var starts = HeaderStarts(lines[i], out _);
            if (starts.Count is < 4 or > 5) continue;
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (var j = i + 2; j < lines.Count; j++)
            {
                var line = lines[j];
                if (string.IsNullOrWhiteSpace(line)) break;
                if (DashLine.IsMatch(line)) break;
                var c = Slice(line, starts);
                var id = c[1];
                var installed = c[2];
                var available = c[3];
                if (!IdShape.IsMatch(id) || available.Length == 0 || available.Length > 100 || available.Contains("  ")) continue;
                if (c[0].Length == 0) continue;
                var source = starts.Count == 5 && c[4].Length > 0 ? c[4].ToLowerInvariant() : defaultSource;
                if (!seen.Add(source + "\u0001" + id)) continue;
                var unknown = LooksUnknown(installed);
                if (unknown) continue; // not shown by default; if a localized "Unknown" slips through it must not be updated blindly
                result.Add(new OutdatedApp
                {
                    Source = source,
                    Id = id,
                    Name = c[0].Length > 200 ? c[0][..200] : c[0],
                    InstalledVersion = installed,
                    AvailableVersion = available,
                    Approximate = installed.StartsWith('<') || installed.StartsWith('>'),
                });
            }
            // the loop above stops at a blank line; the next table, if any, starts after it
        }
        return result;
    }
}

/// <summary>Reads <c>choco outdated -r</c>: one <c>name|installed|available|pinned</c> line per package.</summary>
public static class ChocoOutdated
{
    private static readonly Regex Line = new(@"^(?<id>[A-Za-z0-9][A-Za-z0-9._-]{0,99})\|(?<cur>[^|]{1,100})\|(?<avail>[^|]{1,100})\|(?<pin>true|false)\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static List<OutdatedApp> Parse(string? text)
    {
        var result = new List<OutdatedApp>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var raw in (text ?? "").Split('\n'))
        {
            var m = Line.Match(raw.Trim());
            if (!m.Success) continue;
            if (m.Groups["pin"].Value.Equals("true", StringComparison.OrdinalIgnoreCase)) continue; // pinned: someone chose to hold it back
            var id = m.Groups["id"].Value;
            if (!seen.Add(id)) continue;
            result.Add(new OutdatedApp { Source = "chocolatey", Id = id, Name = id, InstalledVersion = m.Groups["cur"].Value.Trim(), AvailableVersion = m.Groups["avail"].Value.Trim() });
        }
        return result;
    }
}

/// <summary>A software_updates_scan task, checked before anything runs.</summary>
public sealed class UpdatesScanRequest
{
    public bool Winget { get; private set; } = true;
    public bool Chocolatey { get; private set; } = true;

    public static bool TryParse(Func<string, string?> read, out UpdatesScanRequest request, out string error)
    {
        request = new UpdatesScanRequest();
        error = "";
        var sources = read("sources");
        if (!string.IsNullOrWhiteSpace(sources))
        {
            var set = sources.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Select(s => s.ToLowerInvariant()).ToHashSet();
            if (set.Count == 0 || set.Any(s => s is not ("winget" or "chocolatey"))) { error = "sources may only name winget and chocolatey."; return false; }
            request.Winget = set.Contains("winget");
            request.Chocolatey = set.Contains("chocolatey");
        }
        return true;
    }
}

public sealed record SourceScan(string State, string? Message);

public sealed record UpdatesScanResult(bool Ok, IReadOnlyList<OutdatedApp> Apps, SourceScan Winget, SourceScan Chocolatey, string Message);

/// <summary>An installed program as the registry inventory sees it.</summary>
public sealed record InstalledProgram(string Name, string? Version);

/// <summary>The machine as the updater sees it. Tests replace it, so nothing runs a process.</summary>
public interface ISoftwareUpgradeHost : ISoftwareInstallHost
{
    /// <summary>The real winget.exe a service can run (the app-execution alias only works inside a user session), or null when there is none.</summary>
    string? ResolveWingetPath();
    Task<IReadOnlyList<InstalledProgram>> ListInstalledAsync(CancellationToken ct);
}

public static class SoftwareUpdates
{
    public static readonly TimeSpan ScanLimit = TimeSpan.FromMinutes(5);
    public const int WingetInvalidArguments = -1978335230;   // 0x8A150002
    public const int WingetNoPackage = -1978335212;          // 0x8A150014
    public const int WingetUpdateNotApplicable = -1978335189; // 0x8A15002B
    public const int MaxApps = 2000;

    /// <summary>
    /// The argument sets to try, best first. Old winget versions do not know some switches and answer with "invalid arguments",
    /// so the next, shorter set is tried. The last set works with every version; its table has a Source column that is filtered.
    /// </summary>
    public static IReadOnlyList<string[]> WingetListVariants() => new[]
    {
        new[] { "upgrade", "--source", "winget", "--scope", "machine", "--accept-source-agreements", "--disable-interactivity" },
        new[] { "upgrade", "--source", "winget", "--accept-source-agreements", "--disable-interactivity" },
        new[] { "upgrade", "--source", "winget", "--accept-source-agreements" },
        new[] { "upgrade", "--accept-source-agreements" },
    };

    public static IReadOnlyList<string[]> WingetUpgradeVariants(string id) => new[]
    {
        new[] { "upgrade", "--id", id, "--exact", "--source", "winget", "--scope", "machine", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity" },
        new[] { "upgrade", "--id", id, "--exact", "--source", "winget", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity" },
        new[] { "upgrade", "--id", id, "--exact", "--source", "winget", "--silent", "--accept-package-agreements", "--accept-source-agreements" },
    };

    /// <summary>
    /// Of the folders under Program Files\WindowsApps, the winget (App Installer) package to run: x64 first, then the newest version.
    /// Returns the chosen folder name, or null when none looks like App Installer.
    /// </summary>
    public static string? PickWingetFolder(IEnumerable<string> folderNames)
    {
        var candidates = new List<(string Name, int Rank, int[] Version)>();
        foreach (var name in folderNames)
        {
            var m = Regex.Match(name ?? "", @"^Microsoft\.DesktopAppInstaller_(?<v>\d+(\.\d+){1,3})_(?<arch>[a-z0-9]+)__8wekyb3d8bbwe$", RegexOptions.IgnoreCase);
            if (!m.Success || !AgentVersion.TryParse(m.Groups["v"].Value, out var v)) continue;
            var arch = m.Groups["arch"].Value.ToLowerInvariant();
            var rank = arch == "x64" ? 0 : arch is "arm64" ? 1 : arch == "x86" ? 2 : 3; // "neutral" resource packages have no winget.exe
            if (arch == "neutral") continue;
            candidates.Add((name!, rank, v));
        }
        if (candidates.Count == 0) return null;
        return candidates.OrderBy(c => c.Rank).ThenByDescending(c => c.Version[0]).ThenByDescending(c => c.Version.Length > 1 ? c.Version[1] : 0)
            .ThenByDescending(c => c.Version.Length > 2 ? c.Version[2] : 0).ThenByDescending(c => c.Version.Length > 3 ? c.Version[3] : 0).First().Name;
    }

    public static string[] ChocoOutdatedArgs(bool ignorePinned = true) =>
        ignorePinned ? new[] { "outdated", "-r", "--ignore-pinned", "--no-color" } : new[] { "outdated", "-r", "--no-color" };

    public static string[] ChocoUpgradeArgs(string id) => new[] { "upgrade", id, "-y", "--no-progress", "--limit-output" };

    private static string FirstLines(ProcessOutcome o, int n = 2)
    {
        var lines = WingetTable.CleanLines(o.Stdout + "\n" + o.Stderr).Where(l => !string.IsNullOrWhiteSpace(l) && l.Any(char.IsLetterOrDigit)).Take(n);
        var s = string.Join(" ", lines);
        return s.Length > 300 ? s[..300] : s;
    }

    /// <summary>One run of winget's list (or upgrade) trying shorter argument sets while winget says the arguments are not understood.</summary>
    private static async Task<ProcessOutcome> RunVariants(ISoftwareUpgradeHost host, string exe, IReadOnlyList<string[]> variants, TimeSpan limit, CancellationToken ct)
    {
        ProcessOutcome last = new(null, "", "", false);
        foreach (var args in variants)
        {
            last = await host.RunAsync(exe, args, limit, ct);
            if (last.TimedOut || last.ExitCode != WingetInvalidArguments) return last;
        }
        return last;
    }

    /// <summary>The outdated programs winget knows of, or why it could not tell.</summary>
    public static async Task<(SourceScan State, List<OutdatedApp> Apps)> ScanWingetAsync(ISoftwareUpgradeHost host, CancellationToken ct)
    {
        var exe = host.ResolveWingetPath();
        if (exe is null) return (new SourceScan("missing", "winget is not available on this PC (for the system account)."), new());
        ProcessOutcome o;
        try { o = await RunVariants(host, exe, WingetListVariants(), ScanLimit, ct); }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { return (new SourceScan("failed", "winget could not be started: " + ex.Message), new()); }
        if (o.NotFound) return (new SourceScan("missing", "winget is not available on this PC."), new());
        if (o.TimedOut) return (new SourceScan("timeout", $"winget did not answer within {(int)ScanLimit.TotalMinutes} minutes and was stopped."), new());
        var apps = WingetTable.Parse(o.Stdout, "winget");
        // The last argument set lists every source: keep what winget itself serves. The Store ("msstore") has no machine-wide updates.
        apps = apps.Where(a => a.Source == "winget").ToList();
        if (o.ExitCode is 0 or WingetNoPackage || apps.Count > 0) return (new SourceScan("ok", null), apps);
        return (new SourceScan("failed", $"winget upgrade failed (exit code {o.ExitCode}). {FirstLines(o)}".Trim()), new());
    }

    /// <summary>Chocolatey's outdated list; it is never installed just to look.</summary>
    public static async Task<(SourceScan State, List<OutdatedApp> Apps)> ScanChocolateyAsync(ISoftwareUpgradeHost host, CancellationToken ct)
    {
        if (!host.FileExists(host.ChocolateyExe)) return (new SourceScan("missing", "Chocolatey is not installed on this PC."), new());
        ProcessOutcome o;
        try
        {
            o = await host.RunAsync(host.ChocolateyExe, ChocoOutdatedArgs(true), ScanLimit, ct);
            if (!o.TimedOut && o.ExitCode is not (0 or 2) && ChocoOutdated.Parse(o.Stdout).Count == 0)
                o = await host.RunAsync(host.ChocolateyExe, ChocoOutdatedArgs(false), ScanLimit, ct); // an old choco without --ignore-pinned
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { return (new SourceScan("failed", "Chocolatey could not be started: " + ex.Message), new()); }
        if (o.TimedOut) return (new SourceScan("timeout", $"Chocolatey did not answer within {(int)ScanLimit.TotalMinutes} minutes and was stopped."), new());
        var apps = ChocoOutdated.Parse(o.Stdout);
        if (o.ExitCode is 0 or 2 || apps.Count > 0) return (new SourceScan("ok", null), apps);
        return (new SourceScan("failed", $"choco outdated failed (exit code {o.ExitCode}). {FirstLines(o)}".Trim()), new());
    }

    public static async Task<UpdatesScanResult> ScanAsync(UpdatesScanRequest req, ISoftwareUpgradeHost host, CancellationToken ct)
    {
        var skipped = new SourceScan("skipped", null);
        var (w, wApps) = req.Winget ? await ScanWingetAsync(host, ct) : (skipped, new List<OutdatedApp>());
        var (c, cApps) = req.Chocolatey ? await ScanChocolateyAsync(host, ct) : (skipped, new List<OutdatedApp>());
        var apps = wApps.Concat(cApps).Take(MaxApps).ToList();
        // A scan is a success when at least one source answered; when none did, the reason is the message.
        var answered = w.State == "ok" || c.State == "ok";
        var parts = new List<string>();
        if (w.State is not ("ok" or "skipped")) parts.Add("winget: " + w.Message);
        if (c.State is not ("ok" or "skipped")) parts.Add("Chocolatey: " + c.Message);
        string message;
        if (answered)
            message = $"{apps.Count} outdated program(s)." + (parts.Count > 0 ? " " + string.Join(" ", parts) : "");
        else if (w.State == "missing" && c.State is "missing" or "skipped")
            message = "Neither winget nor Chocolatey is available on this PC, so outdated programs cannot be listed.";
        else
            message = string.Join(" ", parts);
        return new UpdatesScanResult(answered, apps, w, c, message);
    }
}

/// <summary>An upgrade (a software_install task with action "upgrade"): winget upgrade by id or choco upgrade, then checked against the same source.</summary>
public static class SoftwareUpgrade
{
    /// <summary>Is <paramref name="id"/> still in the list of outdated programs? Null when the list could not be read.</summary>
    public static async Task<bool?> StillOutdatedAsync(SoftwareInstallRequest req, ISoftwareUpgradeHost host, CancellationToken ct)
    {
        try
        {
            if (req.Method == "winget")
            {
                var (state, apps) = await SoftwareUpdates.ScanWingetAsync(host, ct);
                return state.State == "ok" ? apps.Any(a => string.Equals(a.Id, req.WingetId, StringComparison.OrdinalIgnoreCase)) : null;
            }
            var (cs, capps) = await SoftwareUpdates.ScanChocolateyAsync(host, ct);
            return cs.State == "ok" ? capps.Any(a => string.Equals(a.Id, req.ChocolateyId, StringComparison.OrdinalIgnoreCase)) : null;
        }
        catch (OperationCanceledException) { throw; }
        catch { return null; }
    }

    /// <summary>The installed version of the program after the upgrade, from the registry inventory (best effort).</summary>
    public static async Task<string?> InstalledVersionAsync(SoftwareInstallRequest req, ISoftwareUpgradeHost host, CancellationToken ct)
    {
        try
        {
            var list = await host.ListInstalledAsync(ct);
            return list.Where(p => SoftwareInstall.NameMatches(p.Name, req.MatchText) && !string.IsNullOrWhiteSpace(p.Version)).Select(p => p.Version).FirstOrDefault();
        }
        catch (OperationCanceledException) { throw; }
        catch { return null; }
    }

    public static async Task<SoftwareInstallResult> RunAsync(SoftwareInstallRequest req, ISoftwareUpgradeHost host, CancellationToken ct)
    {
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        SoftwareInstallResult Done(bool ok, int? code, string message, bool verified = false) =>
            new(ok, req.Method, "upgrade", code, message, SoftwareInstall.Truncate(stdout.ToString()), SoftwareInstall.Truncate(stderr.ToString()), verified);
        var via = req.Method == "winget" ? "winget" : "Chocolatey";
        try
        {
            ProcessOutcome o;
            if (req.Method == "winget")
            {
                var exe = host.ResolveWingetPath();
                if (exe is null) return Done(false, null, "winget is not available on this PC (for the system account).");
                o = await RunUpgrade(host, exe, SoftwareUpdates.WingetUpgradeVariants(req.WingetId!), ct);
                if (o.NotFound) return Done(false, null, "winget is not available on this PC.");
            }
            else
            {
                if (!host.FileExists(host.ChocolateyExe)) return Done(false, null, "Chocolatey is not installed on this PC.");
                o = await host.RunAsync(host.ChocolateyExe, SoftwareUpdates.ChocoUpgradeArgs(req.ChocolateyId!), SoftwareInstall.Limit, ct);
            }
            stdout.Append(o.Stdout); stderr.Append(o.Stderr);

            if (o.TimedOut) return Done(false, null, $"The update of {req.Name} did not finish within {(int)SoftwareInstall.Limit.TotalMinutes} minutes and was stopped.");
            if (o.ExitCode is not int code) return Done(false, null, $"The update of {req.Name} did not return an exit code.");
            var ok = SoftwareInstall.IsSuccess(code, out var reboot);
            // winget says "no applicable update" when something else already updated it. Look, rather than guess.
            var already = req.Method == "winget" && code is SoftwareUpdates.WingetUpdateNotApplicable or SoftwareUpdates.WingetNoPackage;
            if (!ok && !already) return Done(false, code, $"The update of {req.Name} failed (exit code {code}).");

            var still = await StillOutdatedAsync(req, host, ct);
            var now = await InstalledVersionAsync(req, host, ct);
            var restart = reboot ? " A restart is needed to finish." : "";
            var nowText = now is null ? "" : $" It now shows version {now}.";
            if (still == false)
                return Done(true, code, (already ? $"{req.Name} was already up to date." : $"Updated {req.Name}{(req.ToVersion is null ? "" : " to " + req.ToVersion)} and confirmed {via} no longer lists it as outdated.") + nowText + restart, true);
            if (still is null)
                return Done(false, code, $"{via} said the update finished, but the list of outdated programs could not be read, so the update of {req.Name} could not be confirmed.{nowText}");
            return Done(false, code, $"{via} said the update finished, but {req.Name} is still listed as outdated" + (now is null ? "." : $" (installed version {now})."));
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return Done(false, null, "The update was cancelled.");
        }
        catch (Exception ex)
        {
            stderr.AppendLine(ex.Message);
            return Done(false, null, $"The update of {req.Name} failed: {ex.Message}");
        }
    }

    private static async Task<ProcessOutcome> RunUpgrade(ISoftwareUpgradeHost host, string exe, IReadOnlyList<string[]> variants, CancellationToken ct)
    {
        ProcessOutcome last = new(null, "", "", false);
        foreach (var args in variants)
        {
            last = await host.RunAsync(exe, args, SoftwareInstall.Limit, ct);
            if (last.TimedOut || last.ExitCode != SoftwareUpdates.WingetInvalidArguments) return last;
        }
        return last;
    }
}
