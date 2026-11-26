// agents/windows/AdgRmm.CaptureHelper/Glass/GlassCard.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

/// <summary>
/// A borderless window drawn with per-pixel transparency, so it can have rounded corners, a soft shadow and a
/// glass look on any Windows version. It never takes focus, so it cannot steal what the person is typing, and the
/// clear parts of it let clicks through to whatever is underneath. Cards draw themselves each frame, which is
/// what lets them fade in and out, pulse, and run a countdown.
/// </summary>
internal abstract class GlassCard
{
    /// <summary>Space around the visible card for its shadow, in logical pixels.</summary>
    protected const float ShadowMargin = 26f;

    public enum Placement { TopRight, BottomRight, TopCenter }

    private const uint WS_POPUP = 0x80000000;
    private const uint WS_EX_TOPMOST = 0x00000008, WS_EX_TOOLWINDOW = 0x00000080, WS_EX_LAYERED = 0x00080000, WS_EX_NOACTIVATE = 0x08000000;
    private const uint WM_TIMER = 0x0113, WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_MOUSELEAVE = 0x02A3;
    private const uint WM_SETCURSOR = 0x0020, WM_MOUSEACTIVATE = 0x0021, WM_CLOSE = 0x0010, WM_NCLBUTTONDOWN = 0x00A1;
    private const uint WM_ENTERSIZEMOVE = 0x0231, WM_EXITSIZEMOVE = 0x0232, WM_MOUSEWHEEL = 0x020A;
    private const int HTCAPTION = 2, MA_NOACTIVATE = 3, SW_SHOWNOACTIVATE = 4;
    private const uint SPI_GETWORKAREA = 0x0030;
    private const int FadeInMs = 220, FadeOutMs = 160;
    private const int TimerId = 1;

    private static readonly Dictionary<IntPtr, GlassCard> Cards = new();
    private static UiThread.WndProc? _proc;
    private static bool _classRegistered;
    private static bool _gdipStarted;

    private readonly UiThread _ui;
    private readonly List<(int Id, float X, float Y, float W, float H)> _buttons = new();
    private readonly Stopwatch _clock = new();

    private IntPtr _window, _memDc, _dib, _oldBitmap, _bits, _gdipBitmap, _graphics;
    private int _pixelW, _pixelH;
    private float _scale = 1f;
    private bool _closing;
    private long _closingStartedMs;
    private bool _trackingMouse;

    // Once the person drags the card, where it is belongs to them. Every redraw must leave the position alone,
    // or the card jumps back to where it started.
    private bool _dragging;
    private bool _userMoved;
    private int _pressed = -1;
    private Placement _placement;

    protected int Hover { get; private set; } = -1;
    protected int Pressed => _pressed;
    protected float Seconds => _clock.ElapsedMilliseconds / 1000f;

    protected GlassCard(UiThread ui) => _ui = ui;

    /// <summary>The card's size in logical pixels, shadow margin included.</summary>
    protected abstract (float W, float H) MeasureSize(GlassPainter measure);

    /// <summary>Draws one frame. Register clickable areas with <see cref="Button"/> as you draw them.</summary>
    protected abstract void Paint(GlassPainter p, float width, float height);

    protected virtual void OnButton(int id) { }

    /// <summary>Whether the card changes with time, such as a pulse or a countdown. Static cards redraw only when needed.</summary>
    protected virtual bool Animated => true;

    protected void Button(int id, float x, float y, float w, float h) => _buttons.Add((id, x, y, w, h));

    /// <summary>The card's window, for cards that put something of their own on top of it, such as a text box.</summary>
    protected IntPtr Handle => _window;

    /// <summary>Pixels per logical pixel on this display.</summary>
    protected float PixelScale => _scale;

    /// <summary>Called after every frame is shown, so anything placed over the card can follow it.</summary>
    protected virtual void OnFrame() { }

    /// <summary>Called just before the window goes away.</summary>
    protected virtual void OnDestroyed() { }

    /// <summary>The mouse wheel turned over the card. Positive is up.</summary>
    protected virtual void OnWheel(int delta) { }

    /// <summary>The pointer moved over the card, which tells a card that hides itself that the person is looking at it.</summary>
    protected virtual void OnPointerMoved() { }

    /// <summary>Whether the person can drag the card around. A card docked to the edge of the screen cannot be.</summary>
    protected virtual bool Draggable => true;

    /// <summary>How often the card redraws while it is showing, in milliseconds.</summary>
    protected virtual int FrameMs => Animated ? 33 : 50;

    /// <summary>Changes how often the card redraws, such as faster during a slide and slower while idle.</summary>
    protected void SetFrameMs(int ms)
    {
        if (_window != IntPtr.Zero) SetTimer(_window, TimerId, new IntPtr(ms), IntPtr.Zero);
    }

    /// <summary>The part of the screen not covered by the taskbar.</summary>
    protected (int Left, int Top, int Right, int Bottom) WorkArea => (_area.Left, _area.Top, _area.Right, _area.Bottom);

    /// <summary>
    /// Lets a card choose its own position and visible size each frame, such as a panel that slides in from the
    /// edge by showing more and more of itself. The drawing surface is not changed, only the part of it shown.
    /// </summary>
    protected virtual void AdjustFrame(ref int x, ref int y, ref int w, ref int h) { }

    private RECT _area;

    // ---- showing and hiding ----

    public bool IsVisible => _window != IntPtr.Zero && !_closing;

    public void Show(Placement placement)
    {
        _ui.Post(() =>
        {
            _placement = placement;
            _closing = false;
            if (_window == IntPtr.Zero) Create();
            _clock.Restart();
            LayOut();
            Render();
            ShowWindow(_window, SW_SHOWNOACTIVATE);
            SetTimer(_window, TimerId, new IntPtr(FrameMs), IntPtr.Zero);
        });
    }

    /// <summary>Redraws now, after the card's content changed.</summary>
    public void Refresh() => _ui.Post(() => { if (_window != IntPtr.Zero) { LayOut(); Render(); } });

    /// <summary>Fades the card out and removes it.</summary>
    public void Close()
    {
        _ui.Post(() =>
        {
            if (_window == IntPtr.Zero || _closing) return;
            _closing = true;
            _closingStartedMs = _clock.ElapsedMilliseconds;
        });
    }

    // ---- window ----

    private void Create()
    {
        EnsureGdiPlus();
        EnsureClass();
        _scale = GetDpiForSystem() / 96f;

        _window = CreateWindowExW(WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, "AdgRmmGlass", "", WS_POPUP,
            0, 0, 10, 10, IntPtr.Zero, IntPtr.Zero, UiThread.GetModuleHandleW(null), IntPtr.Zero);
        Cards[_window] = this;
    }

    private static void EnsureGdiPlus()
    {
        if (_gdipStarted) return;
        var input = new GdiplusStartupInput { GdiplusVersion = 1 };
        GdiplusStartup(out _, ref input, IntPtr.Zero);
        _gdipStarted = true;
    }

    private static void EnsureClass()
    {
        if (_classRegistered) return;
        _proc = StaticProc;
        var cls = new UiThread.WNDCLASSW
        {
            lpfnWndProc = _proc,
            hInstance = UiThread.GetModuleHandleW(null),
            hCursor = LoadCursorW(IntPtr.Zero, new IntPtr(32512)),
            lpszClassName = "AdgRmmGlass",
        };
        UiThread.RegisterClassW(ref cls);
        _classRegistered = true;
    }

    /// <summary>Works out the size, makes the drawing surface to match, and places the window on the screen.</summary>
    private void LayOut()
    {
        // The usable part of the screen comes first, because some cards size themselves to it.
        var area = new RECT();
        SystemParametersInfoW(SPI_GETWORKAREA, 0, ref area, 0);
        _area = area;

        // Measuring needs a surface to draw on, so a small one stands in until the real size is known.
        var (w, h) = Measure();
        var pixelW = (int)Math.Ceiling(w * _scale);
        var pixelH = (int)Math.Ceiling(h * _scale);
        if (pixelW != _pixelW || pixelH != _pixelH || _memDc == IntPtr.Zero) MakeSurface(pixelW, pixelH);

        var margin = (int)(14 * _scale);
        var shadow = (int)(ShadowMargin * _scale);
        int x, y;
        switch (_placement)
        {
            case Placement.BottomRight:
                x = area.Right - pixelW - margin + shadow;
                y = area.Bottom - pixelH - margin + shadow;
                break;
            case Placement.TopCenter:
                x = area.Left + (area.Right - area.Left - pixelW) / 2;
                y = area.Top + margin - shadow + (int)(10 * _scale);
                break;
            default:
                x = area.Right - pixelW - margin + shadow;
                y = area.Top + margin - shadow;
                break;
        }

        _position = new POINT { X = x, Y = y };
    }

    private POINT _position;

    private (float W, float H) Measure()
    {
        // A throwaway one-pixel surface is enough for measuring text.
        var info = new BITMAPINFO { bmiHeader = { biSize = 40, biWidth = 1, biHeight = -1, biPlanes = 1, biBitCount = 32 } };
        var dc = CreateCompatibleDC(IntPtr.Zero);
        var dib = CreateDIBSection(dc, ref info, 0, out var bits, IntPtr.Zero, 0);
        GdipCreateBitmapFromScan0(1, 1, 4, 0x000E200B, bits, out var bitmap);
        GdipGetImageGraphicsContext(bitmap, out var graphics);
        try
        {
            using var painter = new GlassPainter(graphics, _scale);
            return MeasureSize(painter);
        }
        finally
        {
            GdipDeleteGraphics(graphics);
            GdipDisposeImage(bitmap);
            DeleteObject(dib);
            DeleteDC(dc);
        }
    }

    private void MakeSurface(int pixelW, int pixelH)
    {
        FreeSurface();
        _pixelW = pixelW;
        _pixelH = pixelH;

        var screen = GetDC(IntPtr.Zero);
        _memDc = CreateCompatibleDC(screen);
        var info = new BITMAPINFO { bmiHeader = { biSize = 40, biWidth = pixelW, biHeight = -pixelH, biPlanes = 1, biBitCount = 32 } };
        _dib = CreateDIBSection(screen, ref info, 0, out _bits, IntPtr.Zero, 0);
        ReleaseDC(IntPtr.Zero, screen);
        _oldBitmap = SelectObject(_memDc, _dib);

        // Premultiplied alpha, which is what a layered window expects.
        GdipCreateBitmapFromScan0(pixelW, pixelH, pixelW * 4, 0x000E200B, _bits, out _gdipBitmap);
        GdipGetImageGraphicsContext(_gdipBitmap, out _graphics);
    }

    private void FreeSurface()
    {
        if (_graphics != IntPtr.Zero) { GdipDeleteGraphics(_graphics); _graphics = IntPtr.Zero; }
        if (_gdipBitmap != IntPtr.Zero) { GdipDisposeImage(_gdipBitmap); _gdipBitmap = IntPtr.Zero; }
        if (_memDc != IntPtr.Zero)
        {
            if (_oldBitmap != IntPtr.Zero) SelectObject(_memDc, _oldBitmap);
            DeleteDC(_memDc);
            _memDc = IntPtr.Zero;
        }
        if (_dib != IntPtr.Zero) { DeleteObject(_dib); _dib = IntPtr.Zero; }
    }

    private void Render()
    {
        if (_window == IntPtr.Zero || _graphics == IntPtr.Zero) return;

        _buttons.Clear();
        using (var painter = new GlassPainter(_graphics, _scale))
        {
            painter.Clear();
            Paint(painter, _pixelW / _scale, _pixelH / _scale);
        }

        var alpha = 255;
        var elapsed = _clock.ElapsedMilliseconds;
        if (_closing) alpha = (int)Math.Max(0, 255 - (elapsed - _closingStartedMs) * 255 / FadeOutMs);
        else if (elapsed < FadeInMs) alpha = (int)(255 * Math.Pow(elapsed / (double)FadeInMs, 0.6));

        var size = new SIZE { cx = _pixelW, cy = _pixelH };
        var source = new POINT();
        var blend = new BLENDFUNCTION { BlendOp = 0, BlendFlags = 0, SourceConstantAlpha = (byte)Math.Clamp(alpha, 0, 255), AlphaFormat = 1 };

        // A card may choose its own frame, such as a panel sliding in from the screen edge.
        var frameX = _position.X;
        var frameY = _position.Y;
        var frameW = _pixelW;
        var frameH = _pixelH;
        AdjustFrame(ref frameX, ref frameY, ref frameW, ref frameH);
        var framePosition = new POINT { X = frameX, Y = frameY };
        size = new SIZE { cx = frameW, cy = frameH };

        // Placed by us until the person moves it, and left where they put it after that.
        if (Draggable && (_dragging || _userMoved))
            UpdateLayeredWindowInPlace(_window, IntPtr.Zero, IntPtr.Zero, ref size, _memDc, ref source, 0, ref blend, 2);
        else
            UpdateLayeredWindow(_window, IntPtr.Zero, ref framePosition, ref size, _memDc, ref source, 0, ref blend, 2);

        OnFrame();
        if (_closing && alpha <= 0) Destroy();
    }

    private void Destroy()
    {
        OnDestroyed();
        KillTimer(_window, TimerId);
        Cards.Remove(_window);
        DestroyWindow(_window);
        _window = IntPtr.Zero;
        FreeSurface();
        _closing = false;
    }

    // ---- messages ----

    private static IntPtr StaticProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
        => Cards.TryGetValue(hwnd, out var card) ? card.Proc(hwnd, message, wParam, lParam) : UiThread.DefWindowProcW(hwnd, message, wParam, lParam);

    private IntPtr Proc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        switch (message)
        {
            case WM_TIMER:
                if (Animated || _closing || _clock.ElapsedMilliseconds < FadeInMs + 50) Render();
                return IntPtr.Zero;

            case WM_MOUSEACTIVATE:
                return new IntPtr(MA_NOACTIVATE);

            case WM_MOUSEWHEEL:
                OnWheel((short)((wParam.ToInt64() >> 16) & 0xFFFF));
                return IntPtr.Zero;

            case WM_ENTERSIZEMOVE:
                _dragging = true;
                return IntPtr.Zero;

            case WM_EXITSIZEMOVE:
                _dragging = false;
                _userMoved = true;
                return IntPtr.Zero;

            case WM_MOUSEMOVE:
            {
                var (x, y) = Point(lParam);
                var over = HitTest(x, y);
                OnPointerMoved();
                if (!_trackingMouse)
                {
                    var track = new TRACKMOUSEEVENT { cbSize = (uint)Marshal.SizeOf<TRACKMOUSEEVENT>(), dwFlags = 2, hwndTrack = hwnd };
                    TrackMouseEvent(ref track);
                    _trackingMouse = true;
                }
                if (over != Hover) { Hover = over; Render(); }
                return IntPtr.Zero;
            }

            case WM_MOUSELEAVE:
                _trackingMouse = false;
                if (Hover != -1) { Hover = -1; Render(); }
                return IntPtr.Zero;

            case WM_SETCURSOR:
                SetCursor(LoadCursorW(IntPtr.Zero, new IntPtr(Hover >= 0 ? 32649 : 32512)));
                return new IntPtr(1);

            case WM_LBUTTONDOWN:
            {
                var (x, y) = Point(lParam);
                _pressed = HitTest(x, y);
                if (_pressed < 0 && !Draggable)
                {
                    // A docked card stays where it is.
                }
                else if (_pressed < 0)
                {
                    // Anywhere else on the card drags it, so it can be moved out of the way.
                    ReleaseCapture();
                    SendMessageW(hwnd, WM_NCLBUTTONDOWN, new IntPtr(HTCAPTION), IntPtr.Zero);
                }
                else
                {
                    SetCapture(hwnd);
                    Render();
                }
                return IntPtr.Zero;
            }

            case WM_LBUTTONUP:
            {
                var (x, y) = Point(lParam);
                var released = HitTest(x, y);
                var pressed = _pressed;
                _pressed = -1;
                ReleaseCapture();
                Render();
                if (pressed >= 0 && pressed == released) OnButton(pressed);
                return IntPtr.Zero;
            }

            case WM_CLOSE:
                // Cards close themselves. Closing from outside would end a session or an answer unseen.
                return IntPtr.Zero;
        }
        return UiThread.DefWindowProcW(hwnd, message, wParam, lParam);
    }

    private int HitTest(int pixelX, int pixelY)
    {
        var x = pixelX / _scale;
        var y = pixelY / _scale;
        foreach (var b in _buttons)
            if (x >= b.X && x <= b.X + b.W && y >= b.Y && y <= b.Y + b.H) return b.Id;
        return -1;
    }

    private static (int X, int Y) Point(IntPtr lParam) => ((short)(lParam.ToInt64() & 0xFFFF), (short)((lParam.ToInt64() >> 16) & 0xFFFF));

    // ---- Windows ----

    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct SIZE { public int cx, cy; }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
    [StructLayout(LayoutKind.Sequential)] private struct TRACKMOUSEEVENT { public uint cbSize, dwFlags; public IntPtr hwndTrack; public uint dwHoverTime; }
    [StructLayout(LayoutKind.Sequential)] private struct GdiplusStartupInput { public uint GdiplusVersion; public IntPtr DebugEventCallback; public int SuppressBackgroundThread; public int SuppressExternalCodecs; }
    [StructLayout(LayoutKind.Sequential)] private struct BITMAPINFOHEADER { public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount; public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter; public uint biClrUsed, biClrImportant; }
    [StructLayout(LayoutKind.Sequential)] private struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public uint bmiColors; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowExW(uint exStyle, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] private static extern uint GetDpiForSystem();
    [DllImport("user32.dll")] private static extern IntPtr SetTimer(IntPtr hwnd, int id, IntPtr elapse, IntPtr proc);
    [DllImport("user32.dll")] private static extern bool KillTimer(IntPtr hwnd, int id);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool SystemParametersInfoW(uint action, uint param, ref RECT rect, uint ini);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr LoadCursorW(IntPtr instance, IntPtr name);
    [DllImport("user32.dll")] private static extern IntPtr SetCursor(IntPtr cursor);
    [DllImport("user32.dll")] private static extern bool TrackMouseEvent(ref TRACKMOUSEEVENT track);
    [DllImport("user32.dll")] private static extern IntPtr SetCapture(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageW(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr dst, ref POINT dstPos, ref SIZE size, IntPtr src, ref POINT srcPos, uint key, ref BLENDFUNCTION blend, uint flags);
    // The same call with no position, which redraws the card without moving it.
    [DllImport("user32.dll", EntryPoint = "UpdateLayeredWindow", SetLastError = true)]
    private static extern bool UpdateLayeredWindowInPlace(IntPtr hwnd, IntPtr dst, IntPtr dstPos, ref SIZE size, IntPtr src, ref POINT srcPos, uint key, ref BLENDFUNCTION blend, uint flags);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFO info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdiplus.dll")] private static extern int GdiplusStartup(out IntPtr token, ref GdiplusStartupInput input, IntPtr output);
    [DllImport("gdiplus.dll")] private static extern int GdipCreateBitmapFromScan0(int width, int height, int stride, int format, IntPtr scan0, out IntPtr bitmap);
    [DllImport("gdiplus.dll")] private static extern int GdipGetImageGraphicsContext(IntPtr image, out IntPtr graphics);
    [DllImport("gdiplus.dll")] private static extern int GdipDeleteGraphics(IntPtr graphics);
    [DllImport("gdiplus.dll")] private static extern int GdipDisposeImage(IntPtr image);
}
