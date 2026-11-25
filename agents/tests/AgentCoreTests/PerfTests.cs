using System.Net.NetworkInformation;
using RemoteIQ.Agent.Linux;
using RemoteIQ.Agent.Shared;

/// <summary>
/// Network traffic and disk activity: the /proc parsers against realistic samples (samples/proc-*.txt), the adapter and disk
/// rules, the rate maths (first sample, reset, rollover, pauses) and the runner's wire format. No network and no processes.
/// </summary>
static class PerfTests
{
    static string[] Lines(string name) => File.ReadAllLines(Path.Combine(AppContext.BaseDirectory, "samples", name));

    public static async Task Run(Action<string, bool> Check)
    {
        // ── /proc/net/dev ────────────────────────────────────────────────
        var ubuntu = LinuxCheckProbes.ParseNetDev(Lines("proc-net-dev-ubuntu-docker.txt"));
        Check("net: ubuntu keeps only ens3 (lo, docker0, veth, br-, tun0 dropped)", ubuntu.Count == 1 && ubuntu[0].Name == "ens3");
        Check("net: ens3 rx and tx bytes are the 1st and 9th numbers", ubuntu[0].RxBytes == 987654321 && ubuntu[0].TxBytes == 123456789);

        var rocky = LinuxCheckProbes.ParseNetDev(Lines("proc-net-dev-rocky-wifi.txt"));
        Check("net: rocky keeps wlan0 and eth0 only (lo, eth0.100, virbr0, bond0, wg0 dropped)", rocky.Select(a => a.Name).OrderBy(x => x).SequenceEqual(new[] { "eth0", "wlan0" }));
        Check("net: a 64-bit counter near the limit parses", rocky.Single(a => a.Name == "wlan0").RxBytes == 18446744073709551000UL);
        Check("net: twelve digit counters parse", rocky.Single(a => a.Name == "eth0").TxBytes == 210987654321UL);

        var glued = LinuxCheckProbes.ParseNetDev(Lines("proc-net-dev-glued-and-broken.txt"));
        Check("net: a number right after the colon parses; short, headerless and vmbr0 lines are skipped", glued.Count == 1 && glued[0].Name == "eno1" && glued[0].RxBytes == 12345678 && glued[0].TxBytes == 87654321);
        Check("net: empty input gives nothing", LinuxCheckProbes.ParseNetDev(Array.Empty<string>()).Count == 0);

        foreach (var n in new[] { "eth0", "ens3", "enp5s0", "eno1", "wlan0", "wlp2s0", "enx001122334455", "em1", "p1p1", "ib0" })
            Check($"net: {n} counts", PerfFilters.IsPhysicalLinuxAdapter(n));
        foreach (var n in new[] { "lo", "docker0", "veth12ab", "br-0f1e", "br0", "virbr0", "vnet3", "tun0", "tap0", "wg0", "tailscale0", "zt5u4abc", "ppp0", "bond0", "eth0.100", "flannel.1", "cni0", "cali123", "kube-ipvs0", "vxlan0", "macvlan0", "vmbr0", "podman0" })
            Check($"net: {n} does not count", !PerfFilters.IsPhysicalLinuxAdapter(n));

        // ── Windows adapter rules ────────────────────────────────────────
        bool W(NetworkInterfaceType t, string name, string desc) => PerfFilters.IsPhysicalWindowsAdapter(t, name, desc);
        Check("net: Intel Ethernet counts", W(NetworkInterfaceType.Ethernet, "Ethernet", "Intel(R) Ethernet Connection (7) I219-V"));
        Check("net: Realtek gigabit counts", W(NetworkInterfaceType.GigabitEthernet, "Ethernet 2", "Realtek PCIe GbE Family Controller"));
        Check("net: Wi-Fi counts", W(NetworkInterfaceType.Wireless80211, "Wi-Fi", "Intel(R) Wi-Fi 6 AX201 160MHz"));
        Check("net: mobile broadband counts", W(NetworkInterfaceType.Wwanpp, "Cellular", "Sierra Wireless EM7455"));
        Check("net: a Hyper-V guest's synthetic adapter counts", W(NetworkInterfaceType.Ethernet, "Ethernet", "Microsoft Hyper-V Network Adapter"));
        Check("net: a VMware guest's vmxnet3 counts", W(NetworkInterfaceType.Ethernet, "Ethernet0", "vmxnet3 Ethernet Adapter"));
        Check("net: a VirtIO guest adapter counts", W(NetworkInterfaceType.Ethernet, "Ethernet", "Red Hat VirtIO Ethernet Adapter"));
        Check("net: loopback does not", !W(NetworkInterfaceType.Loopback, "Loopback Pseudo-Interface 1", "Software Loopback Interface 1"));
        Check("net: tunnels do not", !W(NetworkInterfaceType.Tunnel, "Teredo Tunneling Pseudo-Interface", "Teredo Tunneling Pseudo-Interface"));
        Check("net: PPP dial-up does not", !W(NetworkInterfaceType.Ppp, "VPN", "WAN Miniport (PPTP)"));
        Check("net: Hyper-V vEthernet does not", !W(NetworkInterfaceType.Ethernet, "vEthernet (Default Switch)", "Hyper-V Virtual Ethernet Adapter"));
        Check("net: VMware VMnet does not", !W(NetworkInterfaceType.Ethernet, "VMware Network Adapter VMnet8", "VMware Virtual Ethernet Adapter for VMnet8"));
        Check("net: VirtualBox host-only does not", !W(NetworkInterfaceType.Ethernet, "Ethernet 3", "VirtualBox Host-Only Ethernet Adapter"));
        Check("net: TAP (OpenVPN) does not", !W(NetworkInterfaceType.Ethernet, "Ethernet 4", "TAP-Windows Adapter V9"));
        Check("net: WireGuard does not", !W(NetworkInterfaceType.Ethernet, "wg0", "WireGuard Tunnel"));
        Check("net: Tailscale does not", !W(NetworkInterfaceType.Ethernet, "Tailscale", "Tailscale Tunnel"));
        Check("net: Bluetooth PAN does not", !W(NetworkInterfaceType.Ethernet, "Bluetooth Network Connection", "Bluetooth Device (Personal Area Network)"));
        Check("net: Wi-Fi Direct does not", !W(NetworkInterfaceType.Wireless80211, "Local Area Connection* 1", "Microsoft Wi-Fi Direct Virtual Adapter"));
        Check("net: Npcap loopback does not", !W(NetworkInterfaceType.Ethernet, "Npcap Loopback Adapter", "Npcap Loopback Adapter"));

        // ── Rates from counters ──────────────────────────────────────────
        const double Max = 900;
        var t = new CounterRateTracker();
        Check("rate: the first sample reports nothing", t.Update(new[] { ("a", 1000UL, 5000UL) }, 0, Max) is null);
        var r1 = t.Update(new[] { ("a", 4000UL, 8000UL) }, 300, Max);
        Check("rate: 3000 bytes in 300 s is 10 B/s (receive) and 10 B/s (send)", r1 is { A: 10, B: 10, Counted: 1, Skipped: 0 });
        var r2 = t.Update(new[] { ("a", 4000UL, 8000UL) }, 600, Max);
        Check("rate: an idle interval is a true zero", r2 is { A: 0, B: 0 });

        Check("rate: a counter that went down is skipped, not a spike", t.Update(new[] { ("a", 10UL, 20UL) }, 900, Max) is null);
        var r3 = t.Update(new[] { ("a", 610UL, 920UL) }, 1200, Max);
        Check("rate: after the reset the next interval is normal again", r3 is { A: 2, B: 3 });

        var m = new CounterRateTracker();
        m.Update(new[] { ("a", 0UL, 0UL), ("b", 0UL, 0UL) }, 0, Max);
        var mr = m.Update(new[] { ("a", 3000UL, 600UL), ("b", 0UL, 0UL) }, 300, Max);
        Check("rate: two adapters are summed", mr is { A: 10, B: 2, Counted: 2 });
        var m2 = m.Update(new[] { ("a", 6000UL, 1200UL), ("b", 50UL, 10UL), ("c", 999999UL, 999999UL) }, 600, Max);
        Check("rate: a new adapter is not counted until it has a previous value", m2 is { Counted: 2, Skipped: 1 });
        var m3 = m.Update(new[] { ("a", 9000UL, 1800UL), ("b", 5UL, 1UL), ("c", 1000999UL, 1000999UL) }, 900, Max);
        Check("rate: one adapter resetting does not hide the others", m3 is { Counted: 2, Skipped: 1 } && Math.Abs(m3.Value.A - (3000 + 1000) / 300.0) < 1e-9);
        Check("rate: an adapter that disappears is simply not counted", m.Update(new[] { ("a", 9300UL, 1900UL) }, 1200, Max) is { Counted: 1, A: 1 });

        var roll = new CounterRateTracker();
        roll.Update(new[] { ("a", ulong.MaxValue - 5, ulong.MaxValue - 5) }, 0, Max);
        Check("rate: 64-bit rollover is skipped", roll.Update(new[] { ("a", 100UL, 100UL) }, 300, Max) is null);

        var soon = new CounterRateTracker();
        soon.Update(new[] { ("a", 0UL, 0UL) }, 0, Max);
        Check("rate: a sample under 2 s after the last one is ignored", soon.Update(new[] { ("a", 5UL, 5UL) }, 1, Max) is null);
        Check("rate: the baseline kept is the older one", soon.Update(new[] { ("a", 3000UL, 3000UL) }, 300, Max) is { A: 10 });

        var gap = new CounterRateTracker();
        gap.Update(new[] { ("a", 0UL, 0UL) }, 0, Max);
        Check("rate: a long pause (a suspended machine) starts again", gap.Update(new[] { ("a", 99999999UL, 99999999UL) }, 30000, Max) is null);
        Check("rate: and the next interval is measured from there", gap.Update(new[] { ("a", 100000299UL, 100000299UL) }, 30300, Max) is { A: 1 });

        var none = new CounterRateTracker();
        none.Update(new[] { ("a", 0UL, 0UL) }, 0, Max);
        Check("rate: no adapter in common reports nothing", none.Update(new[] { ("z", 5UL, 5UL) }, 300, Max) is null);

        // ── /proc/diskstats ──────────────────────────────────────────────
        var sata = LinuxCheckProbes.ParseDiskStats(Lines("proc-diskstats-sata-nvme.txt"));
        Check("disk: sata + nvme keep sda and nvme0n1 only (partitions, loop, dm, md, ram, sr dropped)", sata.Select(d => d.Name).SequenceEqual(new[] { "sda", "nvme0n1" }));
        Check("disk: sectors are 512 bytes (sda read 9876543 sectors, wrote 7654321)", sata[0].ReadBytes == 9876543UL * 512 && sata[0].WriteBytes == 7654321UL * 512);
        Check("disk: nvme fields read from the same columns", sata[1].ReadBytes == 40000000UL * 512 && sata[1].WriteBytes == 30000000UL * 512);
        var vm = LinuxCheckProbes.ParseDiskStats(Lines("proc-diskstats-vm-old-kernel.txt"));
        Check("disk: the old 11 field format works; vda, vdb, xvda, mmcblk0 kept; partitions, loop, zram dropped", vm.Select(d => d.Name).OrderBy(x => x).SequenceEqual(new[] { "mmcblk0", "vda", "vdb", "xvda" }));
        Check("disk: empty and junk input give nothing", LinuxCheckProbes.ParseDiskStats(new[] { "", "garbage", "1 2 sda x y" }).Count == 0);
        foreach (var d in new[] { "sda", "sdb", "sdaa", "vda", "xvda", "hda", "nvme0n1", "nvme12n3", "mmcblk0" }) Check($"disk: {d} counts", PerfFilters.IsPhysicalLinuxDisk(d));
        foreach (var d in new[] { "sda1", "vda2", "nvme0n1p1", "mmcblk0p1", "loop0", "ram0", "dm-0", "md0", "sr0", "zram0", "nbd0", "fd0", "sdz12", "nvme0" }) Check($"disk: {d} does not count", !PerfFilters.IsPhysicalLinuxDisk(d));

        // ── The runner: wire format, no alert, first sample ──────────────
        var probes = new PerfProbes();
        var runner = Runner(probes);
        var net = new CheckDefinition { Key = "builtin:network", Type = "NETWORK", Name = "Network traffic" };
        var dio = new CheckDefinition { Key = "builtin:diskio", Type = "DISKIO", Name = "Disk activity" };
        var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));

        probes.Net = new NetworkSample(new[] { new NetworkAdapterSample("e", 1_000, 2_000, 1_000_000_000) });
        probes.Disk = new DiskIoReading(Devices: new[] { new DiskDeviceSample("sda", 10_000, 20_000) });
        Check("run: first network sample sends nothing", (await runner.ExecuteAsync(net, cts.Token)).Count == 0);
        Check("run: first disk sample sends nothing", (await runner.ExecuteAsync(dio, cts.Token)).Count == 0);

        // The runner reads a real clock, so make the second sample come after the 2 s minimum.
        await Task.Delay(2200, cts.Token);
        probes.Net = new NetworkSample(new[] { new NetworkAdapterSample("e", 1_000 + 22_000, 2_000 + 11_000, 1_000_000_000) });
        probes.Disk = new DiskIoReading(Devices: new[] { new DiskDeviceSample("sda", 10_000 + 44_000, 20_000 + 22_000) });
        var nr = (await runner.ExecuteAsync(net, cts.Token)).Single();
        var dr = (await runner.ExecuteAsync(dio, cts.Token)).Single();
        double Num(CheckRun r, string k) => Convert.ToDouble(r.Metrics![k], System.Globalization.CultureInfo.InvariantCulture);
        Check("run: network result is OK with no severity", nr is { Status: "OK", Severity: null, CheckType: "NETWORK", DedupeKey: "builtin:network" });
        Check($"run: network bytes per second are about 10000 and 5000 (got {Num(nr, "rxBytesPerSec")}, {Num(nr, "txBytesPerSec")})", Num(nr, "rxBytesPerSec") is > 5000 and < 11000 && Num(nr, "txBytesPerSec") is > 2500 and < 5500);
        Check("run: network carries the link speed in Mbps and the adapter count", Num(nr, "linkMbps") == 1000 && Num(nr, "adapters") == 1 && !nr.Metrics!.ContainsKey("thresholds"));
        Check("run: disk result is OK, no severity, no thresholds", dr is { Status: "OK", Severity: null, CheckType: "DISKIO", DedupeKey: "builtin:diskio" } && !dr.Metrics!.ContainsKey("thresholds"));
        Check($"run: disk read and write bytes per second are about 20000 and 10000 (got {Num(dr, "readBytesPerSec")}, {Num(dr, "writeBytesPerSec")})", Num(dr, "readBytesPerSec") is > 10000 and < 22000 && Num(dr, "writeBytesPerSec") is > 5000 and < 11000);
        Check("run: the output reads naturally", nr.Output!.StartsWith("Received ") && dr.Output!.StartsWith("Read "));

        probes.Disk = new DiskIoReading(Reason: "The PhysicalDisk performance counters are not available: category does not exist");
        var reason = (await runner.ExecuteAsync(dio, cts.Token)).Single();
        Check("run: a counter problem is an OK result with a reason, never a failure", reason is { Status: "OK", Severity: null } && reason.Metrics!["reason"].ToString()!.Contains("not available"));
        probes.Net = new NetworkSample(Array.Empty<NetworkAdapterSample>(), "No physical network adapter is up.");
        var noAdapter = (await runner.ExecuteAsync(net, cts.Token)).Single();
        Check("run: no adapter up is an OK result with a reason", noAdapter is { Status: "OK" } && noAdapter.Metrics!.ContainsKey("reason"));

        probes.Throw = true;
        var thrown = await runner.ExecuteAsync(net, cts.Token);
        Check("run: a probe that throws becomes an OK result with a reason, not an UNKNOWN or CRIT", thrown.Count == 1 && thrown[0].Status == "OK" && thrown[0].Severity is null && thrown[0].Metrics!.ContainsKey("reason"));
        probes.Throw = false;

        Check("defaults: network and disk activity are built in and have no thresholds",
            CheckEvaluation.Defaults(probes).Where(c => c.Type is "NETWORK" or "DISKIO").Select(c => (c.Key, c.Warn, c.Crit)).OrderBy(x => x.Key)
                .SequenceEqual(new (string, double?, double?)[] { ("builtin:diskio", null, null), ("builtin:network", null, null) }));
        Check("defaults: informational types are recognised", CheckEvaluation.IsInformational("network") && CheckEvaluation.IsInformational("DISKIO") && !CheckEvaluation.IsInformational("CPU"));

        // The interface's defaults keep an older probe class (one that knows nothing of these) working.
        var legacy = (ICheckProbes)new LegacyProbes();
        Check("compat: a probe without the new members reports unsupported, not a crash", legacy.ReadNetwork() is null && legacy.ReadDiskIo().Reason is not null);
    }

    static CheckRunner Runner(ICheckProbes probes) => new(probes, new CheckRunnerOptions
    {
        ApiBaseUrl = () => "http://127.0.0.1:9", Token = () => "t", AgentId = () => "a", DeviceId = () => "d", PublicKeyPem = () => "",
        Http = () => new HttpClient(), Log = _ => { }, CurrentVersion = "1.3.99", UpdateStateDir = Path.GetTempPath(),
    });

    sealed class PerfProbes : ICheckProbes
    {
        public NetworkSample? Net;
        public DiskIoReading Disk = new();
        public bool Throw;
        public CpuTimes? ReadCpuTimes() => null;
        public MemorySample? ReadMemory() => null;
        public IReadOnlyList<DiskSample> ReadDisks() => Array.Empty<DiskSample>();
        public ServiceSample ReadService(string name) => new(true, true, "");
        public IReadOnlyList<string>? ReadFailedServices() => null;
        public IReadOnlyList<CheckDefinition> PlatformDefaults() => Array.Empty<CheckDefinition>();
        public NetworkSample? ReadNetwork() => Throw ? throw new InvalidOperationException("boom") : Net;
        public DiskIoReading ReadDiskIo() => Disk;
    }

    sealed class LegacyProbes : ICheckProbes
    {
        public CpuTimes? ReadCpuTimes() => null;
        public MemorySample? ReadMemory() => null;
        public IReadOnlyList<DiskSample> ReadDisks() => Array.Empty<DiskSample>();
        public ServiceSample ReadService(string name) => new(true, true, "");
        public IReadOnlyList<string>? ReadFailedServices() => null;
        public IReadOnlyList<CheckDefinition> PlatformDefaults() => Array.Empty<CheckDefinition>();
    }
}
