// agents/windows/AdgRmm.CaptureHelper/Glass/SidePanel.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

/// <summary>
/// The one window that stays on the person's screen for as long as a technician is connected. It is docked to the
/// right edge of the screen: who is connected, an End session button, and the chat, all in one panel. The arrow tab
/// slides it out of the way, leaving only the tab to bring it back, and it cannot be closed, only hidden. It opens
/// without taking focus, so it never interrupts what the person is typing.
///
/// The slide works by showing more or less of one drawing, so the panel never leaves the screen edge and so never
/// appears on a neighbouring monitor. The box they type in is a real Windows text box laid over the panel, so
/// typing, pasting, selecting and input methods for other languages work as they do everywhere else.
/// </summary>
internal sealed class SidePanel : GlassCard
{
    private const int TabButton = 1;
    private const int EndButton = 2;
    private const int SendButton = 3;

    private const float LeftMargin = 22f;       // room for the shadow to the left of the tab
    private const float TabWidth = 46f;
    private const float TabHeight = 104f;
    private const float PanelWidth = 384f;
    private const float PanelTop = ShadowMargin;
    private const int MaxLength = 2000;
    private const long AutoHideAfterMs = 7000;

    private sealed class Message
    {
        public bool Mine;
        public string Text = "";
        public DateTime At;
        public float BubbleWidth, BubbleHeight;
        public bool Measured;
    }

    private readonly UiThread _ui;
    private readonly Action<string> _sendReply;
    private readonly Action _endSession;
    private readonly List<Message> _messages = new();
    private readonly Stopwatch _frameClock = Stopwatch.StartNew();

    private string _sessionText = "";
    private bool _sessionKnown;
    private bool _ending;
    private float _headerTextHeight;
    private string _headerTextMeasuredFor = "";

    // How much of the panel is showing, in logical pixels: 0 is just the tab, PanelWidth is all of it.
    private float _shown;
    private float _target;
    private long _lastFrameMs;
    private long _autoHideAt;
    private bool _touched;
    private int _currentFrameMs;

    private float _scrollUp;

    // The text box's place, in the drawing's own coordinates. Set while drawing, used to place the real box.
    private float _inputX, _inputY, _inputW, _inputH;
    private IntPtr _host, _edit, _font;
    private int _lastX = int.MinValue, _lastY, _lastW, _lastH;

    public SidePanel(UiThread ui, Action<string> sendReply, Action endSession) : base(ui)
    {
        _ui = ui;
        _sendReply = sendReply;
        _endSession = endSession;
    }

    protected override bool Animated => true;
    protected override bool Draggable => false;
    protected override int FrameMs => 100;

    // ---- what the rest of the helper tells it ----

    /// <summary>Says who is connected, and slides the panel out for a few seconds so the person sees it.</summary>
    public void BeginSession(string text)
    {
        _ui.Post(() =>
        {
            _sessionText = text;
            _sessionKnown = true;
            _ending = false;
            Reveal(autoHide: true);
        });
    }

    /// <summary>Slides the panel out for a few seconds, such as when a session starts.</summary>
    public void Announce() => _ui.Post(() => Reveal(autoHide: true));

    /// <summary>A message from the technician. The panel slides out, a chime plays, and it does not take focus.</summary>
    public void Incoming(string text)
    {
        _ui.Post(() =>
        {
            _messages.Add(new Message { Mine = false, Text = text, At = DateTime.Now });
            _scrollUp = 0;
            Chime.PlayIncoming();
            Reveal(autoHide: false);
        });
    }

    private void Reveal(bool autoHide)
    {
        _target = PanelWidth;
        _touched = !autoHide;
        _autoHideAt = autoHide ? Environment.TickCount64 + AutoHideAfterMs : 0;
        if (!IsVisible) Show(Placement.TopRight);
        else Refresh();
    }

    // ---- size and frame ----

    protected override (float W, float H) MeasureSize(GlassPainter measure) => (LeftMargin + TabWidth + PanelWidth, PanelHeight() + PanelTop * 2);

    /// <summary>Tall enough to be useful, short enough not to cover everything on a small screen.</summary>
    private float PanelHeight()
    {
        var area = WorkArea;
        var logicalHeight = (area.Bottom - area.Top) / Math.Max(PixelScale, 0.5f);
        return Math.Clamp(logicalHeight - 96f, 420f, 680f);
    }

    protected override void AdjustFrame(ref int x, ref int y, ref int w, ref int h)
    {
        var area = WorkArea;
        var visible = (int)Math.Ceiling((LeftMargin + TabWidth + _shown) * PixelScale);
        w = Math.Min(w, Math.Max(visible, 1));
        x = area.Right - w;
        y = area.Top + Math.Max(0, ((area.Bottom - area.Top) - h) / 2);
    }

    // ---- drawing ----

    protected override void Paint(GlassPainter p, float width, float height)
    {
        Advance();

        var panelX = LeftMargin + TabWidth;
        var panelY = PanelTop;
        var panelH = height - PanelTop * 2;

        // The tab is cut off where the panel begins, so the two never show through each other.
        p.ClipTo(0, 0, panelX, height);
        DrawTab(p, panelY, panelH);
        p.ResetClip();

        // Hidden, only the tab is on the screen, so there is nothing else worth drawing.
        if (_shown <= 0.4f && _target <= 0f) return;

        // Drawn wider than the screen edge, so its right corners are off the screen and it sits flush against it.
        p.Shadow(panelX, panelY, PanelWidth + 30, panelH, GlassTheme.Radius, 8, 120);
        p.FillRoundGradient(panelX, panelY, PanelWidth + 30, panelH, GlassTheme.Radius, GlassPainter.Argb(216, 32, 36, 54), GlassPainter.Argb(216, 14, 16, 26), true);
        p.StrokeRound(panelX + 0.5f, panelY + 0.5f, PanelWidth + 29, panelH - 1, GlassTheme.Radius, GlassPainter.Argb(64, 255, 255, 255), 1f);
        p.FillRoundGradient(panelX + 26, panelY, 54, 3f, 1.5f, GlassTheme.Violet, GlassTheme.Cyan, false);

        var x = panelX + 16;
        var w = PanelWidth - 32;
        var cursor = panelY + 22;

        // Who is connected, and how to end it.
        if (_sessionKnown)
        {
            // A steady glow here, because redrawing the whole panel just to pulse a dot costs more than it is worth.
            // The tab, which is small, does the pulsing while the panel is out of the way.
            p.Circle(x + 10, cursor + 12, 10f, GlassPainter.WithAlpha(GlassTheme.Green, 40));
            p.Circle(x + 10, cursor + 12, 7.5f, GlassPainter.WithAlpha(GlassTheme.Green, 70));
            p.Circle(x + 10, cursor + 12, 4.5f, GlassTheme.Green);
            p.Text("Remote access in progress", x + 30, cursor + 2, w - 34, 22, 14.5f, true, GlassTheme.Text, 0, false);
            cursor += 30;

            if (_headerTextMeasuredFor != _sessionText)
            {
                _headerTextHeight = p.MeasureHeight(_sessionText, w - 30, 12.5f, false);
                _headerTextMeasuredFor = _sessionText;
            }
            p.Text(_sessionText, x + 30, cursor, w - 34, _headerTextHeight + 4, 12.5f, false, GlassTheme.TextDim);
            cursor += _headerTextHeight + 14;

            var endX = x + w - 132;
            GlassTheme.Pill(p, endX, cursor, 132, 36, _ending ? "Ending..." : "End session", true, GlassTheme.RedFrom, GlassTheme.RedTo,
                Hover == EndButton, Pressed == EndButton, !_ending);
            if (!_ending) Button(EndButton, endX, cursor, 132, 36);
            cursor += 36 + 16;
        }
        else
        {
            p.Circle(x + 10, cursor + 12, 7.5f, GlassPainter.WithAlpha(GlassTheme.Cyan, 60));
            p.Circle(x + 10, cursor + 12, 4.5f, GlassTheme.Cyan);
            p.Text("Your IT provider", x + 30, cursor + 2, w - 34, 22, 14.5f, true, GlassTheme.Text, 0, false);
            cursor += 36;
        }

        p.FillRound(x, cursor, w, 1f, 0.5f, GlassPainter.Argb(30, 255, 255, 255));
        cursor += 10;

        // The chat, between the header and the input row.
        var rowY = panelY + panelH - 62;
        var sendW = 76f;
        var pillW = w - sendW - 10;
        var top = cursor;
        var bottom = rowY - 12;
        DrawMessages(p, panelX, x, w, top, bottom);

        // The input row, at the bottom.
        p.FillRound(x, rowY, pillW, 42, 21, GlassPainter.Argb(255, 27, 31, 46));
        p.StrokeRound(x + 0.5f, rowY + 0.5f, pillW - 1, 41, 21, GlassPainter.Argb(70, 255, 255, 255), 1f);
        _inputX = x + 18;
        _inputY = rowY + 11;
        _inputW = pillW - 36;
        _inputH = 20;

        GlassTheme.Pill(p, x + w - sendW, rowY, sendW, 42, "Send", true, GlassTheme.Violet, GlassTheme.Cyan, Hover == SendButton, Pressed == SendButton);
        Button(SendButton, x + w - sendW, rowY, sendW, 42);
    }

    private void DrawTab(GlassPainter p, float panelY, float panelH)
    {
        var tabY = panelY + (panelH - TabHeight) / 2;
        var open = _target > 0f;
        var hover = Hover == TabButton;

        p.Shadow(LeftMargin, tabY, TabWidth + 30, TabHeight, 16, 6, 110);
        p.FillRoundGradient(LeftMargin, tabY, TabWidth + 30, TabHeight, 16, GlassPainter.Argb(232, 34, 38, 58), GlassPainter.Argb(232, 18, 20, 32), true);
        p.StrokeRound(LeftMargin + 0.5f, tabY + 0.5f, TabWidth + 29, TabHeight - 1, 16, GlassPainter.Argb(hover ? 120 : 64, 255, 255, 255), 1f);
        if (hover) p.FillRound(LeftMargin + 4, tabY + 4, TabWidth - 4, TabHeight - 8, 12, GlassPainter.Argb(22, 255, 255, 255));

        // A live dot at the top of the tab, so it is clear a session is running even when the panel is out of the way.
        if (_sessionKnown)
        {
            // Pulses only while the panel is hidden, when the tab is all that is drawn and the pulse is cheap.
            var t = _shown <= 0.4f ? (Seconds % 1.8f) / 1.8f : 0f;
            if (t > 0f) p.Circle(LeftMargin + 21, tabY + 18, 3.5f + 5 * t, GlassPainter.WithAlpha(GlassTheme.Green, (int)(90 * (1 - t))));
            p.Circle(LeftMargin + 21, tabY + 18, 3.5f, GlassTheme.Green);
        }

        // The arrow points to where the panel will go: right to hide it, left to bring it back.
        p.Text(open ? "›" : "‹", LeftMargin, tabY + TabHeight / 2 - 17, TabWidth - 2, 34, 30f, false,
            GlassPainter.Argb(hover ? 255 : 210, 255, 255, 255), 1, false);
        Button(TabButton, LeftMargin, tabY, TabWidth, TabHeight);
    }

    private void DrawMessages(GlassPainter p, float panelX, float x, float w, float top, float bottom)
    {
        var areaHeight = bottom - top;
        var maxBubble = w * 0.82f;

        var total = 0f;
        foreach (var m in _messages)
        {
            if (!m.Measured)
            {
                var size = p.MeasureText(m.Text, maxBubble - 24, 12.5f, false);
                m.BubbleWidth = Math.Max(48f, size.W + 26f);
                m.BubbleHeight = size.H + 18f;
                m.Measured = true;
            }
            total += 16 + m.BubbleHeight + 14;
        }

        var overflow = Math.Max(0f, total - areaHeight);
        _scrollUp = Math.Clamp(_scrollUp, 0f, overflow);
        var cursor = top - (overflow - _scrollUp);

        p.ClipTo(panelX + 6, top, PanelWidth - 12, areaHeight);
        if (_messages.Count == 0)
            p.Text("Messages from your IT provider appear here.", x + 8, top + 10, w - 16, 40, 12.5f, false, GlassTheme.TextDim, 1);

        foreach (var m in _messages)
        {
            var bx = m.Mine ? x + w - m.BubbleWidth : x;
            var label = (m.Mine ? "You" : "Your IT provider") + " · " + m.At.ToString("t");
            p.Text(label, bx + 4, cursor, m.BubbleWidth + 120, 14, 10.5f, false, GlassTheme.TextDim, 0, false);
            var by = cursor + 16;

            if (m.Mine)
            {
                p.FillRoundGradient(bx, by, m.BubbleWidth, m.BubbleHeight, 16, GlassPainter.Argb(255, 112, 80, 245), GlassPainter.Argb(255, 70, 130, 245), false);
                p.Text(m.Text, bx + 13, by + 9, m.BubbleWidth - 20, m.BubbleHeight, 12.5f, false, GlassPainter.Argb(255, 255, 255, 255));
            }
            else
            {
                p.FillRound(bx, by, m.BubbleWidth, m.BubbleHeight, 16, GlassPainter.Argb(40, 255, 255, 255));
                p.StrokeRound(bx + 0.5f, by + 0.5f, m.BubbleWidth - 1, m.BubbleHeight - 1, 16, GlassPainter.Argb(46, 255, 255, 255), 1f);
                p.Text(m.Text, bx + 13, by + 9, m.BubbleWidth - 20, m.BubbleHeight, 12.5f, false, GlassTheme.Text);
            }
            cursor += 16 + m.BubbleHeight + 14;
        }

        if (overflow > 0f)
        {
            var barHeight = Math.Max(24f, areaHeight * areaHeight / total);
            var barY = top + (areaHeight - barHeight) * (1f - _scrollUp / overflow);
            p.FillRound(panelX + PanelWidth - 10, barY, 3f, barHeight, 1.5f, GlassPainter.Argb(70, 255, 255, 255));
        }
        p.ResetClip();
    }

    // ---- motion ----

    /// <summary>Moves the slide along, and decides how often to redraw: quickly while it moves, slowly while it rests.</summary>
    private void Advance()
    {
        var now = _frameClock.ElapsedMilliseconds;
        var dt = Math.Clamp((now - _lastFrameMs) / 1000f, 0f, 0.1f);
        _lastFrameMs = now;

        // Slides itself away a few seconds after it was announced, unless the person has touched it.
        if (_autoHideAt != 0 && !_touched && Environment.TickCount64 >= _autoHideAt)
        {
            _target = 0f;
            _autoHideAt = 0;
        }

        var moving = Math.Abs(_target - _shown) > 0.4f;
        if (moving)
        {
            _shown += (_target - _shown) * (1f - (float)Math.Exp(-dt * 13f));
            if (Math.Abs(_target - _shown) <= 0.4f) _shown = _target;
        }

        // At rest it only needs to keep the live dot pulsing, which does not need many frames.
        var wanted = moving ? 16 : (_shown > 0f ? 500 : 66);
        if (wanted != _currentFrameMs)
        {
            _currentFrameMs = wanted;
            SetFrameMs(wanted);
        }
    }

    protected override void OnButton(int id)
    {
        _touched = true;
        if (id == TabButton)
        {
            _target = _target > 0f ? 0f : PanelWidth;
            Refresh();
        }
        else if (id == EndButton && !_ending)
        {
            _ending = true;
            Refresh();
            try { _endSession(); }
            catch (Exception) { /* the agent has gone, and so is the session */ }
        }
        else if (id == SendButton) SendTyped();
    }

    protected override void OnPointerMoved() => _touched = true;

    protected override void OnWheel(int delta)
    {
        _scrollUp = Math.Max(0f, _scrollUp + delta / 120f * 56f);
        Refresh();
    }

    private void SendTyped()
    {
        if (_edit == IntPtr.Zero) return;

        var length = GetWindowTextLengthW(_edit);
        if (length == 0) return;

        var buffer = new StringBuilder(length + 1);
        GetWindowTextW(_edit, buffer, buffer.Capacity);
        var text = buffer.ToString().Trim();
        if (text.Length == 0) return;

        SetWindowTextW(_edit, "");
        _messages.Add(new Message { Mine = true, Text = text, At = DateTime.Now });
        _scrollUp = 0;
        _touched = true;
        Chime.PlaySent();
        Refresh();
        _sendReply(text);
    }

    // ---- the real text box, laid over the panel ----

    protected override void OnFrame()
    {
        // Only while the panel is fully out: during the slide, and when hidden, the box would float in the wrong place.
        var fullyOut = IsVisible && _shown >= PanelWidth - 0.5f;
        if (!fullyOut)
        {
            if (_host != IntPtr.Zero) ShowWindow(_host, 0);
            _lastX = int.MinValue;
            return;
        }

        EnsureInput();
        if (_host == IntPtr.Zero || !GetWindowRect(Handle, out var card)) return;

        var scale = PixelScale;
        var x = card.Left + (int)(_inputX * scale);
        var y = card.Top + (int)(_inputY * scale);
        var w = (int)(_inputW * scale);
        var h = (int)(_inputH * scale);
        if (x == _lastX && y == _lastY && w == _lastW && h == _lastH) return;

        _lastX = x; _lastY = y; _lastW = w; _lastH = h;
        SetWindowPos(_host, new IntPtr(-1), x, y, w, h, 0x0010 | 0x0040);   // on top, without taking focus
        SetWindowPos(_edit, IntPtr.Zero, 0, 0, w, h, 0x0010 | 0x0004);
    }

    protected override void OnDestroyed()
    {
        if (_edit != IntPtr.Zero) Edits.Remove(_edit);
        if (_host != IntPtr.Zero) DestroyWindow(_host);
        _host = IntPtr.Zero;
        _edit = IntPtr.Zero;
        _lastX = int.MinValue;
        if (_font != IntPtr.Zero) { DeleteObject(_font); _font = IntPtr.Zero; }
    }

    private void EnsureInput()
    {
        if (_host != IntPtr.Zero) return;

        EnsureHostClass();
        var instance = UiThread.GetModuleHandleW(null);
        _host = UiThread.CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, HostClass, "", WS_POPUP, 0, 0, 10, 10, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
        _edit = UiThread.CreateWindowExW(0, "EDIT", "", WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 0, 0, 10, 10, _host, IntPtr.Zero, instance, IntPtr.Zero);

        _font = CreateFontW(-(int)Math.Round(13.5 * PixelScale), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe UI");
        SendMessageW(_edit, WM_SETFONT, _font, new IntPtr(1));
        SendMessageW(_edit, EM_SETLIMITTEXT, new IntPtr(MaxLength), IntPtr.Zero);

        Edits[_edit] = this;
        _editProc = EditProc;
        SetWindowSubclass(_edit, _editProc, new UIntPtr(1), UIntPtr.Zero);
    }

    // ---- window classes and procedures ----

    private const string HostClass = "AdgRmmChatInput";
    private const uint WS_POPUP = 0x80000000, WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000;
    private const uint WS_EX_TOOLWINDOW = 0x00000080, WS_EX_TOPMOST = 0x00000008;
    private const uint ES_AUTOHSCROLL = 0x0080;
    private const uint WM_SETFONT = 0x0030, WM_ERASEBKGND = 0x0014, WM_SETFOCUS = 0x0007, WM_CTLCOLOREDIT = 0x0133;
    private const uint WM_KEYDOWN = 0x0100, WM_CHAR = 0x0102, EM_SETLIMITTEXT = 0x00C5;
    private const int VK_RETURN = 0x0D, VK_ESCAPE = 0x1B;
    private const uint TextColor = 0x00F6EEEB;     // 235, 238, 246 as a Windows colour
    private const uint BackColor = 0x002E1F1B;     // 27, 31, 46, the colour of the input pill

    private static readonly Dictionary<IntPtr, SidePanel> Edits = new();
    private static UiThread.WndProc? _hostProc;
    private static bool _hostClassRegistered;
    private static IntPtr _backBrush;
    private SubclassProc? _editProc;

    private delegate IntPtr SubclassProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, UIntPtr id, UIntPtr data);

    private static void EnsureHostClass()
    {
        if (_hostClassRegistered) return;
        _backBrush = CreateSolidBrush(BackColor);
        _hostProc = HostProc;
        var cls = new UiThread.WNDCLASSW
        {
            lpfnWndProc = _hostProc,
            hInstance = UiThread.GetModuleHandleW(null),
            hbrBackground = _backBrush,
            lpszClassName = HostClass,
        };
        UiThread.RegisterClassW(ref cls);
        _hostClassRegistered = true;
    }

    private static IntPtr HostProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        switch (message)
        {
            case WM_CTLCOLOREDIT:
                SetTextColor(wParam, TextColor);
                SetBkColor(wParam, BackColor);
                return _backBrush;

            case WM_ERASEBKGND:
            {
                GetClientRect(hwnd, out var area);
                FillRect(wParam, ref area, _backBrush);
                return new IntPtr(1);
            }

            case WM_SETFOCUS:
            {
                // A click on the text area lands here, and the typing belongs to the box inside.
                foreach (var entry in Edits)
                {
                    if (GetParent(entry.Key) == hwnd) { SetFocus(entry.Key); break; }
                }
                return IntPtr.Zero;
            }
        }
        return UiThread.DefWindowProcW(hwnd, message, wParam, lParam);
    }

    private IntPtr EditProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, UIntPtr id, UIntPtr data)
    {
        // Enter sends the message and Escape slides the panel away, which is what a chat box is expected to do.
        if (message == WM_KEYDOWN && wParam.ToInt32() == VK_RETURN) { SendTyped(); return IntPtr.Zero; }
        if (message == WM_KEYDOWN && wParam.ToInt32() == VK_ESCAPE)
        {
            _touched = true;
            _target = 0f;
            Refresh();
            return IntPtr.Zero;
        }
        if (message == WM_CHAR && (wParam.ToInt32() == VK_RETURN || wParam.ToInt32() == VK_ESCAPE)) return IntPtr.Zero;
        return DefSubclassProc(hwnd, message, wParam, lParam);
    }

    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern int FillRect(IntPtr dc, ref RECT rect, IntPtr brush);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageW(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLengthW(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool SetWindowTextW(IntPtr hwnd, string text);
    [DllImport("gdi32.dll")] private static extern uint SetTextColor(IntPtr dc, uint color);
    [DllImport("gdi32.dll")] private static extern uint SetBkColor(IntPtr dc, uint color);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateSolidBrush(uint color);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFontW(int h, int w, int esc, int orient, int weight, uint italic, uint underline, uint strike, uint charset, uint outPrec, uint clipPrec, uint quality, uint pitchFamily, string face);
    [DllImport("comctl32.dll")] private static extern bool SetWindowSubclass(IntPtr hwnd, SubclassProc proc, UIntPtr id, UIntPtr data);
    [DllImport("comctl32.dll")] private static extern IntPtr DefSubclassProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
}
