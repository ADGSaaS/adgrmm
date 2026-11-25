// agents/windows/RemoteIQ.CaptureHelper/InputLock.cs

using System;
using System.Runtime.InteropServices;
using System.Threading;

/// <summary>
/// Keeps the person at the computer from using their own keyboard and mouse while a technician works, so they cannot interrupt.
/// Two low-level hooks swallow input that comes from the hardware. Input the technician sends (which this helper injects, and which
/// Windows marks as injected) goes through untouched. It cannot lock Ctrl+Alt+Del: Windows keeps that for the person at the computer,
/// and that is deliberate, because it is their way out if anything goes wrong.
/// The lock lets go by itself: when the technician unlocks, when the session ends, when this helper exits, and when the agent stops
/// sending its keep-alive for a while (the technician's connection broke without a goodbye).
/// </summary>
internal static class InputLock
{
    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    private const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14, HC_ACTION = 0;
    private const int LLKHF_INJECTED = 0x10, LLMHF_INJECTED = 0x01;
    private static readonly TimeSpan KeepAliveLimit = TimeSpan.FromSeconds(20);

    private static HookProc? _keyboardProc, _mouseProc;
    private static IntPtr _keyboard, _mouse;
    private static long _lastBeat;
    private static Timer? _watch;
    private static Action<bool>? _changed;

    public static bool Locked => _keyboard != IntPtr.Zero;

    /// <summary>Locks or unlocks. Call it on the thread that pumps messages (the UI thread): the hooks run on the thread that installed them.</summary>
    public static bool Set(bool on, Action<bool>? changed = null)
    {
        if (changed is not null) _changed = changed;
        if (on)
        {
            _lastBeat = Environment.TickCount64;
            if (Locked) return true;
            _keyboardProc = (code, w, l) => code == HC_ACTION && (Marshal.ReadInt32(l, 8) & LLKHF_INJECTED) == 0 ? (IntPtr)1 : CallNextHookEx(IntPtr.Zero, code, w, l);
            _mouseProc = (code, w, l) => code == HC_ACTION && (Marshal.ReadInt32(l, 12) & LLMHF_INJECTED) == 0 ? (IntPtr)1 : CallNextHookEx(IntPtr.Zero, code, w, l);
            var module = GetModuleHandle(null);
            _keyboard = SetWindowsHookEx(WH_KEYBOARD_LL, _keyboardProc, module, 0);
            _mouse = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, module, 0);
            if (_keyboard == IntPtr.Zero || _mouse == IntPtr.Zero) { Release(); return false; }
            _watch ??= new Timer(_ => Check(), null, TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(3));
            _changed?.Invoke(true);
            return true;
        }
        var was = Locked;
        Release();
        if (was) _changed?.Invoke(false);
        return true;
    }

    /// <summary>The agent says the technician is still there.</summary>
    public static void Beat() => _lastBeat = Environment.TickCount64;

    private static void Check()
    {
        if (!Locked || Environment.TickCount64 - _lastBeat < KeepAliveLimit.TotalMilliseconds) return;
        // the unhooking has to happen on the thread that hooked: the owner of the lock posts it
        Expired?.Invoke();
    }

    /// <summary>Raised on a timer thread when the keep-alive stopped. The owner unlocks on the UI thread.</summary>
    public static event Action? Expired;

    private static void Release()
    {
        if (_keyboard != IntPtr.Zero) UnhookWindowsHookEx(_keyboard);
        if (_mouse != IntPtr.Zero) UnhookWindowsHookEx(_mouse);
        _keyboard = _mouse = IntPtr.Zero;
        _keyboardProc = _mouseProc = null;
        _watch?.Dispose(); _watch = null;
    }

    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? name);
}
