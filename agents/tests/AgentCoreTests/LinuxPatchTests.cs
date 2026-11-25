using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RemoteIQ.Agent.Shared;

/// <summary>
/// Linux patching: the parsers against output captured from real apt, dnf and zypper (samples/), and the engine's
/// sequence of commands against a fake machine. Nothing here runs a package manager.
/// </summary>
static class LinuxPatchTests
{
    static string Sample(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "samples", name));

    // apt 2.4 format with a kernel, a security fix, a phased update and a kept-back package. Written by hand in the
    // format apt prints (the Ubuntu test machine had no kernel update pending when the real samples were taken).
    const string AptKernel = @"Reading package lists...
Building dependency tree...
Reading state information...
Calculating upgrade...
The following upgrades have been deferred due to phasing:
  python3-update-manager ubuntu-pro-client
The following packages have been kept back:
  linux-generic-hwe-22.04
The following NEW packages will be installed:
  linux-image-5.15.0-91-generic linux-modules-5.15.0-91-generic
The following packages will be upgraded:
  libssl3 linux-image-generic tzdata
3 upgraded, 2 newly installed, 0 to remove and 3 not upgraded.
Inst libssl3 [3.0.2-0ubuntu1.12] (3.0.2-0ubuntu1.13 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])
Inst tzdata [2023c-0ubuntu0.22.04.2] (2023d-0ubuntu0.22.04.1 Ubuntu:22.04/jammy-updates [all])
Inst linux-modules-5.15.0-91-generic (5.15.0-91.101 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])
Inst linux-image-5.15.0-91-generic (5.15.0-91.101 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])
Inst linux-image-generic [5.15.0.88.91] (5.15.0.91.89 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64]) []
Conf libssl3 (3.0.2-0ubuntu1.13 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])
";

    // The same listing on a German system: the package lines are identical, the explanatory lines are not.
    const string AptGerman = @"Paketlisten werden gelesen...
Abhängigkeitsbaum wird aufgebaut...
Statusinformationen werden eingelesen...
Aktualisierung wird berechnet...
Die folgenden Pakete werden zurückgehalten:
  libc6
Die folgenden Pakete werden aktualisiert:
  tzdata
Inst tzdata [2023c-0ubuntu0.22.04.2] (2023d-0ubuntu0.22.04.1 Ubuntu:22.04/jammy-updates [all])
";

    const string AptDebianSecurity = @"Inst libssl3 [3.0.9-1] (3.0.11-1~deb12u2 Debian-Security:12/stable-security [amd64])
Inst vim-tiny [2:9.0.1378-2] (2:9.0.1378-2+deb12u1 Debian:12.2/stable [amd64])
Remv oldlib [1.0]
";

    sealed class FakeHost : ILinuxPatchHost
    {
        public HashSet<string> Commands = new();
        public Dictionary<string, string> Files = new();
        public Dictionary<string, string> Texts = new();
        public List<string> Calls = new();
        public List<TimeSpan> Delays = new();
        public Func<string, string[], PatchProcResult?>? Handler;

        public bool HasCommand(string name) => Commands.Contains(name);
        public string? ReadText(string path) => Texts.GetValueOrDefault(path);
        public bool FileExists(string path) => Files.ContainsKey(path) || Texts.ContainsKey(path);
        public Task DelayAsync(TimeSpan delay, CancellationToken ct) { Delays.Add(delay); return Task.CompletedTask; }

        public Task<PatchProcResult> RunAsync(string file, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct)
        {
            var a = args.ToArray();
            Calls.Add(file + " " + string.Join(' ', a));
            return Task.FromResult(Handler?.Invoke(file, a) ?? new PatchProcResult(0, "", "", false));
        }
    }

    static PatchProcResult Ok(string stdout = "") => new(0, stdout, "", false);

    public static async Task Run(Action<string, bool> Check)
    {
        // ── apt parsing, real output ───────────────────────────────────────
        var real = LinuxPatchParsers.ParseAptSimulation(Sample("apt-ubuntu2204-upgrades.txt"));
        Check("apt real: the upgrades on Ubuntu 22.04 are found", real.Upgrades.Count >= 1 && real.Upgrades.All(u => u.Current is not null) && real.Upgrades.Any(u => u.Name == "libc6"));
        Check("apt real: a security archive is recognised", real.Upgrades.Where(u => u.Name == "libc6").All(u => LinuxPatchParsers.AptOriginIsSecurity(u.Origins)));
        Check("apt real: Conf lines are not counted", real.Upgrades.Select(u => u.Name).Distinct().Count() == real.Upgrades.Count);

        var none = LinuxPatchParsers.ParseAptSimulation(Sample("apt-debian12-none.txt"));
        Check("apt real: Debian 12 with nothing to install is an empty list", none.Upgrades.Count == 0 && none.NewInstalls.Count == 0 && none.KeptBack.Count == 0);

        var held = LinuxPatchParsers.ParseAptSimulation(Sample("apt-ubuntu2204-held.txt"));
        Check("apt real: held packages appear as kept back and never as upgrades", held.Upgrades.Count == 0 && held.KeptBack.SequenceEqual(new[] { "libc-bin", "libc6" }));

        // ── apt parsing, kernel, phasing, localisation ─────────────────────
        var k = LinuxPatchParsers.ParseAptSimulation(AptKernel);
        Check("apt: upgrades are the installed packages with a new version", k.Upgrades.Select(u => u.Name).SequenceEqual(new[] { "libssl3", "tzdata", "linux-image-generic" }));
        Check("apt: the new kernel is a new install, not an upgrade", k.NewInstalls.Any(n => n.Name == "linux-image-5.15.0-91-generic"));
        Check("apt: phased updates are listed separately", k.Phased.SequenceEqual(new[] { "python3-update-manager", "ubuntu-pro-client" }));
        Check("apt: kept back packages are listed", k.KeptBack.SequenceEqual(new[] { "linux-generic-hwe-22.04" }));
        Check("apt: current and available versions are read", k.Upgrades[0].Current == "3.0.2-0ubuntu1.12" && k.Upgrades[0].Available == "3.0.2-0ubuntu1.13");
        Check("apt: a package from -updates only is not security", !LinuxPatchParsers.AptOriginIsSecurity(k.Upgrades[1].Origins));
        Check("apt: a trailing [] after the origin is tolerated", k.Upgrades[2].Name == "linux-image-generic" && k.Upgrades[2].Available == "5.15.0.91.89");

        var de = LinuxPatchParsers.ParseAptSimulation(AptGerman);
        Check("apt: a German listing still yields the packages", de.Upgrades.Count == 1 && de.Upgrades[0].Name == "tzdata");
        Check("apt: German explanatory lines are ignored, not mistaken for packages", de.KeptBack.Count == 0 && de.Phased.Count == 0);

        var deb = LinuxPatchParsers.ParseAptSimulation(AptDebianSecurity);
        Check("apt: Debian-Security:12/stable-security is a security origin", LinuxPatchParsers.AptOriginIsSecurity(deb.Upgrades[0].Origins) && !LinuxPatchParsers.AptOriginIsSecurity(deb.Upgrades[1].Origins));
        Check("apt: Remv lines are reported", deb.Removals.SequenceEqual(new[] { "oldlib" }));
        Check("apt: ESM security archives count", LinuxPatchParsers.AptOriginIsSecurity("UbuntuESM:20.04/focal-infra-security"));
        Check("apt: empty and null input do not fail", LinuxPatchParsers.ParseAptSimulation("").Upgrades.Count == 0 && LinuxPatchParsers.ParseAptSimulation(null!).Upgrades.Count == 0);

        // ── dnf / yum parsing, real output ─────────────────────────────────
        var fed = LinuxPatchParsers.ParseCheckUpdate(Sample("dnf-fedora40-check-update.txt"));
        Check("dnf real: Fedora 40 lists its updates", fed.Count >= 30 && fed.Any(u => u.Id == "glibc.x86_64" && u.Repo == "updates"));
        Check("dnf real: noarch packages keep their arch", fed.Any(u => u.Id == "tzdata.noarch"));
        Check("dnf real: an epoch stays part of the version", fed.Any(u => u.Name == "openssl-libs" && u.Available == "1:3.2.4-1.fc40"));
        var fedSec = LinuxPatchParsers.ParseCheckUpdate(Sample("dnf-fedora40-check-update-security.txt")).Select(u => u.Id).ToHashSet();
        Check("dnf real: --security lists a subset", fedSec.Count > 0 && fedSec.Count < fed.Count && fedSec.IsSubsetOf(fed.Select(u => u.Id)));
        var rocky = LinuxPatchParsers.ParseCheckUpdate(Sample("dnf-rocky9-check-update.txt"));
        Check("dnf real: Rocky 9 lists baseos updates", rocky.Count > 50 && rocky.All(u => u.Repo.Length > 0));
        Check("dnf: a leading blank line and the metadata line are skipped", LinuxPatchParsers.ParseCheckUpdate("Last metadata expiration check: 0:00:12 ago on Fri Nov 13.\n\nfoo.x86_64   1.0-1.fc40   updates\n").Count == 1);
        Check("dnf: Obsoleting Packages are not updates", LinuxPatchParsers.ParseCheckUpdate("a.x86_64 1-1 r\n\nObsoleting Packages\nb.x86_64 2-1 r\n    c.x86_64 1-1 r\n").Select(u => u.Name).SequenceEqual(new[] { "a" }));
        Check("yum: a long name wrapped onto its own line is joined", LinuxPatchParsers.ParseCheckUpdate("some-very-long-package-name-here.noarch\n          1.2.3-4.el7        updates\n").Single().Name == "some-very-long-package-name-here");
        Check("dnf: garbage lines are ignored", LinuxPatchParsers.ParseCheckUpdate("Error: Failed to download metadata\nwarning: something odd\n").Count == 0);

        var info = LinuxPatchParsers.ParseUpdateInfo(Sample("dnf-rocky9-updateinfo.txt"));
        Check("dnf real: Rocky advisories carry severity", info.Any(a => a.Kind == "security" && a.Severity == "Critical") && info.Any(a => a.Kind == "bugfix" && a.Severity is null));
        Check("dnf real: advisory names and arches are split from the NEVRA", info.Any(a => a.Name == "binutils-gold" && a.Arch == "x86_64"));
        var finfo = LinuxPatchParsers.ParseUpdateInfo(Sample("dnf-fedora40-updateinfo.txt"));
        Check("dnf real: Fedora advisories parse the same way", finfo.Any(a => a.Id.StartsWith("FEDORA-") && a.Kind == "security" && a.Severity == "Moderate") && finfo.Any(a => a.Kind == "enhancement"));
        Check("dnf: a package name containing hyphens and digits is split correctly", LinuxPatchParsers.ParseUpdateInfo("RLSA-2024:1 Important/Sec. python3-libs-3.9.18-3.el9_4.5.x86_64").Single() is { Name: "python3-libs", Arch: "x86_64", Severity: "Important" });

        var inst = LinuxPatchParsers.ParseInstalled(Sample("rpm-rocky9-installed.txt"));
        Check("rpm real: installed versions include the epoch and release", inst.TryGetValue("libgcc.x86_64", out var libgcc) && libgcc.Contains('-'));

        // ── zypper parsing, real output ────────────────────────────────────
        var patches = LinuxPatchParsers.ParseZypperPatches(Sample("zypper-leap16-list-patches.xml"));
        Check("zypper real: Leap 16 patches are read with category and severity", patches.Count == 2 && patches.All(p => p.Category == "recommended" && p.Severity == "Moderate" && !p.Restart && !p.Interactive));
        Check("zypper real: the summary is read", patches[0].Summary.StartsWith("Recommended update for"));
        Check("zypper real: no patches is an empty list even with warnings around it", LinuxPatchParsers.ParseZypperPatches(Sample("zypper-leap156-none.xml")).Count == 0);
        var sec = LinuxPatchParsers.ParseZypperPatches("<?xml version='1.0'?><stream><update-status version=\"0.6\"><update-list>" +
            "<update kind=\"patch\" name=\"SUSE-SU-2024:1\" edition=\"1\" status=\"needed\" category=\"security\" severity=\"important\" pkgmanager=\"false\" restart=\"true\" interactive=\"false\"><summary>Security update for the Linux Kernel</summary></update>" +
            "<update kind=\"patch\" name=\"SUSE-SU-2024:2\" edition=\"1\" status=\"needed\" category=\"security\" severity=\"unspecified\" restart=\"false\" interactive=\"true\"><summary>License needed</summary></update>" +
            "<update kind=\"patch\" name=\"SUSE-SU-2024:3\" edition=\"1\" status=\"unneeded\" category=\"security\" severity=\"low\"><summary>Not for this machine</summary></update>" +
            "</update-list></update-status></stream>");
        Check("zypper: restart and interactive flags are read", sec.Count == 2 && sec[0].Restart && sec[1].Interactive && sec[1].Severity is null);
        Check("zypper: patches that are not needed are left out", sec.All(p => p.Name != "SUSE-SU-2024:3"));
        Check("zypper: broken XML is an empty list, not a crash", LinuxPatchParsers.ParseZypperPatches("<?xml version='1.0'?><stream><update").Count == 0 && LinuxPatchParsers.ParseZypperPatches("not xml").Count == 0);

        // ── names that reach a command line ────────────────────────────────
        Check("ids: package names pass", new[] { "libc6", "libstdc++6", "python3.10", "libc6:i386", "foo.x86_64", "openSUSE-SLE-15.6-2024-1", "x_y" }.All(LinuxPatchParsers.IsSafeId));
        Check("ids: options and shell characters are rejected", new[] { "-y", "--force", "a b", "a;rm", "$(x)", "a&b", "", "a\nb", "`x`", "a/b" }.All(i => !LinuxPatchParsers.IsSafeId(i)));
        Check("output is shortened keeping the end", LinuxPatchParsers.Truncate(new string('a', 100) + "END", 40).EndsWith("END") && LinuxPatchParsers.Truncate(new string('a', 100) + "END", 40).Contains("shortened") && LinuxPatchParsers.Truncate("short") == "short");

        // ── detection ──────────────────────────────────────────────────────
        LinuxPackageManager DetectWith(string osId, params string[] cmds)
        {
            var h = new FakeHost { Texts = { ["/etc/os-release"] = $"NAME=x\nID={osId}\n" } };
            foreach (var c in cmds) h.Commands.Add(c);
            return LinuxPatchEngine.Detect(h, out _);
        }
        Check("detect: apt-get with dpkg is apt", DetectWith("ubuntu", "apt-get", "dpkg") == LinuxPackageManager.Apt);
        Check("detect: dnf is preferred over yum", DetectWith("rocky", "dnf", "yum", "rpm") == LinuxPackageManager.Dnf);
        Check("detect: yum alone is yum", DetectWith("centos", "yum", "rpm") == LinuxPackageManager.Yum);
        Check("detect: zypper on Leap is zypper", DetectWith("opensuse-leap", "zypper", "rpm") == LinuxPackageManager.Zypper);

        var hostApk = new FakeHost { Texts = { ["/etc/os-release"] = "ID=alpine\n" }, Commands = { "apk" } };
        Check("detect: Alpine is refused and apk is named", LinuxPatchEngine.Detect(hostApk, out var apkWhy) == LinuxPackageManager.None && apkWhy.Contains("alpine") && apkWhy.Contains("apk"));
        var hostArch = new FakeHost { Texts = { ["/etc/os-release"] = "ID=arch\n" }, Commands = { "pacman" } };
        Check("detect: Arch is refused and pacman is named", LinuxPatchEngine.Detect(hostArch, out var archWhy) == LinuxPackageManager.None && archWhy.Contains("pacman"));
        var hostTw = new FakeHost { Texts = { ["/etc/os-release"] = "ID=\"opensuse-tumbleweed\"\n" }, Commands = { "zypper" } };
        Check("detect: Tumbleweed is refused with the reason", LinuxPatchEngine.Detect(hostTw, out var twWhy) == LinuxPackageManager.None && twWhy.Contains("Tumbleweed"));
        var hostNone = new FakeHost();
        Check("detect: nothing known is refused", LinuxPatchEngine.Detect(hostNone, out var noneWhy) == LinuxPackageManager.None && noneWhy.Contains("No supported package manager"));
        var refused = false;
        try { await new LinuxPatchEngine(hostApk).ScanAsync(false, CancellationToken.None); } catch (LinuxPatchException e) { refused = e.Message.Contains("apk"); }
        Check("scan on Alpine fails cleanly without running anything", refused && hostApk.Calls.Count == 0);

        // ── apt engine ─────────────────────────────────────────────────────
        FakeHost AptHost(string simulation, string holds = "", bool updateFails = false)
        {
            var h = new FakeHost { Texts = { ["/etc/os-release"] = "ID=ubuntu\n" }, Commands = { "apt-get", "dpkg", "apt-mark" } };
            h.Handler = (f, a) =>
            {
                if (f == "apt-get" && a[0] == "update") return updateFails ? new PatchProcResult(100, "", "E: Failed to fetch", false) : Ok("Reading package lists...");
                if (f == "apt-get" && a.Contains("-s")) return Ok(simulation);
                if (f == "apt-mark") return Ok(holds);
                return Ok();
            };
            return h;
        }

        var host = AptHost(AptKernel);
        var scan = await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None);
        Check("apt scan: refreshes the lists first, then simulates", host.Calls[0].StartsWith("apt-get update") && host.Calls[1].Contains("-s") && host.Calls[1].Contains("dist-upgrade") && host.Calls[1].Contains("--no-remove"));
        Check("apt scan: upgrades and the new kernel are patches", scan.Patches.Select(p => p.Id).OrderBy(x => x).SequenceEqual(new[] { "libssl3", "linux-image-5.15.0-91-generic", "linux-image-generic", "tzdata" }));
        Check("apt scan: security flag follows the archive", scan.Patches.Single(p => p.Id == "libssl3").Security && !scan.Patches.Single(p => p.Id == "tzdata").Security);
        Check("apt scan: security updates are rated Important, others have no rating", scan.Patches.Single(p => p.Id == "libssl3").Severity == "Important" && scan.Patches.Single(p => p.Id == "tzdata").Severity is null);
        Check("apt scan: a new kernel needs a restart and says so", scan.Patches.Single(p => p.Id == "linux-image-5.15.0-91-generic").RequiresReboot);
        Check("apt scan: dependency packages are not listed as patches", scan.Patches.All(p => p.Id != "linux-modules-5.15.0-91-generic"));
        Check("apt scan: phased and kept back packages are reported as skipped", scan.Skipped.Any(s => s.Id == "ubuntu-pro-client" && s.Reason.Contains("phased")) && scan.Skipped.Any(s => s.Id == "linux-generic-hwe-22.04" && s.Reason.Contains("kept back")));
        Check("apt scan: versions are reported", scan.Patches.Single(p => p.Id == "libssl3") is { Current: "3.0.2-0ubuntu1.12", Available: "3.0.2-0ubuntu1.13" });

        host = AptHost(Sample("apt-ubuntu2204-held.txt"), "libc-bin\nlibc6\n");
        scan = await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None);
        Check("apt scan: held packages are not patches and are reported as held", scan.Patches.Count == 0 && scan.Skipped.Count(s => s.Reason == "held") == 2 && !scan.Skipped.Any(s => s.Reason.Contains("kept back")));

        host = AptHost(Sample("apt-debian12-none.txt"));
        scan = await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None);
        Check("apt scan: nothing to update is a clean empty scan", scan.Patches.Count == 0 && scan.Skipped.Count == 0 && !scan.RebootRequired);

        host = AptHost(AptGerman);
        scan = await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None);
        Check("apt scan: a localised listing still produces the patch", scan.Patches.Single().Id == "tzdata");

        host = AptHost(AptKernel, updateFails: true);
        scan = await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None);
        Check("apt scan: a failed refresh is noted but the scan still reports", scan.Patches.Count > 0 && scan.Log.Contains("may be out of date"));

        host = AptHost(AptKernel); host.Texts["/var/run/reboot-required"] = ""; host.Texts["/var/run/reboot-required.pkgs"] = "linux-image-5.15.0-91-generic\nlinux-base\n";
        scan = await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None);
        Check("apt scan: /var/run/reboot-required means a restart is needed, with the packages", scan.RebootRequired && scan.RebootReason!.Contains("linux-image-5.15.0-91-generic"));

        var failSim = AptHost("");
        failSim.Handler = (f, a) => f == "apt-get" && a.Contains("-s") ? new PatchProcResult(100, "", "E: Unable to correct problems, you have held broken packages.", false) : Ok();
        var failed = "";
        try { await new LinuxPatchEngine(failSim).ScanAsync(false, CancellationToken.None); } catch (LinuxPatchException e) { failed = e.Message; }
        Check("apt scan: a failing simulation says why", failed.Contains("held broken packages"));

        // ── apt install ────────────────────────────────────────────────────
        host = AptHost(AptKernel);
        var installed = false;
        host.Handler = (f, a) =>
        {
            if (f == "apt-get" && a[0] == "update") return Ok();
            if (f == "apt-get" && a.Contains("install")) { installed = true; return Ok("done"); }
            if (f == "apt-get" && a.Contains("-s")) return Ok(installed ? "Reading package lists...\n" : AptKernel);
            return Ok();
        };
        var res = await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Ids = new[] { "libssl3", "tzdata", "nonexistent", "ubuntu-pro-client" } }, CancellationToken.None);
        var installCall = host.Calls.Single(c => c.Contains(" install "));
        Check("apt install: selected packages are installed by name, non-interactively, without removals", installCall.Contains("-y") && installCall.Contains("--no-remove") && installCall.Contains("force-confold") && installCall.EndsWith("install libssl3 tzdata"));
        Check("apt install: waits for the dpkg lock itself", installCall.Contains("DPkg::Lock::Timeout=300"));
        Check("apt install: ids that are not on offer are skipped with the reason, never installed", !installCall.Contains("nonexistent") && !installCall.Contains("ubuntu-pro-client") && res.Skipped.Any(s => s.Id == "nonexistent" && s.Reason.Contains("no update")) && res.Skipped.Any(s => s.Id == "ubuntu-pro-client" && s.Reason.Contains("phased")));
        Check("apt install: installed means no longer on offer afterwards", res.Ok && res.Installed.OrderBy(x => x).SequenceEqual(new[] { "libssl3", "tzdata" }) && res.Failed.Count == 0);

        host = AptHost(AptKernel);
        host.Handler = (f, a) => f == "apt-get" && a.Contains("-s") ? Ok(AptKernel) : f == "apt-mark" ? Ok("") : Ok();
        res = await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Ids = new[] { "tzdata" } }, CancellationToken.None);
        Check("apt install: an update that is still on offer afterwards is reported failed", !res.Ok && res.Failed.SequenceEqual(new[] { "tzdata" }) && res.Message.Contains("not installed"));

        host = AptHost(AptKernel, holds: "tzdata\n");
        host.Handler = (f, a) => f == "apt-get" && a.Contains("-s") ? Ok(AptKernel) : f == "apt-mark" ? Ok("tzdata\n") : Ok();
        res = await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Ids = new[] { "tzdata" } }, CancellationToken.None);
        Check("apt install: a held package named explicitly is not installed over its hold", !host.Calls.Any(c => c.Contains(" install ")) && res.Skipped.Any(s => s.Id == "tzdata" && s.Reason.Contains("held")));

        host = AptHost(AptKernel);
        host.Handler = (f, a) => f == "apt-get" && a.Contains("-s") ? Ok(AptKernel) : Ok();
        res = await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Mode = "security" }, CancellationToken.None);
        installCall = host.Calls.Single(c => c.Contains(" install "));
        Check("apt install: security mode installs only the security updates", installCall.Contains("libssl3") && installCall.Contains("linux-image-5.15.0-91-generic") && !installCall.Contains("tzdata"));

        host = AptHost(AptKernel);
        res = await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Mode = "all" }, CancellationToken.None);
        Check("apt install: all mode is one dist-upgrade that never removes packages", host.Calls.Count(c => c.Contains("dist-upgrade") && !c.Contains(" -s ")) == 1 && host.Calls.Single(c => c.Contains("dist-upgrade") && !c.Contains(" -s ")).Contains("--no-remove"));

        var bad = "";
        try { await new LinuxPatchEngine(AptHost(AptKernel)).InstallAsync(new LinuxInstallRequest { Ids = new[] { "--allow-unauthenticated" } }, CancellationToken.None); } catch (LinuxPatchException e) { bad = e.Message; }
        Check("install: an id that looks like an option is refused before anything runs", bad.Contains("not a valid"));
        bad = "";
        try { await new LinuxPatchEngine(AptHost(AptKernel)).InstallAsync(new LinuxInstallRequest(), CancellationToken.None); } catch (LinuxPatchException e) { bad = e.Message; }
        Check("install: selected mode needs ids", bad.Contains("ids is required"));
        bad = "";
        try { await new LinuxPatchEngine(AptHost(AptKernel)).InstallAsync(new LinuxInstallRequest { Mode = "everything" }, CancellationToken.None); } catch (LinuxPatchException e) { bad = e.Message; }
        Check("install: an unknown mode is refused", bad.Contains("Unknown install mode"));

        host = AptHost(Sample("apt-debian12-none.txt"));
        res = await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Mode = "all" }, CancellationToken.None);
        Check("install: nothing on offer installs nothing and succeeds", res.Ok && !host.Calls.Any(c => c.Contains(" install ") || (c.Contains("dist-upgrade") && !c.Contains(" -s "))) && res.Message.Contains("Nothing to install"));

        // ── locks ──────────────────────────────────────────────────────────
        host = AptHost(AptKernel);
        var lockCount = 0;
        host.Handler = (f, a) =>
        {
            if (f == "apt-get" && a[0] == "update" && lockCount++ < 2) return new PatchProcResult(100, "", "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 1234 (apt-get)", false);
            if (f == "apt-get" && a.Contains("-s")) return Ok(AptKernel);
            return Ok();
        };
        var eng = new LinuxPatchEngine(host);
        scan = await eng.ScanAsync(false, CancellationToken.None);
        Check("lock: a held package lock is waited for and retried", lockCount == 3 && host.Delays.Count == 2 && scan.Patches.Count > 0 && scan.Log.Contains("waiting"));

        host = AptHost(AptKernel);
        host.Handler = (f, a) => f == "apt-get" && a[0] == "update" ? new PatchProcResult(100, "", "E: Could not get lock /var/lib/dpkg/lock-frontend", false) : Ok(AptKernel);
        eng = new LinuxPatchEngine(host) { LockWait = TimeSpan.FromSeconds(45), LockRetryEvery = TimeSpan.FromSeconds(15) };
        var lockMsg = "";
        try { await eng.ScanAsync(false, CancellationToken.None); } catch (LinuxPatchException e) { lockMsg = e.Message; }
        Check("lock: a lock held too long gives a plain message after the wait", lockMsg.Contains("held the package lock") && host.Delays.Count == 3);

        // ── dnf engine ─────────────────────────────────────────────────────
        FakeHost DnfHost(string osId = "fedora")
        {
            var h = new FakeHost { Texts = { ["/etc/os-release"] = $"ID={osId}\n" }, Commands = { "dnf", "rpm" } };
            h.Handler = (f, a) =>
            {
                if (f == "dnf" && a.Contains("check-update") && a.Contains("--security")) return Ok(Sample("dnf-fedora40-check-update-security.txt"));
                if (f == "dnf" && a.Contains("check-update")) return Ok(Sample("dnf-fedora40-check-update.txt"));
                if (f == "dnf" && a.Contains("updateinfo")) return Ok(Sample("dnf-fedora40-updateinfo.txt"));
                if (f == "dnf" && a.Contains("versionlock")) return Ok("Last metadata expiration check: 0:00:01 ago.\nkernel-core-0:6.8.5-301.fc40.*\n");
                if (f == "rpm" && a.Contains("-qa")) return Ok("glibc.x86_64 2.39-22.fc40\nopenssl-libs.x86_64 1:3.2.1-2.fc40\n");
                return Ok();
            };
            return h;
        }
        host = DnfHost();
        scan = await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None);
        Check("dnf scan: patches come from check-update", scan.Patches.Count == fed.Count && scan.Patches.Any(p => p.Id == "glibc.x86_64"));
        Check("dnf scan: the security flag comes from check-update --security", scan.Patches.Count(p => p.Security) == fedSec.Count && scan.Patches.Single(p => p.Id == "openssl-libs.x86_64").Security);
        Check("dnf scan: severity comes from the advisory, security without a rating is Important", scan.Patches.Single(p => p.Id == "dnf.noarch").Severity == "Moderate" && scan.Patches.Where(p => p.Security).All(p => p.Severity is not null) && scan.Patches.Where(p => !p.Security).All(p => p.Severity is null));
        Check("dnf scan: advisory ids are kept", scan.Patches.Single(p => p.Id == "dnf.noarch").Advisories.Contains("FEDORA-2025-21c36b3aa5"));
        Check("dnf scan: the installed version is reported", scan.Patches.Single(p => p.Id == "glibc.x86_64").Current == "2.39-22.fc40" && scan.Patches.Single(p => p.Id == "glibc.x86_64").RequiresReboot);
        Check("dnf scan: version-locked packages are reported as held", scan.Skipped.Any(s => s.Id == "kernel-core" && s.Reason.Contains("held")));
        Check("dnf scan: exit code 100 from check-update is success", (await new LinuxPatchEngine(HostWith100()).ScanAsync(false, CancellationToken.None)).Patches.Count == fed.Count);

        FakeHost HostWith100()
        {
            var h = DnfHost();
            var inner = h.Handler!;
            h.Handler = (f, a) => inner(f, a) is { } r && a.Contains("check-update") ? r with { ExitCode = 100 } : inner(f, a);
            return h;
        }

        host = DnfHost();
        host.Handler = (f, a) => f == "dnf" && a.Contains("check-update") ? Ok("") : Ok();
        scan = await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None);
        Check("dnf scan: nothing to update is an empty scan", scan.Patches.Count == 0);

        host = DnfHost();
        host.Handler = (f, a) => f == "dnf" && a.Contains("check-update") && !a.Contains("--security") ? new PatchProcResult(1, "", "Error: Failed to download metadata for repo 'updates'", false) : Ok();
        var dnfErr = "";
        try { await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None); } catch (LinuxPatchException e) { dnfErr = e.Message; }
        Check("dnf scan: an error from dnf is reported with its text", dnfErr.Contains("Failed to download metadata"));

        host = DnfHost("rocky");
        host.Handler = (f, a) => f == "needs-restarting" || (f == "dnf" && a.Contains("needs-restarting")) ? new PatchProcResult(1, "Core libraries or services have been updated since boot-up:\n  * glibc\n\nReboot is required to fully utilize these updates.", "", false) : Ok();
        host.Commands.Add("needs-restarting");
        var (needed, why) = await new LinuxPatchEngine(host).RebootNeeded(LinuxPackageManager.Dnf, CancellationToken.None);
        Check("dnf reboot: needs-restarting -r exit 1 means restart", needed && why is not null);
        host.Handler = (f, a) => new PatchProcResult(0, "No core libraries or services have been updated since boot-up.\nReboot should not be necessary.", "", false);
        Check("dnf reboot: needs-restarting -r exit 0 means no restart", !(await new LinuxPatchEngine(host).RebootNeeded(LinuxPackageManager.Dnf, CancellationToken.None)).Needed);

        host = DnfHost("rocky");
        host.Commands.Add("uname");
        host.Handler = (f, a) => f == "uname" ? Ok("5.14.0-362.8.1.el9_3.x86_64\n") : f == "rpm" && a.Contains("kernel-core") ? Ok("1700000000 5.14.0-362.8.1.el9_3.x86_64\n1710000000 5.14.0-427.13.1.el9_4.x86_64\n") : Ok();
        (needed, why) = await new LinuxPatchEngine(host).RebootNeeded(LinuxPackageManager.Dnf, CancellationToken.None);
        Check("dnf reboot: without needs-restarting, a newer installed kernel than the running one means restart", needed && why!.Contains("427.13.1"));
        host.Handler = (f, a) => f == "uname" ? Ok("5.14.0-427.13.1.el9_4.x86_64\n") : f == "rpm" && a.Contains("kernel-core") ? Ok("1710000000 5.14.0-427.13.1.el9_4.x86_64\n") : Ok();
        Check("dnf reboot: the running kernel being the newest means no restart", !(await new LinuxPatchEngine(host).RebootNeeded(LinuxPackageManager.Dnf, CancellationToken.None)).Needed);

        host = DnfHost("rocky");
        host.Commands.Add("uname");
        host.Handler = (f, a) => f == "dnf" && a.Contains("needs-restarting") ? new PatchProcResult(1, "", "No such command: needs-restarting. Please use /usr/bin/dnf --help", false) : f == "uname" ? Ok("5.14.0-427.13.1.el9_4.x86_64\n") : f == "rpm" && a.Contains("kernel-core") ? Ok("1710000000 5.14.0-427.13.1.el9_4.x86_64\n") : Ok();
        Check("dnf reboot: the 'no such command' error of a missing plugin is not a restart", !(await new LinuxPatchEngine(host).RebootNeeded(LinuxPackageManager.Dnf, CancellationToken.None)).Needed);

        // installs
        host = DnfHost();
        var dnfDone = false;
        var baseHandler = host.Handler!;
        host.Handler = (f, a) =>
        {
            if (f == "dnf" && a.Contains("upgrade")) { dnfDone = true; return Ok("Complete!"); }
            if (f == "dnf" && a.Contains("check-update") && dnfDone) return Ok("");
            return baseHandler(f, a);
        };
        res = await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Ids = new[] { "glibc.x86_64", "tzdata.noarch" } }, CancellationToken.None);
        var up = host.Calls.Single(c => c.StartsWith("dnf -y upgrade"));
        Check("dnf install: selected packages are upgraded by name.arch with -y", up == "dnf -y upgrade glibc.x86_64 tzdata.noarch");
        Check("dnf install: success is the updates leaving the list", res.Ok && res.Installed.Count == 2);

        host = DnfHost();
        res = await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Mode = "security" }, CancellationToken.None);
        Check("dnf install: security mode uses --security", host.Calls.Any(c => c == "dnf -y upgrade --security") && !res.Ok);
        host = DnfHost();
        res = await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Mode = "all" }, CancellationToken.None);
        Check("dnf install: all mode is a plain upgrade (version locks and excludes stay in force)", host.Calls.Any(c => c == "dnf -y upgrade") && !host.Calls.Any(c => c.Contains("disableexcludes")));

        host = new FakeHost { Texts = { ["/etc/os-release"] = "ID=centos\n" }, Commands = { "yum", "rpm" } };
        host.Handler = (f, a) => f == "yum" && a.Contains("check-update") ? Ok("openssl.x86_64 1:1.0.2k-26.el7_9 updates\n") : Ok();
        scan = await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None);
        Check("yum scan: uses yum --security for the flag", scan.Patches.Single().Id == "openssl.x86_64" && host.Calls.Any(c => c == "yum -q --security check-update"));

        // ── zypper engine ──────────────────────────────────────────────────
        FakeHost ZypperHost(string patchesXml)
        {
            var h = new FakeHost { Texts = { ["/etc/os-release"] = "ID=\"opensuse-leap\"\n" }, Commands = { "zypper", "rpm" } };
            h.Handler = (f, a) => f == "zypper" && a.Contains("list-patches") ? Ok(patchesXml) : Ok();
            return h;
        }
        host = ZypperHost(Sample("zypper-leap16-list-patches.xml"));
        scan = await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None);
        Check("zypper scan: refreshes, then lists patches", host.Calls[0].Contains("refresh") && host.Calls[1].Contains("list-patches") && scan.Patches.Count == 2);
        Check("zypper scan: a recommended patch is not security and keeps its rating", scan.Patches.All(p => !p.Security && p.Severity == "Moderate") && scan.Patches[0].Id == "openSUSE-Leap-16.0-1126");
        Check("zypper scan: --with-optional only when asked", !host.Calls[1].Contains("--with-optional") && (await ScanCalls(true)).Contains("--with-optional"));
        async Task<string> ScanCalls(bool optional) { var h = ZypperHost(Sample("zypper-leap156-none.xml")); await new LinuxPatchEngine(h).ScanAsync(optional, CancellationToken.None); return h.Calls[1]; }

        host = ZypperHost("<?xml version='1.0'?><stream><update-status version=\"0.6\"><update-list>" +
            "<update kind=\"patch\" name=\"SUSE-SU-2024:1\" edition=\"1\" status=\"needed\" category=\"security\" severity=\"critical\" restart=\"true\" interactive=\"false\"><summary>Kernel</summary></update>" +
            "<update kind=\"patch\" name=\"SUSE-SU-2024:2\" edition=\"1\" status=\"needed\" category=\"security\" severity=\"unspecified\" restart=\"false\" interactive=\"true\"><summary>Licence</summary></update>" +
            "</update-list></update-status></stream>");
        scan = await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None);
        Check("zypper scan: a security patch is flagged, rated, and needs a restart", scan.Patches.Single() is { Id: "SUSE-SU-2024:1", Security: true, Severity: "Critical", RequiresReboot: true });
        Check("zypper scan: a patch that needs a person is skipped with the reason", scan.Skipped.Single() is { Id: "SUSE-SU-2024:2" } s2 && s2.Reason.Contains("person"));

        host = ZypperHost(Sample("zypper-leap156-none.xml"));
        scan = await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None);
        Check("zypper scan: no patches is an empty scan", scan.Patches.Count == 0);

        host = ZypperHost(Sample("zypper-leap16-list-patches.xml"));
        var zdone = false;
        host.Handler = (f, a) => f == "zypper" && a.Contains("install") ? Do() : f == "zypper" && a.Contains("list-patches") ? Ok(zdone ? "<?xml version='1.0'?><stream><update-status version=\"0.6\"><update-list></update-list></update-status></stream>" : Sample("zypper-leap16-list-patches.xml")) : f == "zypper" && a.Contains("needs-rebooting") ? new PatchProcResult(102, "", "", false) : Ok();
        PatchProcResult Do() { zdone = true; return Ok("Overall download size"); }
        res = await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Ids = new[] { "openSUSE-Leap-16.0-1126" } }, CancellationToken.None);
        Check("zypper install: selected patches are installed as patches, non-interactively", host.Calls.Any(c => c == "zypper --non-interactive install -t patch openSUSE-Leap-16.0-1126"));
        Check("zypper install: success and the restart from needs-rebooting (exit 102)", res.Ok && res.Installed.Count == 1 && res.RebootRequired);

        host = ZypperHost(Sample("zypper-leap16-list-patches.xml"));
        res = await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Mode = "security" }, CancellationToken.None);
        Check("zypper install: security mode with nothing security installs nothing", res.Ok && !host.Calls.Any(c => c.Contains("patch --category")));
        host = ZypperHost("<?xml version='1.0'?><stream><update-status version=\"0.6\"><update-list><update kind=\"patch\" name=\"SUSE-SU-2024:1\" edition=\"1\" status=\"needed\" category=\"security\" severity=\"critical\" restart=\"false\" interactive=\"false\"><summary>K</summary></update></update-list></update-status></stream>");
        await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Mode = "security" }, CancellationToken.None);
        Check("zypper install: security mode is patch --category security", host.Calls.Any(c => c == "zypper --non-interactive patch --category security"));
        await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Mode = "all" }, CancellationToken.None);
        Check("zypper install: all mode is zypper patch", host.Calls.Any(c => c == "zypper --non-interactive patch"));

        host = ZypperHost(Sample("zypper-leap16-list-patches.xml"));
        var attempts = 0;
        host.Handler = (f, a) => f == "zypper" && a.Contains("list-patches") ? Ok(Sample("zypper-leap16-list-patches.xml")) : f == "zypper" && a.Contains("install") ? (attempts++ == 0 ? new PatchProcResult(103, "", "", false) : Ok()) : Ok();
        await new LinuxPatchEngine(host).InstallAsync(new LinuxInstallRequest { Ids = new[] { "openSUSE-Leap-16.0-1126" } }, CancellationToken.None);
        Check("zypper install: exit 103 (zypper updated itself) runs the install again", attempts == 2);

        host = ZypperHost(Sample("zypper-leap16-list-patches.xml"));
        host.Handler = (f, a) => f == "zypper" && a.Contains("install") ? new PatchProcResult(7, "", "System management is locked by the application with pid 99 (zypper).", false) : f == "zypper" && a.Contains("list-patches") ? Ok(Sample("zypper-leap16-list-patches.xml")) : Ok();
        var zl = "";
        try { await new LinuxPatchEngine(host) { LockWait = TimeSpan.FromSeconds(30), LockRetryEvery = TimeSpan.FromSeconds(15) }.InstallAsync(new LinuxInstallRequest { Ids = new[] { "openSUSE-Leap-16.0-1126" } }, CancellationToken.None); } catch (LinuxPatchException e) { zl = e.Message; }
        Check("zypper install: a zypper lock is waited for, then reported", zl.Contains("package lock"));

        // ── signed tasks ───────────────────────────────────────────────────
        using var key = RSA.Create(2048);
        using var other = RSA.Create(2048);
        var pem = key.ExportSubjectPublicKeyInfoPem();
        (string Payload, string Sig) Seal(object contents, string agentId, long? iat = null, RSA? signer = null)
        {
            var dict = JsonSerializer.Deserialize<Dictionary<string, object?>>(JsonSerializer.Serialize(contents))!;
            dict["agentId"] = agentId;
            dict["iat"] = iat ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var bytes = JsonSerializer.SerializeToUtf8Bytes(dict);
            var sig = (signer ?? key).SignData(bytes, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
            return (Convert.ToBase64String(bytes), Convert.ToBase64String(sig));
        }
        var now = DateTimeOffset.UtcNow;
        var good = Seal(new { taskId = "t1", type = "patch_install", payload = new { ids = new[] { "libssl3" }, mode = "selected", includeOptional = true, timeoutSec = 900 } }, "agent-1");
        Check("task: a signed task for this agent opens", AgentTaskEnvelope.TryOpen(good.Payload, good.Sig, pem, "agent-1", "t1", "patch_install", now, out var opened, out _) && opened!.ReadStrings("ids").SequenceEqual(new[] { "libssl3" }) && opened.ReadString("mode") == "selected" && opened.ReadBool("includeOptional") && opened.ReadInt("timeoutSec") == 900);
        Check("task: the agent id is compared without regard to case", AgentTaskEnvelope.TryOpen(good.Payload, good.Sig, pem, "AGENT-1", "t1", "patch_install", now, out _, out _));
        Check("task: another agent's task is refused", !AgentTaskEnvelope.TryOpen(good.Payload, good.Sig, pem, "agent-2", "t1", "patch_install", now, out _, out var r1) && r1.Contains("different agent"));
        var forged = Seal(new { taskId = "t1", type = "patch_install", payload = new { ids = new[] { "x" } } }, "agent-1", signer: other);
        Check("task: a signature from another key is refused", !AgentTaskEnvelope.TryOpen(forged.Payload, forged.Sig, pem, "agent-1", "t1", "patch_install", now, out _, out var r2) && r2.Contains("invalid"));
        var stale = Seal(new { taskId = "t1", type = "patch_scan", payload = new { } }, "agent-1", iat: now.AddMinutes(-30).ToUnixTimeMilliseconds());
        Check("task: an old signature is refused", !AgentTaskEnvelope.TryOpen(stale.Payload, stale.Sig, pem, "agent-1", "t1", "patch_scan", now, out _, out var r3) && r3.Contains("expired"));
        Check("task: the unsigned id and type must match the signed ones", !AgentTaskEnvelope.TryOpen(good.Payload, good.Sig, pem, "agent-1", "t2", "patch_install", now, out _, out _) && !AgentTaskEnvelope.TryOpen(good.Payload, good.Sig, pem, "agent-1", "t1", "patch_scan", now, out _, out _));
        Check("task: tampered payload bytes are refused", !AgentTaskEnvelope.TryOpen(Convert.ToBase64String(Encoding.UTF8.GetBytes("{\"taskId\":\"t1\"}")), good.Sig, pem, "agent-1", "t1", "patch_install", now, out _, out _));
        Check("task: no key, no signature and garbage are refused without throwing", !AgentTaskEnvelope.TryOpen(good.Payload, good.Sig, "", "agent-1", "t1", "patch_install", now, out _, out _) && !AgentTaskEnvelope.TryOpen(null, null, pem, "agent-1", "t1", "patch_install", now, out _, out _) && !AgentTaskEnvelope.TryOpen("!!!", "???", pem, "agent-1", "t1", "patch_install", now, out _, out _));

        // ── what is reported back ──────────────────────────────────────────
        host = AptHost(AptKernel);
        scan = await new LinuxPatchEngine(host).ScanAsync(false, CancellationToken.None);
        var json = JsonSerializer.Serialize(LinuxPatchReport.ScanArtifacts(scan), new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        using var art = JsonDocument.Parse(json);
        var first = art.RootElement.GetProperty("patches")[0];
        Check("report: patches keep the fields the server already reads", first.TryGetProperty("id", out _) && first.TryGetProperty("title", out _) && first.TryGetProperty("severity", out _) && first.TryGetProperty("requiresReboot", out _) && first.TryGetProperty("kbIds", out _));
        Check("report: and the Linux fields", first.GetProperty("security").ValueKind == JsonValueKind.True && first.GetProperty("current").GetString() == "3.0.2-0ubuntu1.12" && art.RootElement.GetProperty("packageManager").GetString() == "apt" && art.RootElement.GetProperty("skipped").GetArrayLength() == 3);
        Check("report: the stdout starts with a one-line summary", LinuxPatchReport.ScanStdout(scan).StartsWith("Found 4 available update(s), 3 of them security updates (apt)."));
    }
}
