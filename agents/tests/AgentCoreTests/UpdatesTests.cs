using System.Text;
using AdgRmm.Agent.Shared;

/// <summary>Tests for the outdated-programs scan (winget and Chocolatey output, the scan itself) and for updates. No processes, no network.</summary>
static class UpdatesTests
{
    // Real output of winget 1.29 on Windows 11 (trimmed to a few rows; the rows are untouched). "default" is plain "winget upgrade"
    // with a Source column; "source" is "--source winget" (no Source column); "machine" is "--scope machine"; "unknown" is "--include-unknown".
    const string RealDefault = """
Name                                                         Id                                 Version             Available            Source
-----------------------------------------------------------------------------------------------------------------------------------------------
7-Zip 25.01 (x64)                                            7zip.7zip                          25.01               26.06                winget
AnyDesk                                                      AnyDesk.AnyDesk                    ad 9.0.14           9.8.3                winget
Java(TM) SE Development Kit 17.0.10 (64-bit)                 Oracle.JDK.17                      17.0.10.0           17.0.12.0            winget
Microsoft .NET Framework 4.8.1 Targeting Pack                Microsoft.WindowsSDK.10.0.28000    < 10.0.28000.1721   10.0.28000.2957      winget
Microsoft Teams                                              Microsoft.Teams                    26198.304.4946.9672 26288.2004.5269.3420 winget
Microsoft Visual C++ v14 Redistributable (x64) - 14.51.36247 Microsoft.VCRedist.2015+.x64       14.51.36247.0       14.52.37029.0        winget
Unity Hub 3.10.0                                             Unity.UnityHub                     < 3.21.0.65535      3.22.6.65535         winget
Zoom Workplace                                               Zoom.Zoom.EXE                      6.0.11 (39959)      7.2.5 (51704)        winget
82 upgrades available.
6 package(s) have version numbers that cannot be determined. Use --include-unknown to see all results.
""";
    const string RealSource = """
Name                                                         Id                                 Version             Available
----------------------------------------------------------------------------------------------------------------------------------------
7-Zip 25.01 (x64)                                            7zip.7zip                          25.01               26.06
AnyDesk                                                      AnyDesk.AnyDesk                    ad 9.0.14           9.8.3
Java(TM) SE Development Kit 17.0.10 (64-bit)                 Oracle.JDK.17                      17.0.10.0           17.0.12.0
Microsoft .NET Framework 4.8.1 Targeting Pack                Microsoft.WindowsSDK.10.0.28000    < 10.0.28000.1721   10.0.28000.2957
Microsoft Teams                                              Microsoft.Teams                    26198.304.4946.9672 26288.2004.5269.3420
Microsoft Visual C++ v14 Redistributable (x64) - 14.51.36247 Microsoft.VCRedist.2015+.x64       14.51.36247.0       14.52.37029.0
Unity Hub 3.10.0                                             Unity.UnityHub                     < 3.21.0.65535      3.22.6.65535
Zoom Workplace                                               Zoom.Zoom.EXE                      6.0.11 (39959)      7.2.5 (51704)
82 upgrades available.
6 package(s) have version numbers that cannot be determined. Use --include-unknown to see all results.
""";
    const string RealMachine = """
Name                                                         Id                                 Version           Available
---------------------------------------------------------------------------------------------------------------------------------
7-Zip 25.01 (x64)                                            7zip.7zip                          25.01             26.06
AnyDesk                                                      AnyDesk.AnyDesk                    ad 9.0.14         9.8.3
Java(TM) SE Development Kit 17.0.10 (64-bit)                 Oracle.JDK.17                      17.0.10.0         17.0.12.0
Microsoft .NET Framework 4.8.1 Targeting Pack                Microsoft.WindowsSDK.10.0.28000    < 10.0.28000.1721 10.0.28000.2957
Microsoft Visual C++ v14 Redistributable (x64) - 14.51.36247 Microsoft.VCRedist.2015+.x64       14.51.36247.0     14.52.37029.0
Unity Hub 3.10.0                                             Unity.UnityHub                     < 3.21.0.65535    3.22.6.65535
58 upgrades available.
3 package(s) have version numbers that cannot be determined. Use --include-unknown to see all results.
""";
    const string RealUnknown = """
Name                                                         Id                                 Version             Available            Source
-----------------------------------------------------------------------------------------------------------------------------------------------
7-Zip 25.01 (x64)                                            7zip.7zip                          25.01               26.06                winget
AnyDesk                                                      AnyDesk.AnyDesk                    ad 9.0.14           9.8.3                winget
Java(TM) SE Development Kit 17.0.10 (64-bit)                 Oracle.JDK.17                      17.0.10.0           17.0.12.0            winget
Microsoft .NET Framework 4.8.1 Targeting Pack                Microsoft.WindowsSDK.10.0.28000    < 10.0.28000.1721   10.0.28000.2957      winget
Microsoft Teams                                              Microsoft.Teams                    26198.304.4946.9672 26288.2004.5269.3420 winget
Microsoft Visual C++ v14 Redistributable (x64) - 14.51.36247 Microsoft.VCRedist.2015+.x64       14.51.36247.0       14.52.37029.0        winget
Roblox Player for Test User                                  Roblox.Roblox                      Unknown             0.747                winget
Speccy                                                       Piriform.Speccy                    < 1.34.84           1.34.84              winget
Unity Hub 3.10.0                                             Unity.UnityHub                     < 3.21.0.65535      3.22.6.65535         winget
Zoom Workplace                                               Zoom.Zoom.EXE                      6.0.11 (39959)      7.2.5 (51704)        winget
88 upgrades available.
""";

    // Real "choco outdated -r" and the plain form (Chocolatey 2.2.2). One package is marked pinned by hand.
    const string RealChocoR = "chocolatey|2.2.2|2.7.5|false\nchocolatey-visualstudio.extension|1.11.1|1.13.0|false\noffice365business|17126.20132.0|20430.20146.0|false\npython|3.13.7|3.15.2|false\npython313|3.13.7|3.13.17|true\nvcredist140|14.44.35211|14.52.37029|false\n";
    const string RealChocoPlain = "Chocolatey v2.2.2\n3 validations performed. 2 success(es), 1 warning(s), and 0 error(s).\n\nValidation Warnings:\n - A pending system reboot request has been detected, however, this is\n   being ignored due to the current command being used 'outdated'.\n   It is recommended that you reboot at your earliest convenience.\n\nOutdated Packages\n Output is package name | current version | available version | pinned?\n\nchocolatey|2.2.2|2.7.5|false\npython|3.13.7|3.15.2|false\n\nChocolatey has determined 2 package(s) are outdated.\n";

    // Not captured on this machine, written from how winget prints: translated headers, wide characters, the progress spinner an
    // old winget writes to a redirected output, a Store source, and the second table of programs that need explicit targeting.
    const string French = "Nom                      ID                  Version   Disponible  Source\n------------------------------------------------------------------\nVLC media player         VideoLAN.VLC        3.0.20    3.0.21      winget\nInconnu Truc             Truc.Truc           Inconnu   2.0         winget\n2 mises à niveau disponibles.\n";
    static readonly string Japanese = "名前                    ID                 バージョン  利用可能  ソース\n-------------------------------------------------------------\n" +
        "メモ帳++                Notepad.Plus       8.1         8.6       winget\n日本語アプリ            Nihon.App          1.0         1.1       winget\nPlain App               Plain.App          2.0         3.0       winget\n";
    const string OldWithSpinner = "\r-\r\\\r|\r/\r   \r\r  \rName                  Id                  Version   Available  Source\r\n--------------------------------------------------------------------\r\nGit                   Git.Git             2.40.0    2.41.0     winget\r\nSome Store App        9NBLGGH4NNS1        1.0.0     1.2.0      msstore\r\n2 upgrades available.\r\n";
    const string TwoTables = "Name      Id        Version  Available  Source\n------------------------------------------\nApp One   Vendor.One   1.0    2.0        winget\n1 upgrades available.\n\nThe following packages have an upgrade available, but require explicit targeting for upgrade:\nName      Id        Version  Available  Source\n------------------------------------------\nApp Two   Vendor.Two   3.0    4.0        winget\n";
    const string Nothing = "No installed package found matching input criteria.\n";

    public static async Task Run(Action<string, bool> Check)
    {
        // ---- the reason an update failed is sent with the next update check
        var failedRes = new UpdateResult { Version = "1.3.51", Outcome = "rolled_back", Detail = "The new agent did not start.\r\nIt went back.", AtUtc = "2026-11-20T10:00:00Z" };
        var q = AgentUpdater.FailureQuery(failedRes, "1.3.50");
        Check("update failure: a failed update adds its version, outcome and reason to the check (one line, escaped)", q.StartsWith("&failedVersion=1.3.51&failedOutcome=rolled_back&failedDetail=") && !q.Contains("%0A") && !q.Contains(' ') && Uri.UnescapeDataString(q).Contains("The new agent did not start. It went back."));
        Check("update failure: nothing is added when the last update worked, or when the agent already runs that version or newer", AgentUpdater.FailureQuery(new UpdateResult { Version = "1.3.51", Outcome = "ok" }, "1.3.50") == "" && AgentUpdater.FailureQuery(failedRes, "1.3.51") == "" && AgentUpdater.FailureQuery(failedRes, "1.3.52") == "" && AgentUpdater.FailureQuery(null, "1.3.50") == "");
        Check("update failure: a long reason is cut", Uri.UnescapeDataString(AgentUpdater.FailureQuery(new UpdateResult { Version = "1.3.51", Outcome = "failed", Detail = new string('x', 900) }, "1.3.50")).Split("failedDetail=")[1].Length == 300);

        // ---- winget tables, real
        var d = WingetTable.Parse(RealDefault);
        Check("updates: real default table reads every row", d.Count == 8 && d[0].Id == "7zip.7zip" && d[0].Name == "7-Zip 25.01 (x64)" && d[0].InstalledVersion == "25.01" && d[0].AvailableVersion == "26.06" && d[0].Source == "winget");
        Check("updates: the footer lines are not programs", d.All(a => !a.Name.Contains("upgrades available")));
        Check("updates: a name that fills its column is still cut right (single space before the id)", d.Any(a => a.Id == "Microsoft.VCRedist.2015+.x64" && a.Name == "Microsoft Visual C++ v14 Redistributable (x64) - 14.51.36247"));
        Check("updates: a version with text and spaces stays whole", d.Any(a => a.Id == "Zoom.Zoom.EXE" && a.InstalledVersion == "6.0.11 (39959)" && a.AvailableVersion == "7.2.5 (51704)"));
        Check("updates: an upper-bound version is flagged approximate", d.Any(a => a.Id == "Unity.UnityHub" && a.Approximate && a.InstalledVersion == "< 3.21.0.65535") && d.Any(a => a.Id == "7zip.7zip" && !a.Approximate));
        Check("updates: a version with a prefix is kept as printed", d.Any(a => a.Id == "AnyDesk.AnyDesk" && a.InstalledVersion == "ad 9.0.14"));
        var s = WingetTable.Parse(RealSource);
        Check("updates: without a Source column the default source is used", s.Count == 8 && s.All(a => a.Source == "winget"));
        var m = WingetTable.Parse(RealMachine);
        Check("updates: --scope machine output reads (narrower columns)", m.Count > 4 && m.Any(a => a.Id == "7zip.7zip" && a.AvailableVersion == "26.06"));
        var u = WingetTable.Parse(RealUnknown);
        Check("updates: a program whose installed version is Unknown is not offered", u.All(a => a.Id != "Roblox.Roblox") && u.Any(a => a.Id == "Piriform.Speccy" && a.Approximate));

        // ---- winget tables, other shapes
        var fr = WingetTable.Parse(French);
        Check("updates: translated headers and footers parse by position", fr.Count == 1 && fr[0].Id == "VideoLAN.VLC" && fr[0].AvailableVersion == "3.0.21");
        var ja = WingetTable.Parse(Japanese);
        Check("updates: wide characters count as two columns", ja.Count == 3 && ja[0].Id == "Notepad.Plus" && ja[0].Name == "メモ帳++" && ja[1].Id == "Nihon.App" && ja[2].Id == "Plain.App" && ja[2].AvailableVersion == "3.0");
        var old = WingetTable.Parse(OldWithSpinner);
        Check("updates: spinner characters before the header are ignored", old.Count == 2 && old[0].Id == "Git.Git");
        Check("updates: the Store row keeps its source so it can be filtered", old[1].Source == "msstore");
        var two = WingetTable.Parse(TwoTables);
        Check("updates: a second table (explicit targeting) is read too", two.Count == 2 && two[1].Id == "Vendor.Two");
        Check("updates: 'nothing to upgrade' text gives an empty list", WingetTable.Parse(Nothing).Count == 0 && WingetTable.Parse("").Count == 0 && WingetTable.Parse(null).Count == 0);
        Check("updates: garbage gives an empty list", WingetTable.Parse("hello\n-----\nworld\n").Count == 0 && WingetTable.Parse(new string('-', 50) + "\n" + new string('-', 50)).Count == 0);
        Check("updates: display width of ASCII, CJK and combining marks", WingetTable.Width('a') == 1 && WingetTable.Width('名') == 2 && WingetTable.Width(0x301) == 0);

        // ---- chocolatey
        var c = ChocoOutdated.Parse(RealChocoR);
        Check("updates: choco -r lines read, pinned ones are left out", c.Count == 5 && c.All(a => a.Source == "chocolatey") && c.All(a => a.Id != "python313") && c[0].Id == "chocolatey" && c[0].InstalledVersion == "2.2.2" && c[0].AvailableVersion == "2.7.5");
        var cp = ChocoOutdated.Parse(RealChocoPlain);
        Check("updates: warnings and summary lines in choco output are skipped", cp.Count == 2 && cp[1].Id == "python");
        Check("updates: choco output with nothing outdated is empty", ChocoOutdated.Parse("").Count == 0 && ChocoOutdated.Parse("Chocolatey v2.2.2\n").Count == 0);

        // ---- which winget.exe a service runs
        var apps = new[] {
            "Microsoft.DesktopAppInstaller_1.21.3133.0_x64__8wekyb3d8bbwe", "Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe",
            "Microsoft.DesktopAppInstaller_1.29.380.0_neutral_~_8wekyb3d8bbwe", "Microsoft.DesktopAppInstaller_1.30.1.0_arm64__8wekyb3d8bbwe",
            "Microsoft.WindowsTerminal_1.0.0.0_x64__8wekyb3d8bbwe", "Microsoft.DesktopAppInstaller_2.0.0.0_x64__evil" };
        Check("updates: the newest x64 App Installer is chosen", SoftwareUpdates.PickWingetFolder(apps) == "Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe");
        Check("updates: arm64 is used when there is no x64", SoftwareUpdates.PickWingetFolder(apps.Where(a => !a.Contains("_x64__")).ToArray()) == "Microsoft.DesktopAppInstaller_1.30.1.0_arm64__8wekyb3d8bbwe");
        Check("updates: no App Installer gives none", SoftwareUpdates.PickWingetFolder(new[] { "Other_1.0.0.0_x64__8wekyb3d8bbwe" }) == null && SoftwareUpdates.PickWingetFolder(Array.Empty<string>()) == null);

        // ---- the request
        bool Parse(Dictionary<string, string?> dict, out SoftwareInstallRequest r, out string e) => SoftwareInstallRequest.TryParse(k => dict.GetValueOrDefault(k), out r, out e);
        Dictionary<string, string?> Up(string method, string id) => new() { ["action"] = "upgrade", ["method"] = method, [method == "winget" ? "wingetId" : "chocolateyId"] = id, ["name"] = "7-Zip", ["matchText"] = "7-Zip", ["fromVersion"] = "25.01", ["toVersion"] = "26.06" };
        Check("updates: a winget upgrade by id parses", Parse(Up("winget", "7zip.7zip"), out var wr, out _) && wr.Action == "upgrade" && wr.WingetId == "7zip.7zip" && wr.RunAsUser == null && wr.ToVersion == "26.06");
        Check("updates: a chocolatey upgrade parses", Parse(Up("chocolatey", "git"), out var cr, out _) && cr.ChocolateyId == "git");
        Check("updates: a bad winget id is refused", !Parse(Up("winget", "x&calc"), out _, out _) && !Parse(Up("winget", "a b"), out _, out _));
        Check("updates: an upgrade by direct installer is refused", !Parse(new() { ["action"] = "upgrade", ["method"] = "direct", ["matchText"] = "x" }, out _, out _));
        var withUser = Up("winget", "7zip.7zip"); withUser["runAs.user"] = "PC\\bob";
        Check("updates: an upgrade for one user is refused", !Parse(withUser, out _, out var runAsErr) && runAsErr.Contains("whole PC"));
        Check("updates: install and uninstall still work as before", Parse(new() { ["action"] = "install", ["method"] = "chocolatey", ["chocolateyId"] = "git", ["matchText"] = "Git" }, out _, out _));
        var longVersion = Up("winget", "7zip.7zip"); longVersion["toVersion"] = new string('1', 200);
        Check("updates: an over-long version is refused", !Parse(longVersion, out _, out _));
        Check("updates: scan request defaults to both sources", UpdatesScanRequest.TryParse(_ => null, out var sr, out _) && sr.Winget && sr.Chocolatey);
        Check("updates: scan request can name one source", UpdatesScanRequest.TryParse(k => k == "sources" ? "winget" : null, out var sr2, out _) && sr2.Winget && !sr2.Chocolatey);
        Check("updates: scan request refuses another source", !UpdatesScanRequest.TryParse(k => k == "sources" ? "winget,evil" : null, out _, out _));

        // ---- the scan
        var req = new UpdatesScanRequest();
        var host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe", ChocoPresent = true };
        host.OnRun = (file, args) => file.EndsWith("winget.exe") ? new ProcessOutcome(0, RealSource, "", false) : new ProcessOutcome(0, RealChocoR, "", false);
        var res = await SoftwareUpdates.ScanAsync(req, host, CancellationToken.None);
        Check("updates: scan lists winget and chocolatey programs", res.Ok && res.Apps.Count == 8 + 5 && res.Winget.State == "ok" && res.Chocolatey.State == "ok");
        Check("updates: the first winget run is machine scope, from the source winget, with no prompts",
            host.Runs[0].Args.SequenceEqual(new[] { "upgrade", "--source", "winget", "--scope", "machine", "--accept-source-agreements", "--disable-interactivity" }));
        Check("updates: choco runs outdated -r", host.Runs.Any(r => r.File.EndsWith("choco.exe") && r.Args[0] == "outdated" && r.Args.Contains("-r")));

        host = new FakeUpdatesHost { WingetPath = null, ChocoPresent = false };
        res = await SoftwareUpdates.ScanAsync(req, host, CancellationToken.None);
        Check("updates: neither tool present is a clear failure", !res.Ok && res.Winget.State == "missing" && res.Chocolatey.State == "missing" && res.Message.Contains("Neither"));

        host = new FakeUpdatesHost { WingetPath = null, ChocoPresent = true, OnRun = (f, a) => new ProcessOutcome(0, RealChocoR, "", false) };
        res = await SoftwareUpdates.ScanAsync(req, host, CancellationToken.None);
        Check("updates: no winget but Chocolatey still answers", res.Ok && res.Apps.Count == 5 && res.Winget.State == "missing");

        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe", ChocoPresent = false };
        host.OnRun = (f, a) => a.Contains("--scope") ? new ProcessOutcome(SoftwareUpdates.WingetInvalidArguments, "Argument name was not recognized for the current command: '--scope'", "", false)
            : a.Contains("--disable-interactivity") ? new ProcessOutcome(SoftwareUpdates.WingetInvalidArguments, "", "", false) : new ProcessOutcome(0, RealDefault, "", false);
        res = await SoftwareUpdates.ScanAsync(req, host, CancellationToken.None);
        Check("updates: an old winget is retried with fewer switches", res.Ok && res.Apps.Count == 8 && host.Runs.Count(r => r.File.EndsWith("winget.exe")) == 3);

        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe", ChocoPresent = false, OnRun = (f, a) => new ProcessOutcome(0, OldWithSpinner, "", false) };
        res = await SoftwareUpdates.ScanAsync(req, host, CancellationToken.None);
        Check("updates: Store rows from a full listing are dropped", res.Apps.Count == 1 && res.Apps[0].Id == "Git.Git");

        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe", ChocoPresent = false, OnRun = (f, a) => new ProcessOutcome(SoftwareUpdates.WingetNoPackage, Nothing, "", false) };
        res = await SoftwareUpdates.ScanAsync(req, host, CancellationToken.None);
        Check("updates: 'no package found' means nothing is outdated, not a failure", res.Ok && res.Apps.Count == 0 && res.Winget.State == "ok");

        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe", ChocoPresent = false, OnRun = (f, a) => new ProcessOutcome(null, "", "", true) };
        res = await SoftwareUpdates.ScanAsync(req, host, CancellationToken.None);
        Check("updates: a timeout is reported as one", !res.Ok && res.Winget.State == "timeout" && res.Message.Contains("minutes"));

        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe", ChocoPresent = false, OnRun = (f, a) => new ProcessOutcome(-1978335138, "Failed when opening source(s); try the 'source reset' command if the problem persists.", "", false) };
        res = await SoftwareUpdates.ScanAsync(req, host, CancellationToken.None);
        Check("updates: a winget failure keeps its first lines in the message", !res.Ok && res.Winget.State == "failed" && res.Message.Contains("Failed when opening source"));

        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe", ChocoPresent = true, OnRun = (f, a) => f.EndsWith("winget.exe") ? new ProcessOutcome(0, RealSource, "", false) : new ProcessOutcome(1, "", "boom", false) };
        res = await SoftwareUpdates.ScanAsync(req, host, CancellationToken.None);
        Check("updates: one source failing does not hide the other's answer", res.Ok && res.Apps.Count == 8 && res.Chocolatey.State == "failed");

        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe", ChocoPresent = true, OnRun = (f, a) => f.EndsWith("winget.exe") ? new ProcessOutcome(0, RealSource, "", false) : new ProcessOutcome(0, RealChocoR, "", false) };
        UpdatesScanRequest.TryParse(k => k == "sources" ? "chocolatey" : null, out var onlyChoco, out _);
        res = await SoftwareUpdates.ScanAsync(onlyChoco, host, CancellationToken.None);
        Check("updates: a scan limited to chocolatey never starts winget", res.Ok && res.Apps.Count == 5 && host.Runs.All(r => !r.File.EndsWith("winget.exe")) && res.Winget.State == "skipped");

        // ---- the update
        SoftwareInstallRequest Req(string method, string id)
        {
            Parse(Up(method, id), out var r, out _);
            return r;
        }
        // winget: the upgrade runs, then the list no longer holds the program
        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe", InstalledVersions = { new("7-Zip 26.06 (x64)", "26.06") } };
        host.OnRun = (f, a) => a.Contains("--id") ? new ProcessOutcome(0, "Successfully installed", "", false) : new ProcessOutcome(SoftwareUpdates.WingetNoPackage, Nothing, "", false);
        var up = await SoftwareInstall.RunAsync(Req("winget", "7zip.7zip"), host, CancellationToken.None);
        Check("updates: a clean winget upgrade that leaves the list is verified", up.Ok && up.Verified && up.Action == "upgrade" && up.Message.Contains("26.06") && up.Message.Contains("confirmed"));
        var run0 = host.Runs[0].Args;
        Check("updates: winget upgrade is by exact id, from winget, machine scope, silent, with no prompts",
            run0.SequenceEqual(new[] { "upgrade", "--id", "7zip.7zip", "--exact", "--source", "winget", "--scope", "machine", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity" }));

        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe" };
        host.OnRun = (f, a) => a.Contains("--id") ? new ProcessOutcome(0, "Successfully installed", "", false) : new ProcessOutcome(0, RealSource, "", false);
        up = await SoftwareInstall.RunAsync(Req("winget", "7zip.7zip"), host, CancellationToken.None);
        Check("updates: a clean exit while winget still lists it is a failure", !up.Ok && !up.Verified && up.Message.Contains("still listed"));

        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe" };
        host.OnRun = (f, a) => a.Contains("--id") ? new ProcessOutcome(0, "ok", "", false) : new ProcessOutcome(null, "", "", true);
        up = await SoftwareInstall.RunAsync(Req("winget", "7zip.7zip"), host, CancellationToken.None);
        Check("updates: when the check afterwards cannot run, the update is not called confirmed", !up.Ok && up.Message.Contains("could not be confirmed"));

        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe" };
        host.OnRun = (f, a) => a.Contains("--id") ? new ProcessOutcome(-1978335188, "Installer failed", "", false) : new ProcessOutcome(0, RealSource, "", false);
        up = await SoftwareInstall.RunAsync(Req("winget", "7zip.7zip"), host, CancellationToken.None);
        Check("updates: a failing exit code stops there, with no second look", !up.Ok && up.ExitCode == -1978335188 && host.Runs.Count == 1);

        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe" };
        host.OnRun = (f, a) => a.Contains("--id") ? new ProcessOutcome(SoftwareUpdates.WingetUpdateNotApplicable, "No applicable upgrade found.", "", false) : new ProcessOutcome(SoftwareUpdates.WingetNoPackage, Nothing, "", false);
        up = await SoftwareInstall.RunAsync(Req("winget", "7zip.7zip"), host, CancellationToken.None);
        Check("updates: 'no applicable update' for a program that is no longer outdated is a success", up.Ok && up.Message.Contains("already up to date"));

        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe" };
        host.OnRun = (f, a) => a.Contains("--id") ? new ProcessOutcome(null, "", "", true) : new ProcessOutcome(0, "", "", false);
        up = await SoftwareInstall.RunAsync(Req("winget", "7zip.7zip"), host, CancellationToken.None);
        Check("updates: an update that runs too long is stopped and says so", !up.Ok && up.Message.Contains("30 minutes"));

        host = new FakeUpdatesHost { WingetPath = null };
        up = await SoftwareInstall.RunAsync(Req("winget", "7zip.7zip"), host, CancellationToken.None);
        Check("updates: no winget means nothing is run", !up.Ok && host.Runs.Count == 0 && up.Message.Contains("not available"));

        host = new FakeUpdatesHost { WingetPath = @"C:\wa\winget.exe" };
        host.OnRun = (f, a) => a.Contains("--scope") ? new ProcessOutcome(SoftwareUpdates.WingetInvalidArguments, "", "", false)
            : a.Contains("--id") ? new ProcessOutcome(0, "ok", "", false) : new ProcessOutcome(SoftwareUpdates.WingetNoPackage, Nothing, "", false);
        up = await SoftwareInstall.RunAsync(Req("winget", "7zip.7zip"), host, CancellationToken.None);
        Check("updates: an old winget that does not know --scope still updates", up.Ok && host.Runs.Any(r => r.Args.Contains("--id") && !r.Args.Contains("--scope")));

        // choco
        host = new FakeUpdatesHost { ChocoPresent = true };
        host.OnRun = (f, a) => a[0] == "upgrade" ? new ProcessOutcome(0, "git upgraded", "", false) : new ProcessOutcome(0, "python|3.13.7|3.15.2|false\n", "", false);
        up = await SoftwareInstall.RunAsync(Req("chocolatey", "git"), host, CancellationToken.None);
        Check("updates: a choco upgrade that leaves the outdated list is verified", up.Ok && up.Verified && host.Runs[0].Args.SequenceEqual(new[] { "upgrade", "git", "-y", "--no-progress", "--limit-output" }));

        host = new FakeUpdatesHost { ChocoPresent = true };
        host.OnRun = (f, a) => a[0] == "upgrade" ? new ProcessOutcome(3010, "", "", false) : new ProcessOutcome(0, "", "", false);
        up = await SoftwareInstall.RunAsync(Req("chocolatey", "git"), host, CancellationToken.None);
        Check("updates: a restart exit code is success and says so", up.Ok && up.Message.Contains("restart"));

        host = new FakeUpdatesHost { ChocoPresent = true };
        host.OnRun = (f, a) => a[0] == "upgrade" ? new ProcessOutcome(0, "", "", false) : new ProcessOutcome(0, "git|2.0|3.0|false\n", "", false);
        up = await SoftwareInstall.RunAsync(Req("chocolatey", "git"), host, CancellationToken.None);
        Check("updates: choco still listing the package is a failure", !up.Ok && up.Message.Contains("still listed"));

        host = new FakeUpdatesHost { ChocoPresent = false };
        up = await SoftwareInstall.RunAsync(Req("chocolatey", "git"), host, CancellationToken.None);
        Check("updates: an update never installs Chocolatey", !up.Ok && host.Runs.Count == 0 && up.Message.Contains("not installed"));

        // an install host that cannot update refuses cleanly
        var plain = new FakeInstallHost { ChocoPresent = true };
        up = await SoftwareInstall.RunAsync(Req("chocolatey", "git"), plain, CancellationToken.None);
        Check("updates: a host without update support refuses an upgrade without running anything", !up.Ok && plain.Runs.Count == 0);
    }
}

sealed class FakeUpdatesHost : ISoftwareUpgradeHost
{
    public string? WingetPath;
    public bool ChocoPresent;
    public Func<string, string[], ProcessOutcome> OnRun = (f, a) => new ProcessOutcome(0, "", "", false);
    public List<(string File, string[] Args)> Runs = new();
    public List<InstalledProgram> InstalledVersions = new();
    public string ChocolateyExe => @"C:\ProgramData\chocolatey\bin\choco.exe";
    public string? ResolveWingetPath() => WingetPath;
    public bool FileExists(string path) => path == ChocolateyExe && ChocoPresent;
    public Task<ProcessOutcome> RunAsync(string file, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        Runs.Add((file, args.ToArray()));
        return Task.FromResult(OnRun(file, args.ToArray()));
    }
    public Task<IReadOnlyList<InstalledProgram>> ListInstalledAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<InstalledProgram>>(InstalledVersions);
    public Task DownloadAsync(Uri url, string destinationPath, CancellationToken ct) => Task.CompletedTask;
    public Task<string> Sha256Async(string path, CancellationToken ct) => Task.FromResult("");
    public Task<IReadOnlyList<string>> ListInstalledNamesAsync(string? user, CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>(InstalledVersions.Select(p => p.Name).ToList());
    public Task<bool> IsUserSignedInAsync(string user, CancellationToken ct) => Task.FromResult(true);
    public Task<ProcessOutcome> RunAsUserAsync(string user, string file, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct) => Task.FromResult(new ProcessOutcome(0, "", "", false));
    public Task DelayAsync(TimeSpan delay, CancellationToken ct) => Task.CompletedTask;
    public string CreateTempDir(string? readableBy) => @"C:\fake\dir";
    public void DeleteDir(string path) { }
}
