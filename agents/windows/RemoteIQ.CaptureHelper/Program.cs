// agents/windows/RemoteIQ.CaptureHelper/Program.cs

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;

/// <summary>
/// Attaches a thread to whichever desktop is receiving input: normally the user's, otherwise the
/// secure one that shows sign-in, the lock screen and UAC prompts. Only SYSTEM may open that one.
/// </summary>
internal static class InputDesktop
{
    private const uint GENERIC_ALL = 0x10000000;

    [ThreadStatic]
    private static IntPtr _attached;

    /// <summary>Why the last attempt failed, for the technician and the agent's log.</summary>
    [ThreadStatic]
    public static string? LastError;

    private const uint ES_SYSTEM_REQUIRED = 0x1;
    private const uint ES_DISPLAY_REQUIRED = 0x2;
    private const uint MOUSEEVENTF_MOVE = 0x1;
    private const long WakeEveryMs = 3000;

    private static long _lastWakeMs = -WakeEveryMs;

    /// <summary>
    /// Turns the display back on. A device left alone turns it off, and nothing can be copied from it
    /// then. Moving the pointer by a pixel and back is what Windows treats as someone being there.
    /// </summary>
    public static void WakeDisplay()
    {
        var now = Environment.TickCount64;
        if (now - _lastWakeMs < WakeEveryMs) return;
        _lastWakeMs = now;

        SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
        mouse_event(MOUSEEVENTF_MOVE, 1, 0, 0, UIntPtr.Zero);
        mouse_event(MOUSEEVENTF_MOVE, -1, 0, 0, UIntPtr.Zero);
    }

    /// <summary>Which desktop is on screen and what state the session is in, for diagnosing a refused capture.</summary>
    public static string Describe()
    {
        var name = "unknown";
        var desktop = OpenInputDesktop(0, false, GENERIC_ALL);
        if (desktop != IntPtr.Zero)
        {
            var buffer = new StringBuilder(256);
            if (GetUserObjectInformationW(desktop, UOI_NAME, buffer, buffer.Capacity * 2, out _)) name = buffer.ToString();
            CloseDesktop(desktop);
        }

        var state = "unknown";
        if (WTSQuerySessionInformationW(IntPtr.Zero, WTS_CURRENT_SESSION, WTSConnectState, out var info, out _))
        {
            state = Marshal.ReadInt32(info) switch
            {
                0 => "active",
                1 => "connected",
                4 => "disconnected",
                var other => other.ToString(),
            };
            WTSFreeMemory(info);
        }

        return $"desktop {name}, session {state}, remote {GetSystemMetrics(SM_REMOTESESSION) != 0}";
    }

    /// <summary>
    /// How this session is being displayed: 0 at the device's own screen, 2 over Remote Desktop, -1 if unknown.
    /// Windows moves a signed-in user's session between the two when they connect or leave over Remote
    /// Desktop, and the screen handles of a process that was already running do not follow it.
    /// </summary>
    public static int DisplayKind()
    {
        if (!WTSQuerySessionInformationW(IntPtr.Zero, WTS_CURRENT_SESSION, WTSClientProtocolType, out var info, out _)) return -1;
        try
        {
            return Marshal.ReadInt16(info);
        }
        finally
        {
            WTSFreeMemory(info);
        }
    }

    private const int UOI_NAME = 2;
    private const int WTSClientProtocolType = 16;
    private const int WTSConnectState = 8;
    private const int SM_REMOTESESSION = 0x1000;
    private const uint WTS_CURRENT_SESSION = 0xFFFFFFFF;

    [DllImport("kernel32.dll")]
    private static extern uint SetThreadExecutionState(uint flags);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool WTSQuerySessionInformationW(IntPtr server, uint sessionId, int infoClass, out IntPtr buffer, out uint bytes);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr memory);

    public static bool Sync()
    {
        var desktop = OpenInputDesktop(0, false, GENERIC_ALL);
        if (desktop == IntPtr.Zero)
        {
            LastError = $"OpenInputDesktop failed with Windows error {Marshal.GetLastWin32Error()}";
            return false;
        }

        if (!SetThreadDesktop(desktop))
        {
            LastError = $"SetThreadDesktop failed with Windows error {Marshal.GetLastWin32Error()}";
            CloseDesktop(desktop);
            return false;
        }

        if (_attached != IntPtr.Zero) CloseDesktop(_attached);
        _attached = desktop;
        LastError = null;
        return true;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetThreadDesktop(IntPtr desktop);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr desktop);
}

internal static class Program
{
    // Protocol:
    // Client -> Server:
    //   "RIQ1" (4 bytes)
    //   version (int32) = 1
    //   secretLen (int32)
    //   secretUtf8 (bytes)
    //
    // Then frames in a loop:
    //   width (int32)
    //   height (int32)
    //   pixelFormat (int32) 1 = BGRA32, 2 = clipboard text, 3 = control message, 4 = chat reply
    //   frameLenBytes (int32)
    //   frameBytes (BGRA, or UTF-8 text)
    // The frame size follows the monitor being shown, so it changes when the technician switches monitor.
    private const int PixelFormatBgra32 = 1;
    private const int ControlTextFormat = 3;
    private const int ChatTextFormat = 4;
    private const int EndSessionFormat = 5;
    private const int ConsentAnswerFormat = 6;

    // Help avoid pipe fragmentation on large frames
    private const int PipeBufferBytes = 1 * 1024 * 1024; // 1MB
    private const long UnchangedResendMs = 150;

    [DllImport("winmm.dll")]
    private static extern uint timeBeginPeriod(uint milliseconds);

    public static int Main(string[] args)
    {
        try
        {
            // CRITICAL: Without DPI awareness, GetSystemMetrics and screen capture can be DPI-virtualized
            // (e.g. 2560x1440 @150% becomes ~1706x960) -> you capture low-res and upscale -> blurry.
            DpiUtil.TryEnablePerMonitorV2();

            var parsed = Args.Parse(args);

            if (string.IsNullOrWhiteSpace(parsed.PipeName))
                return Fail("Missing --pipe <name>.");

            if (string.IsNullOrWhiteSpace(parsed.Secret))
                return Fail("Missing --secret <token>.");

            // --w and --h are the largest picture to send. A smaller monitor is sent at its own size.
            int maxW = Math.Clamp(parsed.Width <= 0 ? 3840 : parsed.Width, 64, 7680);
            int maxH = Math.Clamp(parsed.Height <= 0 ? 3840 : parsed.Height, 64, 4320);
            int fps = Math.Clamp(parsed.Fps <= 0 ? 30 : parsed.Fps, 1, 60);

            // Only a helper started by the service has these rights, so nothing changes for one that is not.
            if (parsed.System) InputDesktop.Sync();

            var desktop = new DesktopState();
            desktop.Refresh();

            using var pipe = new NamedPipeClientStream(
                serverName: ".",
                pipeName: parsed.PipeName,
                direction: PipeDirection.InOut,
                options: PipeOptions.Asynchronous);

            // Connect with retry for a short window (service creates server first).
            var sw = Stopwatch.StartNew();
            while (true)
            {
                try
                {
                    pipe.Connect(750);
                    break;
                }
                catch
                {
                    if (sw.ElapsedMilliseconds > 15000)
                        throw new TimeoutException($"Timed out connecting to pipe '{parsed.PipeName}'.");
                }
            }

            TrySetPipeBuffer(pipe, PipeBufferBytes);

            using var bw = new BinaryWriter(pipe, Encoding.UTF8, leaveOpen: true);
            var writeLock = new object();

            // Handshake
            bw.Write((byte)'R');
            bw.Write((byte)'I');
            bw.Write((byte)'Q');
            bw.Write((byte)'1');
            bw.Write(1); // version

            var secretBytes = Encoding.UTF8.GetBytes(parsed.Secret);
            bw.Write(secretBytes.Length);
            bw.Write(secretBytes);
            bw.Flush();

            void SendText(int format, string text)
            {
                var bytes = Encoding.UTF8.GetBytes(text);
                lock (writeLock)
                {
                    bw.Write(0);
                    bw.Write(0);
                    bw.Write(format);
                    bw.Write(bytes.Length);
                    bw.Write(bytes);
                    bw.Flush();
                }
            }

            var ui = new UiThread();
            ui.Start();

            // Nothing a signed-in user can type into runs as SYSTEM. The one panel on the person's screen, with the
            // chat and the End session button in it, belongs to the helper that runs as that user.
            var panel = parsed.System ? null : new SidePanel(ui, reply => SendText(ChatTextFormat, reply), () => SendText(EndSessionFormat, ""));
            var chat = panel is null ? null : new ChatWindow(panel);
            var indicator = panel is null ? null : new IndicatorWindow(panel);

            // And the permission question, whose answer goes back to the agent.
            var prompts = panel is null ? null : new PromptHost(ui, panel, answer => SendText(ConsentAnswerFormat, answer));

            // Commands from the agent run on their own thread, so input does not wait for capture.
            using var input = new InputThread(pipe, bw, writeLock, desktop, ui, chat, parsed.System,
                () => SendText(ControlTextFormat, desktop.DescribeForTechnician()), indicator, prompts);
            input.Start();

            if (parsed.ChatOnly)
            {
                while (pipe.IsConnected && !input.Stopped) Thread.Sleep(200);
                return 0;
            }

            SendText(ControlTextFormat, desktop.DescribeForTechnician());
            SendText(ControlTextFormat, DisplayModes.Describe());

            // A helper replacing a blocked one starts clean, so the viewer's warning must not outlive it.
            SendText(ControlTextFormat, JsonSerializer.Serialize(new { type = "capture.blocked", blocked = false }));

            // A sleeping display gives black frames rather than an error, so nothing else would wake it.
            InputDesktop.WakeDisplay();

            int frameIntervalMs = (int)Math.Round(1000.0 / fps);
            var timer = Stopwatch.StartNew();
            long next = 0;
            long lastLayoutCheckMs = 0;
            long lastHeartbeatMs = 0;
            long frames = 0;

            var cursor = new CursorTracker(json => SendText(ControlTextFormat, json));
            var startDisplayKind = InputDesktop.DisplayKind();
            long captureTicks = 0;
            long captureCount = 0;
            long lastStatsMs = 0;

            bool blocked = false;
            string? blockedReason = null;
            byte[]? scaledReuse = null;
            byte[]? lastCapture = null;
            byte[]? spareCapture = null;
            long lastFrameSentMs = -UnchangedResendMs;

            // Windows sleeps in steps of about 15 ms by default, which makes capture uneven.
            timeBeginPeriod(1);

            DebugLog($"start pipe={parsed.PipeName} max={maxW}x{maxH} fps={fps}");

            while (pipe.IsConnected && !input.Stopped)
            {
                if (ConsoleCancelRequested.IsSet)
                    break;

                long now = timer.ElapsedMilliseconds;
                if (now < next)
                {
                    Thread.Sleep((int)Math.Min(10, next - now));
                    continue;
                }
                next = now + frameIntervalMs;

                if (now - lastLayoutCheckMs >= 2000)
                {
                    lastLayoutCheckMs = now;
                    if (desktop.Refresh()) SendText(ControlTextFormat, desktop.DescribeForTechnician());

                    // Someone connecting or leaving over Remote Desktop switches this session to another display, and
                    // the screen copy of a helper that was already running stops working. A new helper does not have
                    // that problem, so this one steps aside and the agent starts it.
                    var displayKind = InputDesktop.DisplayKind();
                    if (displayKind >= 0 && startDisplayKind >= 0 && displayKind != startDisplayKind)
                    {
                        DebugLog($"display changed from {startDisplayKind} to {displayKind}, exiting so a new helper starts");
                        return 0;
                    }
                }

                // Windows keeps the lock screen and UAC prompts out of reach of a program in the user's
                // session. The helper waits them out, so the picture comes back once they are gone.
                // A helper running as SYSTEM keeps trying from the desktop it is on if it cannot switch, so
                // only a capture that actually fails counts as blocked.
                string? reason = null;
                bool nowBlocked = false;
                if (parsed.System)
                {
                    if (!InputDesktop.Sync()) reason = InputDesktop.LastError;
                }
                else if (!ScreenCapture.CanReadInputDesktop())
                {
                    nowBlocked = true;
                    reason = "This helper runs as the signed-in user, which cannot read this screen";
                }

                byte[]? native = null;
                var monitor = desktop.Current;
                if (CursorTracker.Enabled) cursor.Tick(monitor, now);

                if (now - lastStatsMs >= 5000)
                {
                    lastStatsMs = now;
                    if (captureCount > 0)
                    {
                        var captureMs = captureTicks * 1000.0 / Stopwatch.Frequency / captureCount;
                        SendText(ControlTextFormat, JsonSerializer.Serialize(new { type = "helper.stats", captureMs = Math.Round(captureMs, 1), captures = captureCount, method = ScreenCapture.Method, problem = ScreenCapture.TakeNewProblem() }));
                        captureTicks = 0;
                        captureCount = 0;
                    }
                }

                if (!nowBlocked)
                {
                    try
                    {
                        var captureStart = Stopwatch.GetTimestamp();
                        native = ScreenCapture.CaptureBgra(monitor, spareCapture);
                        captureTicks += Stopwatch.GetTimestamp() - captureStart;
                        captureCount++;
                        spareCapture = null;
                    }
                    catch (InvalidOperationException ex)
                    {
                        reason = reason is null ? ex.Message : $"{reason}; {ex.Message}";
                        DebugLog(reason);
                        nowBlocked = true;

                        // The likely cause on a device nobody is using, and it only moves the pointer by a pixel.
                        if (parsed.System) InputDesktop.WakeDisplay();
                    }
                }

                if (nowBlocked != blocked || (nowBlocked && reason != blockedReason))
                {
                    blocked = nowBlocked;
                    blockedReason = reason;
                    SendText(ControlTextFormat, JsonSerializer.Serialize(new
                    {
                        type = "capture.blocked",
                        blocked = nowBlocked,
                        detail = nowBlocked ? $"{reason} (as SYSTEM: {parsed.System}, Windows session {Process.GetCurrentProcess().SessionId})" : null,
                    }));
                }

                if (native is null)
                {
                    next = now + 500;
                    continue;
                }

                // Copying an unchanged screen to the agent is the largest cost of an idle session. It still
                // goes now and then, which is what lets the encoder sharpen the picture.
                if (lastCapture is not null &&
                    now - lastFrameSentMs < UnchangedResendMs &&
                    native.AsSpan().SequenceEqual(lastCapture))
                {
                    spareCapture = native;
                    continue;
                }

                var (outW, outH) = FitInside(monitor.Width, monitor.Height, maxW, maxH);
                byte[] frameToSend = native;
                if (outW != monitor.Width || outH != monitor.Height)
                {
                    EnsureScaleBuffer(ref scaledReuse, outW, outH);
                    ImageScale.ScaleBgraBilinearInto(native, monitor.Width, monitor.Height, scaledReuse!, outW, outH);
                    frameToSend = scaledReuse!;
                }

                lock (writeLock)
                {
                    WriteFrame(bw, outW, outH, frameToSend);
                    bw.Flush();
                }

                lastFrameSentMs = now;
                spareCapture = lastCapture;
                lastCapture = native;

                frames++;
                if (now - lastHeartbeatMs >= 2000)
                {
                    lastHeartbeatMs = now;
                    DebugLog($"hb pipe={parsed.PipeName} frames={frames} monitor={monitor.Width}x{monitor.Height} out={outW}x{outH}");
                }
            }

            return 0;
        }
        catch (Exception ex)
        {
            DebugLog(ex.ToString());
            return 1;
        }
    }

    private static void EnsureScaleBuffer(ref byte[]? buf, int w, int h)
    {
        int needed = checked(w * h * 4);
        if (buf == null || buf.Length != needed)
            buf = new byte[needed];
    }

    // Keeps the shape of the monitor. VP8 frames need even dimensions, so an odd size is rounded down.
    private static (int Width, int Height) FitInside(int srcW, int srcH, int maxW, int maxH)
    {
        double scale = Math.Min(1.0, Math.Min((double)maxW / Math.Max(1, srcW), (double)maxH / Math.Max(1, srcH)));
        int w = Math.Max(64, (int)Math.Floor(srcW * scale)) & ~1;
        int h = Math.Max(64, (int)Math.Floor(srcH * scale)) & ~1;
        return (w, h);
    }

    private static int Fail(string msg)
    {
        DebugLog(msg);
        return 2;
    }

    private static void WriteFrame(BinaryWriter bw, int w, int h, byte[] frameBgra)
    {
        bw.Write(w);
        bw.Write(h);
        bw.Write(PixelFormatBgra32);
        bw.Write(frameBgra.Length);
        bw.Write(frameBgra);
    }

    private sealed class Args
    {
        public string PipeName { get; private set; } = "";
        public string Secret { get; private set; } = "";
        public int Width { get; private set; }
        public int Height { get; private set; }
        public int Fps { get; private set; }
        public bool System { get; private set; }
        public bool ChatOnly { get; private set; }

        public static Args Parse(string[] args)
        {
            var a = new Args();
            for (int i = 0; i < args.Length; i++)
            {
                var k = args[i];
                string v = (i + 1 < args.Length) ? args[i + 1] : "";

                if (k.Equals("--system", StringComparison.OrdinalIgnoreCase))
                {
                    a.System = true;
                }
                else if (k.Equals("--chat-only", StringComparison.OrdinalIgnoreCase))
                {
                    a.ChatOnly = true;
                }
                else if (k.Equals("--pipe", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    a.PipeName = v; i++;
                }
                else if (k.Equals("--secret", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    a.Secret = v; i++;
                }
                else if (k.Equals("--w", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length && int.TryParse(v, out var wi))
                {
                    a.Width = wi; i++;
                }
                else if (k.Equals("--h", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length && int.TryParse(v, out var hi))
                {
                    a.Height = hi; i++;
                }
                else if (k.Equals("--fps", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length && int.TryParse(v, out var fi))
                {
                    a.Fps = fi; i++;
                }
            }
            return a;
        }
    }

    private static class ImageScale
    {
        public static void ScaleBgraBilinearInto(byte[] src, int srcW, int srcH, byte[] dst, int dstW, int dstH)
        {
            if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0)
                throw new ArgumentOutOfRangeException("invalid dimensions");

            int dstBytes = checked(dstW * dstH * 4);
            if (dst.Length < dstBytes)
                throw new ArgumentException("dst buffer too small", nameof(dst));

            double xScale = (double)(srcW - 1) / Math.Max(1, dstW - 1);
            double yScale = (double)(srcH - 1) / Math.Max(1, dstH - 1);

            for (int y = 0; y < dstH; y++)
            {
                double sy = y * yScale;
                int y0 = (int)sy;
                int y1 = Math.Min(y0 + 1, srcH - 1);
                double fy = sy - y0;

                int dstRow = y * dstW * 4;
                int srcRow0 = y0 * srcW * 4;
                int srcRow1 = y1 * srcW * 4;

                for (int x = 0; x < dstW; x++)
                {
                    double sx = x * xScale;
                    int x0 = (int)sx;
                    int x1 = Math.Min(x0 + 1, srcW - 1);
                    double fx = sx - x0;

                    int i00 = srcRow0 + x0 * 4;
                    int i10 = srcRow0 + x1 * 4;
                    int i01 = srcRow1 + x0 * 4;
                    int i11 = srcRow1 + x1 * 4;

                    int d = dstRow + x * 4;

                    for (int c = 0; c < 4; c++)
                    {
                        double p00 = src[i00 + c];
                        double p10 = src[i10 + c];
                        double p01 = src[i01 + c];
                        double p11 = src[i11 + c];

                        double a = p00 + (p10 - p00) * fx;
                        double b = p01 + (p11 - p01) * fx;
                        double v = a + (b - a) * fy;

                        int iv = (int)Math.Round(v);
                        if (iv < 0) iv = 0;
                        else if (iv > 255) iv = 255;

                        dst[d + c] = (byte)iv;
                    }
                }
            }
        }
    }

    private static class ScreenCapture
    {
        public static bool CanReadInputDesktop()
        {
            var desk = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
            if (desk == IntPtr.Zero) return false;
            CloseDesktop(desk);
            return true;
        }

        private static readonly DesktopDuplication Duplication = new();
        private static readonly Stopwatch Clock = Stopwatch.StartNew();
        private static string? _reportedProblem;

        /// <summary>Which method supplied the last picture, for the Track line.</summary>
        public static string Method { get; private set; } = "gdi";

        public static string? TakeNewProblem()
        {
            var problem = Duplication.LastProblem;
            if (problem is null || problem == _reportedProblem) return null;
            _reportedProblem = problem;
            return problem;
        }

        // Which way of copying the screen worked last, so a way that is refused is not tried first every frame.
        private static int _gdiMode;

        public static byte[] CaptureBgra(MonitorRect m, byte[]? reuse = null)
        {
            // The fast method cannot work over Remote Desktop, so it is not tried there at all.
            if (CursorTracker.Enabled && GetSystemMetrics(SM_REMOTESESSION) == 0)
            {
                var fast = Duplication.TryCapture(m, reuse, Clock.ElapsedMilliseconds);
                if (fast is not null)
                {
                    Method = "dxgi";
                    return fast;
                }
            }

            // Windows refuses the plain screen copy of this process in some Remote Desktop sessions, while an
            // ordinary program is allowed. Other routes to the same screen are tried before giving up, and
            // the one that works is remembered.
            var notes = new List<string>();
            foreach (var mode in Enumerable.Range(0, 3).Select(i => (_gdiMode + i) % 3))
            {
                try
                {
                    var picture = CaptureWithMode(mode, m, reuse);
                    _gdiMode = mode;
                    Method = mode switch { 0 => "gdi", 1 => "gdi-thread", _ => "gdi-desktop" };
                    return picture;
                }
                catch (InvalidOperationException ex)
                {
                    notes.Add($"[{mode switch { 0 => "gdi", 1 => "gdi-thread", _ => "gdi-desktop" }}] {ex.Message}");
                }
            }

            throw new InvalidOperationException(string.Join(" | ", notes));
        }

        private static byte[] CaptureWithMode(int mode, MonitorRect m, byte[]? reuse)
        {
            if (mode == 0) return CaptureGdi(m, reuse, desktopWindowDc: false);
            if (mode == 2) return CaptureGdi(m, reuse, desktopWindowDc: true);

            // A fresh thread that behaves like an ordinary, DPI-unaware program, which the plain test of the same
            // session was allowed to do.
            byte[]? picture = null;
            Exception? failure = null;
            var thread = new Thread(() =>
            {
                try
                {
                    try { SetThreadDpiAwarenessContext(new IntPtr(-1)); } catch { /* an older Windows */ }
                    picture = CaptureGdi(m, null, desktopWindowDc: false);
                }
                catch (Exception ex)
                {
                    failure = ex;
                }
            }) { IsBackground = true, Name = "screen copy" };
            thread.Start();
            if (!thread.Join(3000)) throw new InvalidOperationException("the screen copy thread did not finish");
            if (picture is null) throw new InvalidOperationException(failure?.Message ?? "no picture");
            return picture;
        }

        private static byte[] CaptureGdi(MonitorRect m, byte[]? reuse, bool desktopWindowDc)
        {
            int w = m.Width;
            int h = m.Height;

            // The screen DC covers every monitor, in the same coordinates the monitor list uses.
            var sourceWindow = desktopWindowDc ? GetDesktopWindow() : IntPtr.Zero;
            IntPtr hSrcDc = GetDC(sourceWindow);
            if (hSrcDc == IntPtr.Zero)
                throw new InvalidOperationException("GetDC returned NULL.");

            IntPtr hMemDc = IntPtr.Zero;
            IntPtr hBmp = IntPtr.Zero;
            IntPtr hOld = IntPtr.Zero;

            try
            {
                hMemDc = CreateCompatibleDC(hSrcDc);
                if (hMemDc == IntPtr.Zero) throw new InvalidOperationException("CreateCompatibleDC returned NULL.");

                var bmi = new BITMAPINFO();
                bmi.bmiHeader.biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>();
                bmi.bmiHeader.biWidth = w;
                bmi.bmiHeader.biHeight = -h; // top-down
                bmi.bmiHeader.biPlanes = 1;
                bmi.bmiHeader.biBitCount = 32;
                bmi.bmiHeader.biCompression = BI_RGB;

                IntPtr ppvBits;
                hBmp = CreateDIBSection(hSrcDc, ref bmi, DIB_RGB_COLORS, out ppvBits, IntPtr.Zero, 0);
                if (hBmp == IntPtr.Zero || ppvBits == IntPtr.Zero)
                    throw new InvalidOperationException("CreateDIBSection failed.");

                hOld = SelectObject(hMemDc, hBmp);
                if (hOld == IntPtr.Zero) throw new InvalidOperationException("SelectObject failed.");

                CopyScreen(hMemDc, hSrcDc, m, w, h);

                // With the viewer drawing the pointer, it must not also be in the picture.
                if (!CursorTracker.Enabled) DrawCursor(hMemDc, m);

                int bytes = checked(w * h * 4);
                // Frames are large enough that allocating each one causes garbage collection pauses.
                byte[] buffer = reuse is not null && reuse.Length == bytes ? reuse : new byte[bytes];
                Marshal.Copy(ppvBits, buffer, 0, bytes);
                return buffer;
            }
            finally
            {
                if (hOld != IntPtr.Zero && hMemDc != IntPtr.Zero) SelectObject(hMemDc, hOld);
                if (hBmp != IntPtr.Zero) DeleteObject(hBmp);
                if (hMemDc != IntPtr.Zero) DeleteDC(hMemDc);
                if (hSrcDc != IntPtr.Zero) ReleaseDC(sourceWindow, hSrcDc);
            }
        }

        private static bool _skipCaptureBlt;

        // Windows refuses some of these on some screens, so each is tried before giving up. CAPTUREBLT
        // includes layered windows, and a picture without them beats no picture.
        private static void CopyScreen(IntPtr target, IntPtr screen, MonitorRect m, int w, int h)
        {
            int withLayers = 0;
            if (!_skipCaptureBlt)
            {
                if (BitBlt(target, 0, 0, w, h, screen, m.Left, m.Top, SRCCOPY | CAPTUREBLT)) return;
                withLayers = Marshal.GetLastWin32Error();
            }

            if (BitBlt(target, 0, 0, w, h, screen, m.Left, m.Top, SRCCOPY))
            {
                _skipCaptureBlt = true;
                return;
            }
            int plain = Marshal.GetLastWin32Error();

            int display = 0;
            var displayDc = CreateDCW("DISPLAY", null, null, IntPtr.Zero);
            if (displayDc == IntPtr.Zero)
            {
                display = Marshal.GetLastWin32Error();
            }
            else
            {
                try
                {
                    if (BitBlt(target, 0, 0, w, h, displayDc, m.Left, m.Top, SRCCOPY)) return;
                    display = Marshal.GetLastWin32Error();
                }
                finally
                {
                    DeleteDC(displayDc);
                }
            }

            throw new InvalidOperationException(
                $"Screen copy refused (errors: layered {withLayers}, plain {plain}, display {display}; " +
                $"monitor {m.Width}x{m.Height} at {m.Left},{m.Top}; {InputDesktop.Describe()})");
        }

        // BitBlt leaves the mouse pointer out, and a technician needs to see it.
        private static void DrawCursor(IntPtr hdc, MonitorRect m)
        {
            var info = new CURSORINFO { cbSize = Marshal.SizeOf<CURSORINFO>() };
            if (!GetCursorInfo(ref info) || (info.flags & CURSOR_SHOWING) == 0 || info.hCursor == IntPtr.Zero) return;
            if (!GetIconInfo(info.hCursor, out var icon)) return;

            try
            {
                DrawIconEx(hdc, info.ptScreenPos.X - m.Left - icon.xHotspot, info.ptScreenPos.Y - m.Top - icon.yHotspot, info.hCursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL);
            }
            finally
            {
                if (icon.hbmMask != IntPtr.Zero) DeleteObject(icon.hbmMask);
                if (icon.hbmColor != IntPtr.Zero) DeleteObject(icon.hbmColor);
            }
        }

        private const int CURSOR_SHOWING = 1;
        private const int DI_NORMAL = 3;

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

        [DllImport("user32.dll")]
        private static extern bool GetCursorInfo(ref CURSORINFO pci);

        [DllImport("user32.dll")]
        private static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);

        [DllImport("user32.dll")]
        private static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, int step, IntPtr brush, int flags);

        private const uint DESKTOP_READOBJECTS = 0x0001;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);

        [DllImport("user32.dll")]
        private static extern bool CloseDesktop(IntPtr desktop);

        private const int SRCCOPY = 0x00CC0020;
        private const int CAPTUREBLT = 0x40000000;

        private const uint BI_RGB = 0;
        private const uint DIB_RGB_COLORS = 0;

        [StructLayout(LayoutKind.Sequential)]
        private struct BITMAPINFO
        {
            public BITMAPINFOHEADER bmiHeader;
            public uint bmiColors;
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

        private const int SM_REMOTESESSION = 0x1000;

        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int index);

        [DllImport("user32.dll")]
        private static extern IntPtr GetDesktopWindow();

        [DllImport("user32.dll")]
        private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

        [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateDCW(string driver, string? device, string? output, IntPtr devMode);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool DeleteDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool DeleteObject(IntPtr ho);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern IntPtr CreateDIBSection(
            IntPtr hdc,
            [In] ref BITMAPINFO pbmi,
            uint iUsage,
            out IntPtr ppvBits,
            IntPtr hSection,
            uint dwOffset);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool BitBlt(
            IntPtr hdcDest,
            int xDest,
            int yDest,
            int wDest,
            int hDest,
            IntPtr hdcSrc,
            int xSrc,
            int ySrc,
            int rop);
    }

    // ------------------------ Utilities ------------------------

    private static class ConsoleCancelRequested
    {
        private static int _set;

        public static bool IsSet => Volatile.Read(ref _set) == 1;

        static ConsoleCancelRequested()
        {
            try
            {
                Console.CancelKeyPress += (_, e) =>
                {
                    e.Cancel = true;
                    Interlocked.Exchange(ref _set, 1);
                };
            }
            catch
            {
                // In WinExe there may not be a console; ignore.
            }
        }
    }

    private static void DebugLog(string message)
    {
        try { Debug.WriteLine(message); } catch { }
        try { OutputDebugString($"RemoteIQ.CaptureHelper: {message}\n"); } catch { }
    }

    private static void TrySetPipeBuffer(NamedPipeClientStream pipe, int bytes)
    {
        try
        {
            _ = pipe;
            _ = bytes;
        }
        catch
        {
            // ignore
        }
    }

    private static class DpiUtil
    {
        public static void TryEnablePerMonitorV2()
        {
            try
            {
                // PER_MONITOR_AWARE_V2
                SetProcessDpiAwarenessContext(new IntPtr(-4));
            }
            catch
            {
                // ignore
            }
        }

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiFlag);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern void OutputDebugString(string lpOutputString);
}
