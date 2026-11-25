// agents/windows/RemoteIQ.CaptureHelper/DisplayModes.cs

using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;

/// <summary>
/// The screen sizes the device's display can show, and a way to switch the main display to one of them.
/// A session on a virtual machine often starts small, such as 1280x800 at the sign-in screen, where
/// Remote Desktop would have matched the technician's own screen. Only sizes Windows lists as supported
/// are accepted, and the change is not saved, so it does not outlive the session it was made in.
/// </summary>
internal static class DisplayModes
{
    private const int EnumCurrentSettings = -1;
    private const uint DmPelsWidth = 0x00080000, DmPelsHeight = 0x00100000;
    private const uint CdsTest = 0x00000002;
    private const int DispChangeSuccessful = 0;

    // Anything smaller is not usable, and anything larger is not a real mode.
    private const int MinWidth = 800, MinHeight = 600, MaxWidth = 7680, MaxHeight = 4320;
    private const int MaxListed = 40;

    /// <summary>The current size and the supported ones, as the viewer reads them.</summary>
    public static string Describe()
    {
        var current = Current();
        var list = Supported().Select(s => new { w = s.W, h = s.H }).ToArray();
        return JsonSerializer.Serialize(new
        {
            type = "display.modes",
            current = current is { } c ? new { w = c.W, h = c.H } : null,
            list,
        });
    }

    /// <summary>Switches the main display. Returns an empty string on success, or what went wrong.</summary>
    public static string Apply(int width, int height)
    {
        if (width < MinWidth || height < MinHeight || width > MaxWidth || height > MaxHeight)
            return $"{width}x{height} is not a usable screen size.";

        // Never a size Windows did not list, so a bad request cannot leave the display unusable.
        if (!Supported().Any(s => s.W == width && s.H == height))
            return $"The device's display does not list {width}x{height} as a supported size.";

        var mode = NewMode();
        if (!EnumDisplaySettingsW(null, EnumCurrentSettings, ref mode)) return "Windows would not say what size the display is now.";
        if (mode.dmPelsWidth == (uint)width && mode.dmPelsHeight == (uint)height) return "";

        mode.dmPelsWidth = (uint)width;
        mode.dmPelsHeight = (uint)height;
        mode.dmFields = DmPelsWidth | DmPelsHeight;

        var test = ChangeDisplaySettingsExW(null, ref mode, IntPtr.Zero, CdsTest, IntPtr.Zero);
        if (test != DispChangeSuccessful) return $"Windows says this display cannot switch to {width}x{height} right now (code {test}).";

        var result = ChangeDisplaySettingsExW(null, ref mode, IntPtr.Zero, 0, IntPtr.Zero);
        return result == DispChangeSuccessful ? "" : $"Windows could not switch to {width}x{height} (code {result}).";
    }

    private static (int W, int H)? Current()
    {
        var mode = NewMode();
        return EnumDisplaySettingsW(null, EnumCurrentSettings, ref mode) ? ((int)mode.dmPelsWidth, (int)mode.dmPelsHeight) : null;
    }

    private static List<(int W, int H)> Supported()
    {
        var found = new HashSet<(int, int)>();
        var mode = NewMode();
        for (var i = 0; i < 4000 && EnumDisplaySettingsW(null, i, ref mode); i++)
        {
            if (mode.dmBitsPerPel < 24) continue;
            var w = (int)mode.dmPelsWidth;
            var h = (int)mode.dmPelsHeight;
            if (w < MinWidth || h < MinHeight || w > MaxWidth || h > MaxHeight) continue;
            found.Add((w, h));
        }

        return found.OrderByDescending(s => s.Item1).ThenByDescending(s => s.Item2).Take(MaxListed).Select(s => (s.Item1, s.Item2)).ToList();
    }

    private static DEVMODE NewMode() => new() { dmDeviceName = "", dmFormName = "", dmSize = (ushort)Marshal.SizeOf<DEVMODE>() };

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public ushort dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public uint dmFields;
        public int dmPositionX, dmPositionY;
        public uint dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public ushort dmLogPixels;
        public uint dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public uint dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplaySettingsW(string? deviceName, int modeNumber, ref DEVMODE mode);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int ChangeDisplaySettingsExW(string? deviceName, ref DEVMODE mode, IntPtr window, uint flags, IntPtr param);
}
