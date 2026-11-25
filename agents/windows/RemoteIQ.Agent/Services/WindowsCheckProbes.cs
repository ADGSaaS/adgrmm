using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using RemoteIQ.Agent.Shared;

namespace RemoteIQ.Agent.Services;

public sealed class WindowsCheckProbes : ICheckProbes
{
    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;
        public readonly ulong Value => ((ulong)High << 32) | Low;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemTimes(out FileTime idle, out FileTime kernel, out FileTime user);

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx status);

    public CpuTimes? ReadCpuTimes()
    {
        if (!GetSystemTimes(out var idle, out var kernel, out var user)) return null;

        // Kernel time already includes idle time.
        return new CpuTimes(idle.Value, kernel.Value + user.Value);
    }

    public MemorySample? ReadMemory()
    {
        var status = new MemoryStatusEx { Length = (uint)Marshal.SizeOf<MemoryStatusEx>() };
        if (!GlobalMemoryStatusEx(ref status)) return null;
        return new MemorySample((long)status.TotalPhys, (long)status.AvailPhys);
    }

    public IReadOnlyList<DiskSample> ReadDisks()
    {
        var disks = new List<DiskSample>();
        foreach (var d in DriveInfo.GetDrives())
        {
            try
            {
                // Removable and network drives come and go, which would only make noise.
                if (d.DriveType != DriveType.Fixed || !d.IsReady || d.TotalSize <= 0) continue;
                disks.Add(new DiskSample(d.Name, d.TotalSize, d.TotalFreeSpace));
            }
            catch
            {
                // skip drives that cannot be read
            }
        }
        return disks;
    }

    public ServiceSample ReadService(string name)
    {
        try
        {
            using var sc = new ServiceController(name);
            var status = sc.Status;
            return new ServiceSample(true, status == ServiceControllerStatus.Running, status.ToString());
        }
        catch (InvalidOperationException)
        {
            return new ServiceSample(false, false, "not found");
        }
    }

    public IReadOnlyList<string>? ReadFailedServices() => null;

    // ── Network: cumulative counters, no performance counters and no WMI ──────
    public NetworkSample? ReadNetwork()
    {
        var adapters = new List<NetworkAdapterSample>();
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            try
            {
                if (nic.OperationalStatus != OperationalStatus.Up) continue;
                if (!PerfFilters.IsPhysicalWindowsAdapter(nic.NetworkInterfaceType, nic.Name, nic.Description)) continue;
                var stats = nic.GetIPStatistics();
                var speed = 0L;
                try { speed = nic.Speed; } catch { /* some drivers cannot say */ }
                adapters.Add(new NetworkAdapterSample(nic.Id, (ulong)Math.Max(0, stats.BytesReceived), (ulong)Math.Max(0, stats.BytesSent), speed));
            }
            catch
            {
                // an adapter that vanished while being read
            }
        }
        return new NetworkSample(adapters, adapters.Count == 0 ? "No physical network adapter is up." : null);
    }

    // ── Disk activity: PhysicalDisk performance counters, _Total instance ─────
    private static readonly TimeSpan CounterTimeBox = TimeSpan.FromSeconds(8);
    private readonly object _diskLock = new();
    private PerformanceCounter? _readCounter;
    private PerformanceCounter? _writeCounter;
    private CounterSample _readPrev;
    private CounterSample _writePrev;
    private bool _haveBaseline;
    private DateTimeOffset _diskRetryAt = DateTimeOffset.MinValue;
    private string? _diskProblem;

    /// <summary>
    /// The average over the whole time since the previous reading: CounterSample.Calculate(previous, current), with the previous
    /// sample kept here. The first reading only sets the baseline. A machine whose counters are missing or damaged reports a
    /// reason and is tried again later; every call into the counter library is time-boxed so it cannot stall the check loop.
    /// </summary>
    public DiskIoReading ReadDiskIo()
    {
        if (!Monitor.TryEnter(_diskLock)) return new DiskIoReading(Reason: "The previous disk activity reading has not finished.");
        try
        {
            if (DateTimeOffset.UtcNow < _diskRetryAt) return new DiskIoReading(Reason: _diskProblem ?? "Disk activity counters are not available.");

            if (_readCounter is null || _writeCounter is null)
            {
                if (!Bounded(() =>
                    {
                        _readCounter = new PerformanceCounter("PhysicalDisk", "Disk Read Bytes/sec", "_Total", true);
                        _writeCounter = new PerformanceCounter("PhysicalDisk", "Disk Write Bytes/sec", "_Total", true);
                        _readPrev = _readCounter.NextSample();
                        _writePrev = _writeCounter.NextSample();
                        return true;
                    }, out _, out var why))
                {
                    return Fail("The PhysicalDisk performance counters are not available: " + why);
                }
                _haveBaseline = true;
                return new DiskIoReading();
            }

            if (!Bounded(() => (_readCounter.NextSample(), _writeCounter.NextSample()), out var cur, out var problem))
                return Fail("Reading the PhysicalDisk performance counters failed: " + problem);

            var read = CounterSample.Calculate(_readPrev, cur.Item1);
            var write = CounterSample.Calculate(_writePrev, cur.Item2);
            _readPrev = cur.Item1;
            _writePrev = cur.Item2;

            if (!_haveBaseline) { _haveBaseline = true; return new DiskIoReading(); }
            // A counter that restarted or a clock step gives nothing sensible: skip this interval instead of reporting it.
            if (!double.IsFinite(read) || !double.IsFinite(write) || read < 0 || write < 0) return new DiskIoReading();
            return new DiskIoReading(ReadBytesPerSec: read, WriteBytesPerSec: write);
        }
        finally
        {
            Monitor.Exit(_diskLock);
        }
    }

    private DiskIoReading Fail(string reason)
    {
        _readCounter?.Dispose();
        _writeCounter?.Dispose();
        _readCounter = _writeCounter = null;
        _haveBaseline = false;
        _diskProblem = reason;
        // Counters that are damaged stay damaged, so look again only now and then.
        _diskRetryAt = DateTimeOffset.UtcNow.AddMinutes(30);
        return new DiskIoReading(Reason: reason);
    }

    private static bool Bounded<T>(Func<T> work, out T result, out string reason)
    {
        result = default!;
        reason = "";
        var task = Task.Run(work);
        try
        {
            if (!task.Wait(CounterTimeBox)) { reason = $"no answer within {CounterTimeBox.TotalSeconds:0} seconds"; return false; }
            result = task.Result;
            return true;
        }
        catch (AggregateException ex)
        {
            reason = ex.GetBaseException().Message;
            return false;
        }
    }

    public IReadOnlyList<CheckDefinition> PlatformDefaults() => new[]
    {
        // Chosen because Windows does not work properly without them and they are always set to run.
        new CheckDefinition { Key = "builtin:service:eventlog", Type = "SERVICE", Name = "Service: Windows Event Log", Service = "EventLog" },
        new CheckDefinition { Key = "builtin:service:winmgmt", Type = "SERVICE", Name = "Service: Windows Management Instrumentation", Service = "Winmgmt" },
        new CheckDefinition { Key = "builtin:service:dnscache", Type = "SERVICE", Name = "Service: DNS Client", Service = "Dnscache" },
    };
}
