// agents/windows/AdgRmm.CaptureHelper/CursorTracker.cs

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.Json;

/// <summary>
/// Tells the viewer the pointer's shape and position, so the browser can draw it straight away. A
/// pointer inside the video can only move as fast as the whole round trip to the device and back.
/// </summary>
internal sealed class CursorTracker
{
    /// <summary>Set once the viewer asks for this. Until then the pointer stays in the picture, as older pages expect.</summary>
    public static volatile bool Enabled;

    private const int MaxSize = 64;
    private const long PositionEveryMs = 66;
    private const int CURSOR_SHOWING = 1;
    private const int DI_NORMAL = 3;

    private readonly Action<string> _send;
    private readonly HashSet<long> _sent = new();
    private long _lastCursor = -1;
    private bool _wasHidden;
    private long _lastPositionMs;
    private double _lastX = double.NaN;
    private double _lastY = double.NaN;

    public CursorTracker(Action<string> send) => _send = send;

    public void Tick(MonitorRect monitor, long nowMs)
    {
        var info = new CURSORINFO { cbSize = Marshal.SizeOf<CURSORINFO>() };
        if (!GetCursorInfo(ref info)) return;

        var showing = (info.flags & CURSOR_SHOWING) != 0 && info.hCursor != IntPtr.Zero;
        if (!showing)
        {
            if (!_wasHidden)
            {
                _wasHidden = true;
                _lastCursor = -1;
                _send(JsonSerializer.Serialize(new { type = "cursor.shape", hidden = true }));
            }
            return;
        }

        _wasHidden = false;
        var handle = info.hCursor.ToInt64();
        if (handle != _lastCursor)
        {
            _lastCursor = handle;
            SendShape(info.hCursor, handle);
        }

        if (nowMs - _lastPositionMs < PositionEveryMs) return;

        var x = (info.ptScreenPos.X - monitor.Left) / (double)Math.Max(1, monitor.Width);
        var y = (info.ptScreenPos.Y - monitor.Top) / (double)Math.Max(1, monitor.Height);
        if (x == _lastX && y == _lastY) return;

        _lastX = x;
        _lastY = y;
        _lastPositionMs = nowMs;
        _send(JsonSerializer.Serialize(new { type = "cursor.pos", x = Math.Round(x, 4), y = Math.Round(y, 4) }));
    }

    private void SendShape(IntPtr cursor, long id)
    {
        // Shapes repeat constantly, so each is only sent once and then named.
        if (_sent.Contains(id))
        {
            _send(JsonSerializer.Serialize(new { type = "cursor.shape", id = id.ToString() }));
            return;
        }

        if (!GetIconInfo(cursor, out var icon)) return;
        try
        {
            var (w, h) = SizeOf(icon);
            if (w <= 0 || h <= 0) return;

            var rgba = Render(cursor, w, h);
            if (rgba is null) return;

            _sent.Add(id);
            _send(JsonSerializer.Serialize(new
            {
                type = "cursor.shape",
                id = id.ToString(),
                w,
                h,
                hx = Math.Min(icon.xHotspot, w - 1),
                hy = Math.Min(icon.yHotspot, h - 1),
                rgba = Convert.ToBase64String(rgba),
            }));
        }
        finally
        {
            if (icon.hbmMask != IntPtr.Zero) DeleteObject(icon.hbmMask);
            if (icon.hbmColor != IntPtr.Zero) DeleteObject(icon.hbmColor);
        }
    }

    private static (int W, int H) SizeOf(ICONINFO icon)
    {
        var source = icon.hbmColor != IntPtr.Zero ? icon.hbmColor : icon.hbmMask;
        if (GetObjectW(source, Marshal.SizeOf<BITMAP>(), out var bitmap) == 0) return (0, 0);

        // A black and white cursor stores its two masks stacked in one bitmap.
        var height = icon.hbmColor != IntPtr.Zero ? bitmap.bmHeight : bitmap.bmHeight / 2;
        return (Math.Min(bitmap.bmWidth, MaxSize), Math.Min(height, MaxSize));
    }

    /// <summary>
    /// Draws the cursor on black and on white and compares them, which recovers transparency for every
    /// kind of Windows cursor, including older ones with no alpha channel.
    /// </summary>
    private static byte[]? Render(IntPtr cursor, int w, int h)
    {
        var onBlack = Draw(cursor, w, h, 0x00);
        var onWhite = Draw(cursor, w, h, 0xFF);
        if (onBlack is null || onWhite is null) return null;

        var rgba = new byte[w * h * 4];
        var inverting = new bool[w * h];

        for (var i = 0; i < w * h; i++)
        {
            var p = i * 4;
            int b0 = onBlack[p], g0 = onBlack[p + 1], r0 = onBlack[p + 2];
            int g1 = onWhite[p + 1];

            // Lighter on black than on white: the pixel flips what is behind it, as a text cursor does.
            if (g0 - g1 > 128)
            {
                inverting[i] = true;
                rgba[p + 3] = 255;
                continue;
            }

            var alpha = Math.Clamp(255 - (g1 - g0), 0, 255);
            if (alpha == 0) continue;

            rgba[p] = (byte)Math.Min(255, r0 * 255 / alpha);
            rgba[p + 1] = (byte)Math.Min(255, g0 * 255 / alpha);
            rgba[p + 2] = (byte)Math.Min(255, b0 * 255 / alpha);
            rgba[p + 3] = (byte)alpha;
        }

        // A browser cannot flip pixels, so those become black with a white edge, visible on any background.
        for (var y = 0; y < h; y++)
        {
            for (var x = 0; x < w; x++)
            {
                if (rgba[(y * w + x) * 4 + 3] != 0) continue;

                var nextToInverting =
                    (x > 0 && inverting[y * w + x - 1]) || (x < w - 1 && inverting[y * w + x + 1]) ||
                    (y > 0 && inverting[(y - 1) * w + x]) || (y < h - 1 && inverting[(y + 1) * w + x]);
                if (!nextToInverting) continue;

                var p = (y * w + x) * 4;
                rgba[p] = rgba[p + 1] = rgba[p + 2] = rgba[p + 3] = 255;
            }
        }

        return rgba;
    }

    private static byte[]? Draw(IntPtr cursor, int w, int h, byte background)
    {
        var screen = GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) return null;

        var memory = CreateCompatibleDC(screen);
        var info = new BITMAPINFOHEADER
        {
            biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>(),
            biWidth = w,
            biHeight = -h,
            biPlanes = 1,
            biBitCount = 32,
        };
        var bitmap = CreateDIBSection(screen, ref info, 0, out var bits, IntPtr.Zero, 0);
        var previous = bitmap != IntPtr.Zero ? SelectObject(memory, bitmap) : IntPtr.Zero;

        try
        {
            if (bitmap == IntPtr.Zero || bits == IntPtr.Zero) return null;

            var pixels = new byte[w * h * 4];
            Array.Fill(pixels, background);
            Marshal.Copy(pixels, 0, bits, pixels.Length);

            if (!DrawIconEx(memory, 0, 0, cursor, w, h, 0, IntPtr.Zero, DI_NORMAL)) return null;

            Marshal.Copy(bits, pixels, 0, pixels.Length);
            return pixels;
        }
        finally
        {
            if (previous != IntPtr.Zero) SelectObject(memory, previous);
            if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
            DeleteDC(memory);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct CURSORINFO
    {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ICONINFO
    {
        [MarshalAs(UnmanagedType.Bool)] public bool fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAP
    {
        public int bmType;
        public int bmWidth;
        public int bmHeight;
        public int bmWidthBytes;
        public ushort bmPlanes;
        public ushort bmBitsPixel;
        public IntPtr bmBits;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    [DllImport("user32.dll")] private static extern bool GetCursorInfo(ref CURSORINFO info);
    [DllImport("user32.dll")] private static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
    [DllImport("user32.dll")] private static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int w, int h, uint step, IntPtr brush, int flags);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] private static extern int GetObjectW(IntPtr obj, int size, out BITMAP result);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER info, uint usage, out IntPtr bits, IntPtr section, uint offset);
}
