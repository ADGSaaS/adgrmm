using System.Net.NetworkInformation;
using System.Text.RegularExpressions;

namespace RemoteIQ.Agent.Shared;

// Network traffic and disk activity: informational measurements that feed the device performance graphs.
//
// Wire format (check results, metrics jsonb), ONE unit: bytes per second, as numbers rounded to whole bytes.
//   NETWORK  key builtin:network  { rxBytesPerSec, txBytesPerSec, intervalSec, adapters, linkMbps? }
//   DISKIO   key builtin:diskio   { readBytesPerSec, writeBytesPerSec, intervalSec, devices? }
// A run that has no numbers carries { reason } instead. These results always have status OK and no severity:
// they have no thresholds and must never raise an alert (the server ignores them for alerting as well).

/// <summary>Cumulative byte counters for one network adapter, as the OS reports them.</summary>
public readonly record struct NetworkAdapterSample(string Name, ulong RxBytes, ulong TxBytes, long LinkBitsPerSec);

/// <summary>The adapters that count (real, up, not virtual) with their cumulative counters, or why there are none.</summary>
public sealed record NetworkSample(IReadOnlyList<NetworkAdapterSample> Adapters, string? Reason = null);

/// <summary>Cumulative sector-derived byte counters for one physical disk.</summary>
public readonly record struct DiskDeviceSample(string Name, ulong ReadBytes, ulong WriteBytes);

/// <summary>
/// What a probe knows about disk activity. Exactly one form is used:
/// Devices (cumulative counters, the runner works out the rate), Rates (the probe kept its own previous sample),
/// Reason (nothing can be measured here), or none of them (the first sample, which only sets the baseline).
/// </summary>
public sealed record DiskIoReading(
    IReadOnlyList<DiskDeviceSample>? Devices = null,
    double? ReadBytesPerSec = null,
    double? WriteBytesPerSec = null,
    string? Reason = null);

/// <summary>The average rate of two counters over one interval, summed over every item that could be compared.</summary>
public readonly record struct CounterRate(double A, double B, int Counted, int Skipped, double Seconds);

/// <summary>
/// Turns cumulative counters into a rate, keeping the previous sample in memory.
/// The first sample has no previous value and reports nothing. An item whose counter went down (reset, rollover,
/// a driver reloaded) or that was not in the previous sample is skipped for that interval instead of being
/// reported as a huge spike. A sample that comes too soon after the last one is ignored (the baseline stays),
/// and one that comes after a long pause, such as a sleeping laptop, starts again rather than being averaged over the pause.
/// </summary>
public sealed class CounterRateTracker
{
    public const double MinIntervalSeconds = 2;

    private Dictionary<string, (ulong A, ulong B)>? _prev;
    private double _prevAt;

    public CounterRate? Update(IEnumerable<(string Name, ulong A, ulong B)> current, double nowSeconds, double maxIntervalSeconds)
    {
        var cur = new Dictionary<string, (ulong A, ulong B)>(StringComparer.Ordinal);
        foreach (var c in current) cur[c.Name] = (c.A, c.B);

        var prev = _prev;
        var dt = nowSeconds - _prevAt;
        if (prev is not null && dt < MinIntervalSeconds) return null;

        _prev = cur;
        _prevAt = nowSeconds;
        if (prev is null || dt > maxIntervalSeconds || dt <= 0) return null;

        ulong a = 0, b = 0;
        var counted = 0;
        var skipped = 0;
        foreach (var (name, now) in cur)
        {
            if (!prev.TryGetValue(name, out var before) || now.A < before.A || now.B < before.B) { skipped++; continue; }
            a += now.A - before.A;
            b += now.B - before.B;
            counted++;
        }
        return counted == 0 ? null : new CounterRate(a / dt, b / dt, counted, skipped, dt);
    }

    public void Reset() { _prev = null; }
}

/// <summary>Which adapters and disks count. The rules are documented here once and used by both agents.</summary>
public static class PerfFilters
{
    // ── Network, Linux (/proc/net/dev names) ──────────────────────────────
    // Besides this list, the Linux probe drops anything the kernel files under /devices/virtual/ (bridges, veth,
    // tunnels, VLANs, bonds). The names matter for the same decision where /sys cannot be read.
    private static readonly Regex LinuxVirtualName = new(
        @"^(lo|docker\d*|veth.*|br-.*|br\d+|virbr.*|vnet.*|tun\d*|tap.*|wg\d*|tailscale.*|zt.*|ppp\d*|dummy.*|bond.*|team\d*|" +
        @"flannel.*|cni.*|cali.*|kube.*|lxc.*|lxd.*|ifb.*|sit\d*|gre.*|gretap.*|ip6tnl.*|ip6gre.*|vxlan.*|macvlan.*|macvtap.*|ipvlan.*|nlmon.*|" +
        @"podman.*|vmbr\d*|vmnet.*|vboxnet.*|wwan\d+-.*|teredo.*|.+\..+)$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>
    /// A name that is a real adapter by its name alone. Loopback, containers (docker, veth, podman, cni, flannel, calico),
    /// bridges (br0, br-..., virbr), tunnels and VPNs (tun, tap, wg, tailscale, zerotier, ppp), bonds (the slaves are counted
    /// instead, so nothing is counted twice) and VLAN sub-interfaces (eth0.100, counted in eth0) are not.
    /// </summary>
    public static bool IsPhysicalLinuxAdapter(string name) => !string.IsNullOrWhiteSpace(name) && !LinuxVirtualName.IsMatch(name.Trim());

    // ── Network, Windows (NetworkInterface) ───────────────────────────────
    private static readonly string[] WindowsVirtualWords =
    {
        "virtual", "vethernet", "hyper-v virtual", "vmware", "virtualbox", "vbox", "parallels", "tap-windows", "tap-", "wintun", "wireguard",
        "tailscale", "zerotier", "openvpn", "vpn", "anyconnect", "globalprotect", "npcap", "loopback", "bluetooth", "wi-fi direct",
        "wan miniport", "teredo", "isatap", "6to4", "pseudo", "docker", "wsl", "kernel debug", "miniport", "multiplexor", "packet scheduler",
        "lightweight filter", "tunnel", "fortinet", "sonicwall", "pangp", "juniper", "nordlynx", "proton",
    };

    /// <summary>
    /// A real adapter by type and name. Ethernet and Wi-Fi (and mobile broadband) count. Loopback, tunnels, PPP/VPN dial-up,
    /// and anything whose name or description says it is virtual (Hyper-V vEthernet, VMware VMnet, VirtualBox host-only, TAP/Wintun/WireGuard,
    /// Tailscale, ZeroTier, Npcap, Bluetooth, Wi-Fi Direct, WAN Miniport, Teredo, ISATAP) do not. A Hyper-V guest's own
    /// "Microsoft Hyper-V Network Adapter" and a VMware guest's vmxnet3 are the guest's real network, so they count.
    /// </summary>
    public static bool IsPhysicalWindowsAdapter(NetworkInterfaceType type, string name, string description)
    {
        switch (type)
        {
            case NetworkInterfaceType.Ethernet:
            case NetworkInterfaceType.GigabitEthernet:
            case NetworkInterfaceType.FastEthernetFx:
            case NetworkInterfaceType.FastEthernetT:
            case NetworkInterfaceType.Ethernet3Megabit:
            case NetworkInterfaceType.Wireless80211:
            case NetworkInterfaceType.Wman:
            case NetworkInterfaceType.Wwanpp:
            case NetworkInterfaceType.Wwanpp2:
                break;
            default:
                return false;
        }

        var text = ((name ?? "") + " | " + (description ?? "")).ToLowerInvariant();
        foreach (var w in WindowsVirtualWords)
            if (text.Contains(w, StringComparison.Ordinal)) return false;
        return true;
    }

    // ── Disks, Linux (/proc/diskstats names) ──────────────────────────────
    // Whole physical devices only: sda, vda, xvda, hda, nvme0n1, mmcblk0. Partitions (sda1, nvme0n1p1, mmcblk0p1) would count
    // the same bytes twice, and loop, ram, zram, dm-* (LVM/crypt sit on top of physical disks), md* (RAID), sr (optical),
    // nbd and fd are not physical disks or double count.
    private static readonly Regex LinuxWholeDisk = new(
        @"^(sd[a-z]{1,2}|hd[a-z]|vd[a-z]{1,2}|xvd[a-z]{1,2}|nvme\d+n\d+|mmcblk\d+)$",
        RegexOptions.CultureInvariant);

    public static bool IsPhysicalLinuxDisk(string name) => LinuxWholeDisk.IsMatch(name ?? "");
}
