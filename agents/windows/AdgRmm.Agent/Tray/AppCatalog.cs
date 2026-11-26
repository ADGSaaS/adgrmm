// AdgRmm.Agent/Tray/AppCatalog.cs
//
// The programs installed on this computer, newest use first, for the "which program" list of a software ticket. Read by the tray in the signed-in
// person's own session: the uninstall lists (machine and user), what Windows remembers of the programs the person ran (UserAssist, which only
// they can read) and what is running now. Nothing here is sent anywhere except the one program they choose.
using System.Diagnostics;
using Microsoft.Win32;

namespace AdgRmm.Agent.Tray;

internal sealed record InstalledApp(string Name, string? Publisher, string? Version, DateTime? LastUsed)
{
    /// <summary>"used 2 days ago", for the list.</summary>
    public string UsedText
    {
        get
        {
            if (LastUsed is null) return "not used recently";
            var ago = DateTime.Now - LastUsed.Value.ToLocalTime();
            if (ago.TotalMinutes < 5) return "in use now";
            if (ago.TotalHours < 24) return ago.TotalHours < 2 ? "used an hour ago" : $"used {(int)ago.TotalHours} hours ago";
            if (ago.TotalDays < 60) return ago.TotalDays < 2 ? "used yesterday" : $"used {(int)ago.TotalDays} days ago";
            return "not used for months";
        }
    }
}

internal static class AppCatalog
{
    private static readonly (string Guid, Func<string> Path)[] KnownFolders =
    {
        ("{6D809377-6AF0-444B-8957-A3773F02200E}", () => Environment.GetEnvironmentVariable("ProgramW6432") ?? @"C:\Program Files"),
        ("{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}", () => Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? @"C:\Program Files (x86)"),
        ("{905E63B6-C1BF-494E-B29C-65B732D3D21A}", () => Environment.GetEnvironmentVariable("ProgramFiles") ?? @"C:\Program Files"),
        ("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}", () => Environment.SystemDirectory),
        ("{F38BF404-1D43-42F2-9305-67DE0B28FC23}", () => Environment.GetEnvironmentVariable("windir") ?? @"C:\Windows"),
        ("{F1B32785-6FBA-4FCB-9155-3ABBC0B74F9A}", () => Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? ""),
        ("{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}", () => Environment.GetEnvironmentVariable("APPDATA") ?? ""),
    };

    /// <summary>File names too common to say which program was run.</summary>
    private static readonly HashSet<string> GenericStems = new(StringComparer.Ordinal)
    {
        "microsoft", "windows", "explorer", "google", "adobe", "service", "helper", "updater", "update", "install", "installer", "uninstall", "uninstaller", "launcher", "setup",
        "host", "runtime", "client", "agent", "app", "main", "start", "run", "cmd", "powershell", "conhost", "msiexec", "rundll32", "dllhost", "taskhost", "svchost",
    };

    private static string Rot13(string s)
    {
        var c = s.ToCharArray();
        for (var i = 0; i < c.Length; i++)
        {
            var ch = c[i];
            if (ch is >= 'a' and <= 'z') c[i] = (char)((ch - 'a' + 13) % 26 + 'a');
            else if (ch is >= 'A' and <= 'Z') c[i] = (char)((ch - 'A' + 13) % 26 + 'A');
        }
        return new string(c);
    }

    private static string Norm(string? p) => (p ?? "").Trim().Trim('"').Replace('/', '\\').ToLowerInvariant();

    /// <summary>Programs run by this person, by the folder or file they ran from, with the last time (UserAssist).</summary>
    private static Dictionary<string, DateTime> Usage()
    {
        var used = new Dictionary<string, DateTime>();
        void Note(string path, DateTime when)
        {
            var key = Norm(path);
            if (key.Length == 0) return;
            if (!used.TryGetValue(key, out var old) || when > old) used[key] = when;
        }
        try
        {
            using var ua = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist");
            if (ua is not null)
                foreach (var g in ua.GetSubKeyNames())
                {
                    using var count = ua.OpenSubKey(g + @"\Count");
                    if (count is null) continue;
                    foreach (var name in count.GetValueNames())
                    {
                        if (count.GetValue(name) is not byte[] data || data.Length < 68) continue;
                        var ft = BitConverter.ToInt64(data, 60);
                        if (ft <= 0) continue;
                        DateTime when;
                        try { when = DateTime.FromFileTimeUtc(ft); } catch { continue; }
                        var decoded = Rot13(name);
                        foreach (var (guid, path) in KnownFolders)
                            if (decoded.StartsWith(guid, StringComparison.OrdinalIgnoreCase)) { decoded = path() + decoded[guid.Length..]; break; }
                        Note(decoded, when);
                    }
                }
        }
        catch { /* no history: the list is then in name order */ }
        try
        {
            foreach (var p in Process.GetProcesses())
            {
                try { if (!string.IsNullOrEmpty(p.MainWindowTitle) && p.MainModule?.FileName is { } f) Note(f, DateTime.UtcNow); } catch { /* not allowed to look at it */ }
                finally { p.Dispose(); }
            }
        }
        catch { /* ignore */ }
        return used;
    }

    /// <summary>Packaged programs the person can start (Microsoft Store and similar), by the name shown in the Start menu.</summary>
    private static List<(string Name, string? Publisher, string? Version, string Family, string PackageName)> StoreApps()
    {
        var list = new List<(string, string?, string?, string, string)>();
        try
        {
            var pm = new Windows.Management.Deployment.PackageManager();
            foreach (var p in pm.FindPackagesForUser(""))
            {
                try
                {
                    if (p.IsFramework || p.IsResourcePackage || p.IsBundle) continue;
                    var entries = p.GetAppListEntries();
                    if (entries.Count == 0) continue;
                    var name = entries[0].DisplayInfo.DisplayName?.Trim();
                    if (string.IsNullOrEmpty(name) || name.Length > 120) continue;
                    string? pub = null; try { pub = p.PublisherDisplayName; } catch { /* some packages have none */ }
                    var v = p.Id.Version;
                    list.Add((name, string.IsNullOrWhiteSpace(pub) ? null : pub.Trim(), $"{v.Major}.{v.Minor}.{v.Build}", p.Id.FamilyName, p.Id.Name));
                }
                catch { /* one package we cannot read */ }
            }
        }
        catch { /* an older Windows: only the classic list */ }
        return list;
    }

    public static List<InstalledApp> Load()
    {
        var found = new Dictionary<string, (string Name, string? Pub, string? Ver, string Location, string Icon)>(StringComparer.OrdinalIgnoreCase);
        void Read(RegistryKey root, string sub)
        {
            try
            {
                using var key = root.OpenSubKey(sub);
                if (key is null) return;
                foreach (var n in key.GetSubKeyNames())
                {
                    try
                    {
                        using var k = key.OpenSubKey(n);
                        if (k is null) continue;
                        var name = (k.GetValue("DisplayName") as string)?.Trim();
                        if (string.IsNullOrEmpty(name) || name.Length > 120) continue;
                        if (k.GetValue("SystemComponent") is int sc && sc == 1) continue;
                        if (!string.IsNullOrEmpty(k.GetValue("ParentKeyName") as string)) continue;
                        if (k.GetValue("ReleaseType") is string rt && (rt.Contains("Update", StringComparison.OrdinalIgnoreCase) || rt.Contains("Hotfix", StringComparison.OrdinalIgnoreCase))) continue;
                        if (System.Text.RegularExpressions.Regex.IsMatch(name, @"^(KB\d+|Update for |Security Update|Hotfix |Microsoft Visual C\+\+|Microsoft \.NET|Microsoft Windows Desktop Runtime|Microsoft ASP\.NET|Windows Software Development Kit|Windows SDK|Microsoft Edge WebView2|Microsoft Update Health|Microsoft Windows SDK|vs_|Visual Studio Installer|WinRT|Application Verifier)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) continue;
                        var icon = (k.GetValue("DisplayIcon") as string) ?? "";
                        var comma = icon.LastIndexOf(',');
                        if (comma > 2) icon = icon[..comma];
                        found[name] = (name, (k.GetValue("Publisher") as string)?.Trim(), (k.GetValue("DisplayVersion") as string)?.Trim(), Norm(k.GetValue("InstallLocation") as string), Norm(icon));
                    }
                    catch { /* one broken entry */ }
                }
            }
            catch { /* the list is then shorter */ }
        }
        Read(Registry.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall");
        Read(Registry.LocalMachine, @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall");
        Read(Registry.CurrentUser, @"Software\Microsoft\Windows\CurrentVersion\Uninstall");

        var usage = Usage();
        // programs that share one folder (a whole suite) cannot be told apart by the folder: they are matched by the program's own file name instead
        string Squash(string x) => new string(x.Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
        var shared = found.Values.Where(v => v.Location.Length > 6).GroupBy(v => v.Location.TrimEnd('\\')).Where(g => g.Count() > 1).Select(g => g.Key).ToHashSet();
        var sharedIcon = found.Values.Where(v => v.Icon.Length > 3).GroupBy(v => Path.GetDirectoryName(v.Icon)?.ToLowerInvariant() ?? "").Where(g => g.Key.Length > 0 && g.Count() > 1).Select(g => g.Key).ToHashSet();
        var apps = new List<InstalledApp>();
        foreach (var (_, a) in found)
        {
            DateTime? last = null;
            var squashed = Squash(a.Name);
            var loc = a.Location.TrimEnd('\\');
            var iconDir = a.Icon.Length > 3 ? Path.GetDirectoryName(a.Icon)?.ToLowerInvariant() : null;
            foreach (var (path, when) in usage)
            {
                var stem = Squash(Path.GetFileNameWithoutExtension(path));
                var byName = stem.Length >= 4 && !GenericStems.Contains(stem) && (squashed.Contains(stem, StringComparison.Ordinal) || (squashed.Length >= 5 && stem.Contains(squashed, StringComparison.Ordinal)));
                var byFolder = loc.Length > 6 && !shared.Contains(loc) && path.StartsWith(loc + "\\", StringComparison.Ordinal);
                var byIcon = iconDir is { Length: > 6 } && !sharedIcon.Contains(iconDir) && path.StartsWith(iconDir + "\\", StringComparison.Ordinal) && !path.StartsWith(Environment.SystemDirectory.ToLowerInvariant(), StringComparison.Ordinal);
                var byPath = squashed.Length >= 5 && Squash(path).Contains(squashed, StringComparison.Ordinal);
                if ((byName || byFolder || byIcon || byPath) && (last is null || when > last)) last = when;
            }
            apps.Add(new InstalledApp(a.Name, a.Pub, a.Ver, last));
        }
        // programs from the Microsoft Store and other packaged programs (the new Teams, Outlook (new), Photos...) are not in the uninstall lists at all
        var have = new HashSet<string>(apps.Select(a => a.Name), StringComparer.OrdinalIgnoreCase);
        foreach (var s in StoreApps())
        {
            if (!have.Add(s.Name)) continue;
            DateTime? last = null;
            var family = s.Family.ToLowerInvariant() + "!";
            var folder = "\\windowsapps\\" + s.PackageName.ToLowerInvariant() + "_";
            foreach (var (path, when) in usage)
                if ((path.StartsWith(family, StringComparison.Ordinal) || path.Contains(folder, StringComparison.Ordinal)) && (last is null || when > last)) last = when;
            apps.Add(new InstalledApp(s.Name, s.Publisher, s.Version, last));
        }
        return apps.OrderByDescending(x => x.LastUsed ?? DateTime.MinValue).ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>Made-up programs for the picture the self-test takes.</summary>
    public static List<InstalledApp> Demo() => new()
    {
        new("Microsoft Outlook", "Microsoft Corporation", "16.0.17", DateTime.UtcNow),
        new("Microsoft Teams", "Microsoft Corporation", "24.1", DateTime.UtcNow.AddHours(-3)),
        new("Google Chrome", "Google LLC", "120.0", DateTime.UtcNow.AddDays(-1)),
        new("Adobe Acrobat Reader", "Adobe", "23.8", DateTime.UtcNow.AddDays(-9)),
        new("QuickBooks Desktop 2023", "Intuit", "33.0", DateTime.UtcNow.AddDays(-30)),
        new("7-Zip", "Igor Pavlov", "23.01", null),
    };
}
