// agents/windows/AdgRmm.CaptureHelper/UiThread.cs

using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

/// <summary>
/// A thread that keeps a Windows message loop running. The chat window lives here, and so does the
/// clipboard owner, because Windows sends the owner messages that other programs wait on.
/// </summary>
internal sealed class UiThread
{
    private const uint WM_APP = 0x8000;
    private const uint WM_CLIPBOARDUPDATE = 0x031D;
    private Action? _clipboardChanged;
    private static readonly IntPtr HWND_MESSAGE = new(-3);

    private readonly ConcurrentQueue<Action> _work = new();
    private readonly ManualResetEventSlim _ready = new();
    private readonly Thread _thread;
    private WndProc? _proc; // kept in a field so the collector cannot free it while Windows holds it

    public IntPtr Handle { get; private set; }

    /// <summary>The window whose Tab, Enter and Esc keys need dialog handling, if any.</summary>
    public IntPtr DialogWindow { get; set; }

    public UiThread()
    {
        _thread = new Thread(Run) { IsBackground = true, Name = "ADG RMM UI" };
        _thread.SetApartmentState(ApartmentState.STA);
    }

    public void Start()
    {
        _thread.Start();
        _ready.Wait(5000);
    }

    public void Post(Action action)
    {
        _work.Enqueue(action);
        PostMessageW(Handle, WM_APP, IntPtr.Zero, IntPtr.Zero);
    }

    private void Run()
    {
        _proc = HostProc;
        var cls = new WNDCLASSW
        {
            lpfnWndProc = _proc,
            hInstance = GetModuleHandleW(null),
            lpszClassName = "AdgRmmHelperHost",
        };
        if (RegisterClassW(ref cls) == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "RegisterClass");

        Handle = CreateWindowExW(0, cls.lpszClassName, "", 0, 0, 0, 0, 0, HWND_MESSAGE, IntPtr.Zero, cls.hInstance, IntPtr.Zero);
        _ready.Set();

        while (GetMessageW(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            if (DialogWindow != IntPtr.Zero && IsDialogMessageW(DialogWindow, ref msg)) continue;
            TranslateMessage(ref msg);
            DispatchMessageW(ref msg);
        }
    }

    /// <summary>Runs the callback whenever something on this device changes the clipboard.</summary>
    public void WatchClipboard(Action onChanged)
    {
        var first = _clipboardChanged is null;
        _clipboardChanged = onChanged;
        if (first) AddClipboardFormatListener(Handle);
    }

    private IntPtr HostProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        if (message == WM_CLIPBOARDUPDATE)
        {
            try { _clipboardChanged?.Invoke(); }
            catch (Exception) { /* a program holding the clipboard must not end the session */ }
            return IntPtr.Zero;
        }

        if (message != WM_APP) return DefWindowProcW(hwnd, message, wParam, lParam);

        while (_work.TryDequeue(out var action))
        {
            try { action(); }
            catch (Exception) { /* one failed request must not end the session */ }
        }
        return IntPtr.Zero;
    }

    internal delegate IntPtr WndProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct WNDCLASSW
    {
        public uint style;
        [MarshalAs(UnmanagedType.FunctionPtr)] public WndProc lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr GetModuleHandleW(string? name);

    [DllImport("user32.dll")]
    private static extern bool AddClipboardFormatListener(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern ushort RegisterClassW(ref WNDCLASSW cls);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr CreateWindowExW(uint exStyle, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr DefWindowProcW(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool PostMessageW(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool IsDialogMessageW(IntPtr dialog, ref MSG msg);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG msg);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DispatchMessageW(ref MSG msg);
}
