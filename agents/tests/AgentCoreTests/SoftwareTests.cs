using System.Text;
using AdgRmm.Agent.Shared;

/// <summary>Tests for software installs and the installed-software inventory. No network, no processes, no registry.</summary>
static class SoftwareTests
{
    public static async Task Run(Action<string, bool> Check)
    {
        var goodSha = new string('a', 64);
        bool Parse(Dictionary<string, string?> d, out SoftwareInstallRequest r, out string e) => SoftwareInstallRequest.TryParse(k => d.GetValueOrDefault(k), out r, out e);
        Dictionary<string, string?> Choco(string id) => new() { ["action"] = "install", ["method"] = "chocolatey", ["chocolateyId"] = id, ["name"] = "Chrome", ["matchText"] = "Chrome" };
        Dictionary<string, string?> Direct(string url, string sha, string kind = "exe", string? args = "/S") =>
            new() { ["action"] = "install", ["method"] = "direct", ["matchText"] = "Setup", ["installerUrl"] = url, ["installerSha256"] = sha, ["installerKind"] = kind, ["silentArgs"] = args };

        Check("software: a chocolatey id passes", Parse(Choco("googlechrome"), out _, out _));
        Check("software: id with a space is rejected", !Parse(Choco("a b"), out _, out _));
        Check("software: id with shell characters is rejected", !Parse(Choco("x&calc"), out _, out _));
        Check("software: id starting with a dot is rejected", !Parse(Choco(".x"), out _, out _));
        Check("software: unknown action is rejected", !Parse(new() { ["action"] = "run", ["matchText"] = "x", ["method"] = "chocolatey", ["chocolateyId"] = "x" }, out _, out _));
        Check("software: direct https with sha passes", Parse(Direct("https://example.com/a/setup.exe", goodSha), out _, out _));
        Check("software: http is rejected", !Parse(Direct("http://example.com/setup.exe", goodSha), out _, out _));
        Check("software: url credentials are rejected", !Parse(Direct("https://u:p@example.com/setup.exe", goodSha), out _, out _));
        Check("software: short sha is rejected", !Parse(Direct("https://example.com/setup.exe", "abc"), out _, out _));
        Check("software: direct uninstall is refused", !Parse(new() { ["action"] = "uninstall", ["matchText"] = "x", ["method"] = "direct", ["installerUrl"] = "https://example.com/a.exe", ["installerSha256"] = goodSha }, out _, out _));
        Parse(Direct("https://example.com/setup.exe", goodSha, args: "/S /D=\"C:\\Program Files\\X\""), out var withArgs, out _);
        Check("software: silent args split like a command line", withArgs.SilentArgs.SequenceEqual(new[] { "/S", "/D=C:\\Program Files\\X" }));

        Check("software: choco install args", SoftwareInstall.ChocolateyArgs("install", "git").SequenceEqual(new[] { "install", "git", "-y", "--no-progress", "--limit-output" }));
        Check("software: choco uninstall args", SoftwareInstall.ChocolateyArgs("uninstall", "git")[0] == "uninstall");
        Check("software: msi args", SoftwareInstall.MsiArgs("C:\\t\\a.msi").SequenceEqual(new[] { "/i", "C:\\t\\a.msi", "/qn", "/norestart" }));
        Check("software: exit 0, 1641 and 3010 succeed", SoftwareInstall.IsSuccess(0, out var r0) && !r0 && SoftwareInstall.IsSuccess(1641, out var r1) && r1 && SoftwareInstall.IsSuccess(3010, out var r2) && r2);
        Check("software: exit 1603 fails", !SoftwareInstall.IsSuccess(1603, out _));
        Check("software: output is cut to 8 KB", Encoding.UTF8.GetByteCount(SoftwareInstall.Truncate(new string('x', 20000))) < 8 * 1024 + 40 && SoftwareInstall.Truncate("short") == "short");
        Check("software: sha compare ignores case", SoftwareInstall.Sha256Matches(goodSha, goodSha.ToUpperInvariant()) && !SoftwareInstall.Sha256Matches(goodSha, new string('b', 64)));
        Check("software: installer file name is safe", SoftwareInstall.InstallerFileName(new Uri("https://x.test/a/..%2F..%2Fevil name"), "msi").EndsWith(".msi") && !SoftwareInstall.InstallerFileName(new Uri("https://x.test/"), "exe").Contains('/'));

        Parse(Choco("git"), out var chocoReq, out _);
        var host = new FakeInstallHost { ChocoPresent = false, BootstrapMakesChoco = true, Installed = { "Google Chrome" } };
        var res = await SoftwareInstall.RunAsync(chocoReq, host, CancellationToken.None);
        Check("software: missing chocolatey is bootstrapped, then the install runs", res.Ok && host.Runs.Count == 2 && host.Runs[0].File == "powershell.exe" && host.Runs[1].Args[0] == "install");

        host = new FakeInstallHost { ChocoPresent = true, Exit = 3010, Installed = { "Google Chrome" } };
        res = await SoftwareInstall.RunAsync(chocoReq, host, CancellationToken.None);
        Check("software: reboot exit code is success and says so", res.Ok && res.Message.Contains("restart") && res.ExitCode == 3010);

        host = new FakeInstallHost { ChocoPresent = true, Exit = 1 };
        res = await SoftwareInstall.RunAsync(chocoReq, host, CancellationToken.None);
        Check("software: a failing exit code is a failure", !res.Ok && res.ExitCode == 1);

        host = new FakeInstallHost { ChocoPresent = false, BootstrapMakesChoco = false };
        res = await SoftwareInstall.RunAsync(chocoReq, host, CancellationToken.None);
        Check("software: a failed bootstrap stops before installing", !res.Ok && host.Runs.Count == 1);

        Parse(Direct("https://example.com/setup.exe", goodSha), out var directReq, out _);
        host = new FakeInstallHost { Hash = new string('b', 64) };
        res = await SoftwareInstall.RunAsync(directReq, host, CancellationToken.None);
        Check("software: hash mismatch never runs the file and cleans up", !res.Ok && host.Runs.Count == 0 && host.Deleted && res.Message.Contains("SHA-256"));

        host = new FakeInstallHost { Hash = goodSha, Installed = { "Setup Thing" } };
        res = await SoftwareInstall.RunAsync(directReq, host, CancellationToken.None);
        Check("software: direct exe runs with the silent args, then the folder is deleted", res.Ok && host.Runs.Count == 1 && host.Runs[0].Args.SequenceEqual(new[] { "/S" }) && host.Deleted);

        Parse(Direct("https://example.com/setup.msi", goodSha, "msi", null), out var msiReq, out _);
        host = new FakeInstallHost { Hash = goodSha, Installed = { "Setup Thing" } };
        res = await SoftwareInstall.RunAsync(msiReq, host, CancellationToken.None);
        Check("software: direct msi runs msiexec /i ... /qn /norestart", res.Ok && host.Runs[0].File == "msiexec.exe" && host.Runs[0].Args.Contains("/qn"));

        host = new FakeInstallHost { ChocoPresent = true, TimedOut = true };
        res = await SoftwareInstall.RunAsync(chocoReq, host, CancellationToken.None);
        Check("software: a timeout is a failure that says so", !res.Ok && res.Message.Contains("30 minutes"));

        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        host = new FakeInstallHost { ChocoPresent = true };
        res = await SoftwareInstall.RunAsync(chocoReq, host, cancelled.Token);
        Check("software: cancellation is reported as cancelled", !res.Ok && res.Message.Contains("cancelled"));

        // ── Verification after the installer says it is done ──
        Check("software: choco install with params and install arguments", SoftwareInstall.ChocolateyArgs("install", "brave", "/x y", "/D=C:\\B").SequenceEqual(
            new[] { "install", "brave", "--params", "/x y", "--install-arguments", "/D=C:\\B", "-y", "--no-progress", "--limit-output" }));
        Check("software: uninstall ignores params", SoftwareInstall.ChocolateyArgs("uninstall", "brave", "/x", "/y").SequenceEqual(new[] { "uninstall", "brave", "-y", "--no-progress", "--limit-output" }));
        var pd = Choco("brave"); pd["chocolateyParams"] = "/NoDesktop"; pd["chocolateyInstallArgs"] = "/S";
        Check("software: params fields are read", Parse(pd, out var pReq, out _) && pReq.ChocolateyParams == "/NoDesktop" && pReq.ChocolateyInstallArgs == "/S");
        pd["chocolateyParams"] = new string('a', 201);
        Check("software: params over 200 characters are rejected", !Parse(pd, out _, out _));
        pd["chocolateyParams"] = "a\nb";
        Check("software: params with control characters are rejected", !Parse(pd, out _, out _));
        var noMatch = Choco("git"); noMatch.Remove("matchText");
        Check("software: matchText is required", !Parse(noMatch, out _, out _));

        Parse(Choco("brave"), out var braveReq, out _);
        host = new FakeInstallHost { ChocoPresent = true, Installed = { "Microsoft Edge" }, Stdout = "installed to C:\\WINDOWS\\system32\\config\\systemprofile\\AppData" };
        res = await SoftwareInstall.RunAsync(braveReq, host, CancellationToken.None);
        Check("software: exit 0 but program missing fails, not verified, mentions systemprofile", !res.Ok && !res.Verified && res.ExitCode == 0 && res.Message.Contains("not installed for any user") && res.Message.Contains("systemprofile") && host.Looks == 3);

        host = new FakeInstallHost { ChocoPresent = true, Installed = { }, InstalledAfter = new List<string> { "Google Chrome" } };
        res = await SoftwareInstall.RunAsync(braveReq, host, CancellationToken.None);
        Check("software: a program that shows up on a later look passes", res.Ok && res.Verified && res.Message.Contains("confirmed it is present") && host.Looks == 2);

        host = new FakeInstallHost { ChocoPresent = true, ListThrows = true };
        res = await SoftwareInstall.RunAsync(braveReq, host, CancellationToken.None);
        Check("software: an unreadable inventory is not a success", !res.Ok && !res.Verified);

        Parse(new() { ["action"] = "uninstall", ["method"] = "chocolatey", ["chocolateyId"] = "git", ["name"] = "Git", ["matchText"] = "Git" }, out var unReq, out _);
        host = new FakeInstallHost { ChocoPresent = true, Installed = { "Git version 2" } };
        res = await SoftwareInstall.RunAsync(unReq, host, CancellationToken.None);
        Check("software: uninstall that leaves the program fails", !res.Ok && res.Message.Contains("still installed"));
        host = new FakeInstallHost { ChocoPresent = true };
        res = await SoftwareInstall.RunAsync(unReq, host, CancellationToken.None);
        Check("software: uninstall that removes it passes", res.Ok && res.Verified && res.Message.Contains("confirmed it is gone"));

        // ── Install for a specific user ──
        Dictionary<string, string?> Winget(string? user = "PC\\ann")
        {
            var d = new Dictionary<string, string?> { ["action"] = "install", ["method"] = "winget", ["wingetId"] = "Brave.Brave", ["name"] = "Brave", ["matchText"] = "Brave" };
            if (user is not null) d["runAs.user"] = user;
            return d;
        }
        Check("user: winget with a user passes", Parse(Winget(), out var wReq, out _) && wReq.RunAsUser == "PC\\ann" && wReq.WingetId == "Brave.Brave");
        Check("user: winget without a user is rejected", !Parse(Winget(null), out _, out _));
        var badId = Winget(); badId["wingetId"] = "a b";
        Check("user: bad winget id is rejected", !Parse(badId, out _, out _));
        var badUser = Winget("ann");
        Check("user: account without a domain is rejected", !Parse(badUser, out _, out _));
        var chocoUser = Choco("brave"); chocoUser["runAs.user"] = "PC\\ann";
        Check("user: chocolatey for a user is rejected", !Parse(chocoUser, out _, out _));
        var unUser = Winget(); unUser["action"] = "uninstall";
        Check("user: winget uninstall for a user passes", Parse(unUser, out var unWReq, out _) && unWReq.Action == "uninstall" && unWReq.RunAsUser == "PC\\ann");
        var unDirect = Direct("https://example.com/a.exe", goodSha); unDirect["action"] = "uninstall"; unDirect["runAs.user"] = "PC\\ann";
        Check("user: direct uninstall for a user is rejected", !Parse(unDirect, out _, out _));
        var unChoco = Choco("brave"); unChoco["action"] = "uninstall"; unChoco["runAs.user"] = "PC\\ann";
        Check("user: chocolatey uninstall for a user is rejected", !Parse(unChoco, out _, out _));
        Check("user: winget uninstall arguments (no scope, no package agreements)", SoftwareInstall.WingetArgs("Brave.Brave", "uninstall").SequenceEqual(
            new[] { "uninstall", "--id", "Brave.Brave", "--exact", "--silent", "--accept-source-agreements", "--disable-interactivity" }));
        Check("user: winget no-package classification", SoftwareInstall.WingetNoPackage(-1978335212, "") && SoftwareInstall.WingetNoPackage(1, "No installed package found matching input criteria.")
            && !SoftwareInstall.WingetNoPackage(1, "other failure") && !SoftwareInstall.WingetNoPackage(0, "done"));
        Check("choco: nothing-to-uninstall text is recognised", SoftwareInstall.ChocoNothingToUninstall("brave is not installed. Cannot uninstall a non-existent package.") && !SoftwareInstall.ChocoNothingToUninstall("failed"));

        host = new FakeInstallHost { Installed = { "Brave" }, InstalledAfter = new List<string>() };
        res = await SoftwareInstall.RunAsync(unWReq, host, CancellationToken.None);
        Check("user: winget uninstall verified gone in that user's programs", res.Ok && res.Verified && res.Message == "Removed Brave for PC\\ann and confirmed it is gone."
            && host.UserRuns[0].Args[0] == "uninstall" && host.ListedFor == "PC\\ann");
        host = new FakeInstallHost { Installed = { "Brave" } };
        res = await SoftwareInstall.RunAsync(unWReq, host, CancellationToken.None);
        Check("user: winget uninstall that leaves it fails", !res.Ok && res.Message == "Brave is still installed for PC\\ann.");
        host = new FakeInstallHost { Exit = -1978335212 };
        res = await SoftwareInstall.RunAsync(unWReq, host, CancellationToken.None);
        Check("user: no installed package and not in the hive is success", res.Ok && res.Verified && res.Message == "Brave was not installed for PC\\ann, nothing to remove.");
        host = new FakeInstallHost { Exit = -1978335212, Installed = { "Brave" } };
        res = await SoftwareInstall.RunAsync(unWReq, host, CancellationToken.None);
        Check("user: no installed package but still in the hive fails", !res.Ok && !res.Verified);
        host = new FakeInstallHost { SignedIn = false };
        res = await SoftwareInstall.RunAsync(unWReq, host, CancellationToken.None);
        Check("user: uninstall when not signed in says uninstall", !res.Ok && res.Message.Contains("so the uninstall cannot run"));

        Parse(new() { ["action"] = "uninstall", ["method"] = "chocolatey", ["chocolateyId"] = "brave", ["name"] = "Brave", ["matchText"] = "Brave" }, out var chocoUn, out _);
        host = new FakeInstallHost { ChocoPresent = true, Exit = 1, Stdout = "brave is not installed. Cannot uninstall a non-existent package." };
        res = await SoftwareInstall.RunAsync(chocoUn, host, CancellationToken.None);
        Check("choco: uninstall of an unknown package is a failure with a plain message and the output kept",
            !res.Ok && res.Message.StartsWith("Chocolatey has no record of Brave on this PC") && res.Stdout.Contains("non-existent package"));
        Check("user: winget arguments", SoftwareInstall.WingetArgs("Brave.Brave").SequenceEqual(new[] { "install", "--id", "Brave.Brave", "--exact", "--scope", "user", "--silent",
            "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity" }));
        Check("user: command line quoting", SoftwareInstall.QuoteCommandLine("C:\\a b\\x.exe", new[] { "/S", "/D=C:\\P F\\", "say \"hi\"" }) == "\"C:\\a b\\x.exe\" /S \"/D=C:\\P F\\\\\" \"say \\\"hi\\\"\"");

        host = new FakeInstallHost { Installed = { "Brave" } };
        res = await SoftwareInstall.RunAsync(wReq, host, CancellationToken.None);
        Check("user: winget runs as that user and is verified in that user's programs",
            res.Ok && res.Verified && host.UserRuns.Count == 1 && host.UserRuns[0].User == "PC\\ann" && host.UserRuns[0].File == "winget.exe" && host.ListedFor == "PC\\ann" && host.Runs.Count == 0 && res.Message.Contains("for PC\\ann"));
        host = new FakeInstallHost { SignedIn = false, Installed = { "Brave" } };
        res = await SoftwareInstall.RunAsync(wReq, host, CancellationToken.None);
        Check("user: not signed in fails with the plain message", !res.Ok && res.Message == "PC\\ann is not signed in on this PC right now, so the install cannot run in their session." && host.UserRuns.Count == 0);
        host = new FakeInstallHost { WingetMissing = true };
        res = await SoftwareInstall.RunAsync(wReq, host, CancellationToken.None);
        Check("user: no winget for the user fails plainly", !res.Ok && res.Message == "winget is not available for PC\\ann on this PC.");
        host = new FakeInstallHost { };
        res = await SoftwareInstall.RunAsync(wReq, host, CancellationToken.None);
        Check("user: exit 0 but not in the user's programs fails", !res.Ok && !res.Verified && res.Message.Contains("PC\\ann"));

        var du = Direct("https://example.com/setup.msi", goodSha, "msi", null); du["runAs.user"] = "PC\\ann";
        Parse(du, out var duReq, out _);
        host = new FakeInstallHost { Hash = goodSha, Installed = { "Setup Thing" } };
        res = await SoftwareInstall.RunAsync(duReq, host, CancellationToken.None);
        Check("user: direct msi runs in the user's session from a folder they can read", res.Ok && host.Runs.Count == 0 && host.UserRuns[0].File == "msiexec.exe" && host.UserRuns[0].Args.Contains("/qn") && host.TempFor == "PC\\ann");

        // ── Users list ──
        Check("users: account parsing", SoftwareInventoryCore.TryParseAccount("PC\\ann", out var dom, out var nm) && dom == "PC" && nm == "ann"
            && !SoftwareInventoryCore.TryParseAccount("ann", out _, out _) && !SoftwareInventoryCore.TryParseAccount("a\\b\\c", out _, out _) && !SoftwareInventoryCore.TryParseAccount("\\b", out _, out _));
        Check("users: same account ignores case and . for the machine", SoftwareInventoryCore.SameAccount("pc\\ANN", "PC\\ann", "PC") && SoftwareInventoryCore.SameAccount(".\\ann", "PC\\ann", "PC") && !SoftwareInventoryCore.SameAccount("PC\\ann", "PC\\bob", "PC"));
        Check("users: service accounts are recognised", SoftwareInventoryCore.IsServiceAccount("NT AUTHORITY\\SYSTEM") && SoftwareInventoryCore.IsServiceAccount("NT AUTHORITY\\LOCAL SERVICE")
            && SoftwareInventoryCore.IsServiceAccount("IIS APPPOOL\\DefaultAppPool") && SoftwareInventoryCore.IsServiceAccount("PC\\DefaultAppPool") && SoftwareInventoryCore.IsServiceAccount("Window Manager\\DWM-1")
            && SoftwareInventoryCore.IsServiceAccount("WORKGROUP\\PC$") && !SoftwareInventoryCore.IsServiceAccount("PC\\ann"));
        var users = SoftwareInventoryCore.MergeUsers(new[] { "PC\\bob", "PC\\ann", "NT SERVICE\\x\\y", "IIS APPPOOL\\DefaultAppPool", "pc\\BOB" }, new[] { ".\\ann", "CORP\\cara", "NT AUTHORITY\\SYSTEM" }, "PC");
        Check("users: merge marks signed-in, adds session-only users, drops services and duplicates",
            users.Count == 3 && users[0].LoggedIn && users.Count(u => u.LoggedIn) == 2 && users.Any(u => u.Account == "PC\\bob" && !u.LoggedIn) && users.Any(u => u.Account == "CORP\\cara" && u.LoggedIn));
        var usersJson = System.Text.Json.JsonSerializer.Serialize(users[0]);
        Check("users: JSON uses camelCase names", usersJson.Contains("\"account\"") && usersJson.Contains("\"loggedIn\""));

        // ── Installed software: parsing and merging ──
        Check("inventory: user SIDs are accepted", SoftwareInventoryCore.IsUserSid("S-1-5-21-1-2-3-1001") && SoftwareInventoryCore.IsUserSid("S-1-12-1-1-2-3-4"));
        Check("inventory: service SIDs and _Classes hives are skipped",
            !SoftwareInventoryCore.IsUserSid("S-1-5-18") && !SoftwareInventoryCore.IsUserSid("S-1-5-19") && !SoftwareInventoryCore.IsUserSid("S-1-5-20")
            && !SoftwareInventoryCore.IsUserSid(".DEFAULT") && !SoftwareInventoryCore.IsUserSid("S-1-5-21-1-2-3-1001_Classes"));
        Check("inventory: components and updates are hidden for users",
            SoftwareInventoryCore.IsHiddenUserEntry(1, null, null) && SoftwareInventoryCore.IsHiddenUserEntry(null, "KB123", null)
            && SoftwareInventoryCore.IsHiddenUserEntry(null, null, "Security Update") && !SoftwareInventoryCore.IsHiddenUserEntry(0, null, null));
        Check("inventory: product from 11707 message", SoftwareInventoryCore.ProductFromMessage("Product: Zoom Workplace (64-bit) -- Installation completed successfully.") == "Zoom Workplace (64-bit)");
        Check("inventory: product from 1033 message", SoftwareInventoryCore.ProductFromMessage("Windows Installer installed the product. Product Name: 7-Zip 23.01. Product Version: 23.01. Product Language: 1033.") == "7-Zip 23.01");

        var t0 = new DateTime(2026, 1, 1);
        var map = SoftwareInventoryCore.BuildInstallerMap(new[]
        {
            new InstallEvent(t0, "S-1-5-21-1-2-3-1001", "Product: Zoom Workplace -- Installation completed successfully."),
            new InstallEvent(t0.AddDays(5), "S-1-5-21-1-2-3-1002", "Product: Zoom Workplace -- Installation completed successfully."),
            new InstallEvent(t0, "S-1-5-18", "Product: Contoso Agent -- Installation completed successfully."),
            new InstallEvent(t0, "S-1-5-21-1-2-3-1001", "Unrelated message"),
        });
        Check("inventory: newest installer wins, system installs are left out", map.Count == 1 && map["Zoom Workplace"] == "S-1-5-21-1-2-3-1002");
        Check("inventory: exact and partial name match", SoftwareInventoryCore.FindInstallerSid(map, "zoom workplace") != null
            && SoftwareInventoryCore.FindInstallerSid(map, "Zoom Workplace (64-bit)") != null && SoftwareInventoryCore.FindInstallerSid(map, "Chrome") == null);

        var machine = new[] { new SoftwareItem { Name = "Chrome", Version = "1" } };
        var perUser = new[]
        {
            new SoftwareItem { Name = "Chrome", Version = "1", User = "PC\\ann" },
            new SoftwareItem { Name = "Chrome", Version = "1", User = "PC\\ann" },
            new SoftwareItem { Name = "Chrome", Version = "1", User = "PC\\bob" },
        };
        var merged = SoftwareInventoryCore.Merge(machine, perUser);
        Check("inventory: one item per user, machine copy kept separate", merged.Count == 3 && merged[0].Scope == "machine" && merged.Count(m => m.Scope == "user") == 2);
        var json = System.Text.Json.JsonSerializer.Serialize(new SoftwareItem { Name = "A", Scope = "user", User = "PC\\a", InstalledBy = "PC\\a" });
        Check("inventory: JSON uses camelCase names", json.Contains("\"scope\":\"user\"") && json.Contains("\"installedBy\"") && json.Contains("\"installDate\""));
    }
}

sealed class FakeInstallHost : ISoftwareInstallHost
{
    public bool ChocoPresent, BootstrapMakesChoco, TimedOut, Deleted;
    public int Exit;
    public string Hash = "";
    public List<(string File, string[] Args)> Runs = new();
    public string ChocolateyExe => @"C:\ProgramData\chocolatey\bin\choco.exe";
    public bool FileExists(string path) => path == ChocolateyExe && ChocoPresent;
    public Task<ProcessOutcome> RunAsync(string file, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        Runs.Add((file, args.ToArray()));
        if (file == "powershell.exe")
        {
            if (BootstrapMakesChoco) ChocoPresent = true;
            return Task.FromResult(new ProcessOutcome(BootstrapMakesChoco ? 0 : 1, "", "", false));
        }
        return Task.FromResult(new ProcessOutcome(TimedOut ? null : Exit, Stdout, "", TimedOut));
    }
    public Task DownloadAsync(Uri url, string destinationPath, CancellationToken ct) => Task.CompletedTask;
    public Task<string> Sha256Async(string path, CancellationToken ct) => Task.FromResult(Hash);
    public List<string> Installed = new();
    public List<string>? InstalledAfter; // what the list shows from the second look on
    public int Looks;
    public bool ListThrows;
    public string Stdout = "out";
    public Task<IReadOnlyList<string>> ListInstalledNamesAsync(string? user, CancellationToken ct)
    {
        ListedFor = user;
        if (ListThrows) throw new InvalidOperationException("no registry");
        Looks++;
        return Task.FromResult<IReadOnlyList<string>>(Looks > 1 && InstalledAfter != null ? InstalledAfter : Installed);
    }
    public Task DelayAsync(TimeSpan delay, CancellationToken ct) => Task.CompletedTask;
    public string CreateTempDir(string? readableBy) { TempFor = readableBy; return @"C:\fake\dir"; }
    public string? TempFor, ListedFor;
    public bool SignedIn = true, WingetMissing;
    public List<(string User, string File, string[] Args)> UserRuns = new();
    public Task<bool> IsUserSignedInAsync(string user, CancellationToken ct) => Task.FromResult(SignedIn);
    public Task<ProcessOutcome> RunAsUserAsync(string user, string file, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct)
    {
        UserRuns.Add((user, file, args.ToArray()));
        if (file == "winget.exe" && WingetMissing) return Task.FromResult(new ProcessOutcome(null, "", "", false, NotFound: true));
        return Task.FromResult(new ProcessOutcome(Exit, Stdout, "", false));
    }
    public void DeleteDir(string path) => Deleted = true;
}
