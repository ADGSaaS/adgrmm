// agents/windows/RemoteIQ.CaptureHelper/DesktopState.cs

using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;

internal sealed record MonitorRect(int Left, int Top, int Width, int Height, bool Primary);

/// <summary>
/// Which monitor is being shown. Capture and input both read it here, so a click always lands
/// on the picture the technician is looking at, whatever the display scaling or layout.
/// </summary>
internal sealed class DesktopState
{
    private readonly object _lock = new();
    private MonitorRect[] _monitors = Array.Empty<MonitorRect>();
    private int _selected;

    public MonitorRect Current
    {
        get { lock (_lock) return _monitors[_selected]; }
    }

    /// <summary>Re-reads the display layout. Returns true if it changed.</summary>
    public bool Refresh()
    {
        var found = Enumerate();
        lock (_lock)
        {
            if (found.SequenceEqual(_monitors)) return false;

            var isFirstRead = _monitors.Length == 0;
            _monitors = found;

            if (isFirstRead || _selected >= found.Length)
                _selected = Math.Max(0, Array.FindIndex(found, m => m.Primary));
            return true;
        }
    }

    public bool Select(int index)
    {
        lock (_lock)
        {
            if (index < 0 || index >= _monitors.Length || index == _selected) return false;
            _selected = index;
            return true;
        }
    }

    /// <summary>Maps a position in the picture, 0 to 65535 on each axis, to a point on the desktop.</summary>
    public (int X, int Y) MapNormalized(int nx, int ny)
    {
        var m = Current;
        int x = m.Left + (int)Math.Round(Math.Clamp(nx, 0, 65535) / 65535.0 * (m.Width - 1));
        int y = m.Top + (int)Math.Round(Math.Clamp(ny, 0, 65535) / 65535.0 * (m.Height - 1));
        return (x, y);
    }

    public string DescribeForTechnician()
    {
        lock (_lock)
        {
            return JsonSerializer.Serialize(new
            {
                type = "monitors",
                active = _selected,
                list = _monitors.Select(m => new { w = m.Width, h = m.Height, primary = m.Primary }).ToArray(),
            });
        }
    }

    private static MonitorRect[] Enumerate()
    {
        var found = new List<MonitorRect>();

        MonitorEnumProc callback = (IntPtr monitor, IntPtr _, IntPtr _, IntPtr _) =>
        {
            var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            if (GetMonitorInfoW(monitor, ref info))
            {
                var r = info.rcMonitor;
                found.Add(new MonitorRect(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, (info.dwFlags & MONITORINFOF_PRIMARY) != 0));
            }
            return true;
        };

        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
        GC.KeepAlive(callback);

        if (found.Count == 0)
            found.Add(new MonitorRect(0, 0, Math.Max(1, GetSystemMetrics(SM_CXSCREEN)), Math.Max(1, GetSystemMetrics(SM_CYSCREEN)), true));

        // Left to right, so "Display 1" and "Display 2" match how the monitors are arranged.
        return found.OrderBy(m => m.Left).ThenBy(m => m.Top).ToArray();
    }

    private const int SM_CXSCREEN = 0;
    private const int SM_CYSCREEN = 1;
    private const uint MONITORINFOF_PRIMARY = 1;

    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFO info);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);
}
