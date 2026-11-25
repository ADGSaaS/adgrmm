using System.Diagnostics;
using RemoteIQ.Agent.Shared;

namespace RemoteIQ.Agent.Linux;

public sealed class LinuxCheckProbes : ICheckProbes
{
    // Packages and containers mount many small read-only filesystems that are always full.
    private static readonly HashSet<string> Pseudo = new(StringComparer.OrdinalIgnoreCase)
    {
        "tmpfs", "devtmpfs", "overlay", "squashfs", "proc", "sysfs", "cgroup", "cgroup2", "devpts",
        "autofs", "nsfs", "tracefs", "efivarfs", "iso9660", "ramfs", "fuse.snapfuse",
    };

    public CpuTimes? ReadCpuTimes()
    {
        try
        {
            var line = File.ReadLines("/proc/stat").FirstOrDefault(l => l.StartsWith("cpu "));
            return line is null ? null : ParseProcStat(line);
        }
        catch
        {
            return null;
        }
    }

    public static CpuTimes? ParseProcStat(string line)
    {
        // user nice system idle iowait irq softirq steal; guest time is already counted in user.
        var f = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (f.Length < 5) return null;

        ulong total = 0;
        for (var i = 1; i < Math.Min(f.Length, 9); i++)
        {
            if (!ulong.TryParse(f[i], out var v)) return null;
            total += v;
        }

        var idle = ulong.Parse(f[4]) + (f.Length > 5 && ulong.TryParse(f[5], out var wait) ? wait : 0);
        return new CpuTimes(idle, total);
    }

    public MemorySample? ReadMemory()
    {
        try
        {
            return ParseMemInfo(File.ReadLines("/proc/meminfo"));
        }
        catch
        {
            return null;
        }
    }

    public static MemorySample? ParseMemInfo(IEnumerable<string> lines)
    {
        long total = 0, available = -1;
        foreach (var line in lines)
        {
            var f = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (f.Length < 2 || !long.TryParse(f[1], out var kb)) continue;
            if (f[0] == "MemTotal:") total = kb * 1024;
            else if (f[0] == "MemAvailable:") available = kb * 1024;
        }
        return total > 0 && available >= 0 ? new MemorySample(total, available) : null;
    }

    public IReadOnlyList<DiskSample> ReadDisks()
    {
        var disks = new List<DiskSample>();
        foreach (var d in DriveInfo.GetDrives())
        {
            try
            {
                if (!d.IsReady || d.TotalSize <= 0 || d.DriveType != DriveType.Fixed || Pseudo.Contains(d.DriveFormat)) continue;
                disks.Add(new DiskSample(d.Name, d.TotalSize, d.AvailableFreeSpace));
            }
            catch
            {
                // skip mounts that cannot be read
            }
        }
        return disks;
    }

    public ServiceSample ReadService(string name)
    {
        if (!LinuxInit.IsSystemd && LinuxInit.IsOpenRc)
        {
            // OpenRC (Alpine): "rc-service NAME status" says started, stopped or crashed.
            if (!LinuxInit.IsPlainServiceName(name) || !File.Exists($"/etc/init.d/{name}")) return new ServiceSample(false, false, "not found");
            var (rc, text) = Run("rc-service", name, "status");
            var lower = text.ToLowerInvariant();
            var state = lower.Contains("crashed") ? "failed" : lower.Contains("started") && rc == 0 ? "active" : "inactive";
            return new ServiceSample(true, state == "active", state);
        }

        var (code, stdout) = Run("systemctl", "show", "--property=LoadState,ActiveState", "--value", "--", name);
        var lines = stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        if (code != 0 || lines.Length == 0 || lines[0].Trim() == "not-found") return new ServiceSample(false, false, "not found");

        var active = lines.Length > 1 ? lines[1].Trim() : "unknown";
        return new ServiceSample(true, active == "active", active);
    }

    public IReadOnlyList<string>? ReadFailedServices()
    {
        if (!LinuxInit.IsSystemd && LinuxInit.IsOpenRc)
        {
            var (rcCode, rcOut) = Run("rc-status", "--crashed");
            if (rcCode != 0) return null;
            // each line looks like " sshd   [ crashed ]"
            return rcOut.Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .Select(l => l.Trim().Split(' ', 2)[0])
                .Where(LinuxInit.IsPlainServiceName)
                .ToList();
        }

        var (code, stdout) = Run("systemctl", "list-units", "--state=failed", "--no-legend", "--plain", "--no-pager");
        if (code != 0) return null;
        return stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Split(' ', 2)[0])
            .ToList();
    }

    // ── Network: /proc/net/dev ────────────────────────────────────────────
    public NetworkSample? ReadNetwork()
    {
        try
        {
            var adapters = ParseNetDev(File.ReadLines("/proc/net/dev"))
                .Where(a => !IsKernelVirtual(a.Name))
                .Select(a => a with { LinkBitsPerSec = ReadLinkSpeed(a.Name) })
                .ToList();
            return new NetworkSample(adapters, adapters.Count == 0 ? "No physical network adapter was found." : null);
        }
        catch (Exception ex)
        {
            return new NetworkSample(Array.Empty<NetworkAdapterSample>(), "/proc/net/dev could not be read: " + ex.Message);
        }
    }

    /// <summary>
    /// The adapters in /proc/net/dev that pass the name rules (PerfFilters.IsPhysicalLinuxAdapter), with cumulative bytes.
    /// Lines are "  eth0: rx_bytes rx_packets ... (8 receive fields) tx_bytes ..."; the number may follow the colon directly.
    /// </summary>
    public static IReadOnlyList<NetworkAdapterSample> ParseNetDev(IEnumerable<string> lines)
    {
        var list = new List<NetworkAdapterSample>();
        foreach (var line in lines)
        {
            var colon = line.IndexOf(':');
            if (colon <= 0) continue; // the two header lines have no interface name
            var name = line[..colon].Trim();
            if (!PerfFilters.IsPhysicalLinuxAdapter(name)) continue;

            var f = line[(colon + 1)..].Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (f.Length < 9 || !ulong.TryParse(f[0], out var rx) || !ulong.TryParse(f[8], out var tx)) continue;
            list.Add(new NetworkAdapterSample(name, rx, tx, 0));
        }
        return list;
    }

    // The kernel lists bridges, veth, tunnels, VLANs and bonds under /devices/virtual/; real hardware lives under /devices/pci... or similar.
    private static bool IsKernelVirtual(string name)
    {
        try
        {
            var target = new DirectoryInfo("/sys/class/net/" + name).LinkTarget;
            return target is not null && target.Contains("/devices/virtual/", StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    private static long ReadLinkSpeed(string name)
    {
        try
        {
            // Megabits per second; -1 (or an error) when the link is down or the driver does not say.
            return long.TryParse(File.ReadAllText($"/sys/class/net/{name}/speed").Trim(), out var mbit) && mbit > 0 ? mbit * 1_000_000 : 0;
        }
        catch
        {
            return 0;
        }
    }

    // ── Disk activity: /proc/diskstats ────────────────────────────────────
    public DiskIoReading ReadDiskIo()
    {
        try
        {
            var devices = ParseDiskStats(File.ReadLines("/proc/diskstats"));
            return devices.Count == 0 ? new DiskIoReading(Reason: "No physical disk was found in /proc/diskstats.") : new DiskIoReading(Devices: devices);
        }
        catch (Exception ex)
        {
            return new DiskIoReading(Reason: "/proc/diskstats could not be read: " + ex.Message);
        }
    }

    /// <summary>
    /// Whole physical disks only (PerfFilters.IsPhysicalLinuxDisk), with cumulative bytes. Fields are
    /// "major minor name reads reads_merged sectors_read ms writes writes_merged sectors_written ..."; a sector is always 512 bytes here.
    /// </summary>
    public static IReadOnlyList<DiskDeviceSample> ParseDiskStats(IEnumerable<string> lines)
    {
        var list = new List<DiskDeviceSample>();
        foreach (var line in lines)
        {
            var f = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (f.Length < 10 || !PerfFilters.IsPhysicalLinuxDisk(f[2])) continue;
            if (!ulong.TryParse(f[5], out var sectorsRead) || !ulong.TryParse(f[9], out var sectorsWritten)) continue;
            list.Add(new DiskDeviceSample(f[2], unchecked(sectorsRead * 512UL), unchecked(sectorsWritten * 512UL)));
        }
        return list;
    }

    public IReadOnlyList<CheckDefinition> PlatformDefaults() => new[]
    {
        // Distributions share no common unit name, so a named default would fail on many machines.
        new CheckDefinition
        {
            Key = "builtin:service:failed",
            Type = "SERVICE",
            Name = "Systemd units",
            Service = CheckEvaluation.FailedUnitsService,
            DownStatus = "WARN",
        },
    };

    private static (int Code, string Stdout) Run(string file, params string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo(file)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);

            using var p = Process.Start(psi)!;
            var stderr = p.StandardError.ReadToEndAsync();
            var stdout = p.StandardOutput.ReadToEndAsync();
            if (!p.WaitForExit(15_000))
            {
                try { p.Kill(entireProcessTree: true); } catch { /* already gone */ }
                return (-1, "");
            }
            return (p.ExitCode, stdout.GetAwaiter().GetResult());
        }
        catch
        {
            return (-1, "");
        }
    }
}
