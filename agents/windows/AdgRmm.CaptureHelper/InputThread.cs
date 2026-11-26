// agents/windows/AdgRmm.CaptureHelper/InputThread.cs

using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;

/// <summary>
/// Applies commands from the agent. The agent runs as a service in Session 0, which cannot touch
/// the user's desktop, so input and clipboard are carried out here in the user's session.
/// Only a helper running as SYSTEM can reach the secure desktop: sign-in, lock screen and UAC prompts.
/// </summary>
internal sealed class InputThread : IDisposable
{
    private const byte MoveMouse = 1;
    private const byte MouseEvent = 2;
    private const byte Key = 3;
    private const byte SetClipboard = 4;
    private const byte GetClipboard = 5;
    private const byte SelectMonitor = 6;
    private const byte ChatMessage = 7;
    private const byte SetLocalCursor = 8;
    private const byte WatchClipboard = 9;
    private const byte SetResolution = 10;
    private const byte ShowIndicator = 11;
    private const byte HideIndicator = 12;
    private const byte ShowNotice = 13;
    private const byte AskConsent = 14;
    private const byte LockInput = 15;

    private const int ControlTextFormat = 3;
    private const int ClipboardTextFormat = 2;
    private const int ClipboardLimitBytes = 4 * 1024 * 1024;

    private readonly PipeStream _pipe;
    private readonly BinaryWriter _writer;
    private readonly object _writeLock;
    private readonly Thread _thread;
    private readonly DesktopState _desktop;
    private readonly UiThread _ui;
    private readonly ChatWindow? _chat;
    private readonly bool _followInputDesktop;
    private readonly Action _monitorChanged;

    /// <summary>True once the agent has gone. Capture stops sending while a device is locked, so writes cannot be relied on to notice.</summary>
    public volatile bool Stopped;

    // Anything still held when the session ends is released, so no key or button stays stuck.
    private readonly HashSet<ushort> _keysDown = new();
    private readonly HashSet<uint> _buttonsDown = new();

    private readonly IndicatorWindow? _indicator;
    private readonly PromptHost? _prompts;

    public InputThread(PipeStream pipe, BinaryWriter writer, object writeLock, DesktopState desktop, UiThread ui, ChatWindow? chat, bool followInputDesktop, Action monitorChanged, IndicatorWindow? indicator = null, PromptHost? prompts = null)
    {
        _prompts = prompts;
        _pipe = pipe;
        _writer = writer;
        _writeLock = writeLock;
        _desktop = desktop;
        _ui = ui;
        _chat = chat;
        _indicator = indicator;
        _followInputDesktop = followInputDesktop;
        _monitorChanged = monitorChanged;
        _thread = new Thread(Run) { IsBackground = true, Name = "ADG RMM input" };
    }

    public void Start() => _thread.Start();

    private void Run()
    {
        try
        {
            using var reader = new BinaryReader(_pipe, Encoding.UTF8, leaveOpen: true);
            while (_pipe.IsConnected)
            {
                byte op = reader.ReadByte();
                int a = reader.ReadInt32();
                int b = reader.ReadInt32();

                // Input only reaches the desktop this thread is attached to, and that changes when a
                // sign-in screen or UAC prompt appears.
                if (_followInputDesktop && op is MoveMouse or MouseEvent or Key) InputDesktop.Sync();

                switch (op)
                {
                    case MoveMouse:
                        var point = _desktop.MapNormalized(a, b);
                        SetCursorPos(point.X, point.Y);
                        break;
                    case MouseEvent:
                        ApplyMouse((uint)a, b);
                        break;
                    case Key:
                        ApplyKey((ushort)a, b != 0);
                        break;
                    case SetClipboard:
                        if (a < 0 || a > ClipboardLimitBytes) return;
                        var incoming = Encoding.UTF8.GetString(reader.ReadBytes(a));
                        _ui.Post(() => WriteClipboard(incoming));
                        break;
                    case GetClipboard:
                        _ui.Post(SendClipboard);
                        break;
                    case SetLocalCursor:
                        CursorTracker.Enabled = a != 0;
                        break;
                    case WatchClipboard:
                        _ui.Post(() => _ui.WatchClipboard(SendCopiedText));
                        break;
                    case SelectMonitor:
                        if (_desktop.Select(a)) _monitorChanged();
                        break;
                    case ShowIndicator:
                        if (a < 0 || a > 4096) return;
                        var indicatorText = Encoding.UTF8.GetString(reader.ReadBytes(a));
                        _indicator?.Show(indicatorText);
                        break;
                    case HideIndicator:
                        _indicator?.Hide();
                        break;
                    case ShowNotice:
                    case AskConsent:
                        if (a < 0 || a > 4096) return;
                        var promptJson = Encoding.UTF8.GetString(reader.ReadBytes(a));
                        HandlePrompt(op, promptJson);
                        break;
                    case SetResolution:
                        var failure = DisplayModes.Apply(a, b);
                        SendControl(JsonSerializer.Serialize(new { type = "display.result", ok = failure.Length == 0, message = failure, w = a, h = b }));
                        SendControl(DisplayModes.Describe());
                        break;
                    case LockInput:
                        // a = 1 locks (and is repeated as the keep-alive), a = 0 unlocks
                        if (a != 0 && InputLock.Locked) InputLock.Beat();
                        else _ui.Post(() => ApplyLock(a != 0));
                        break;
                    case ChatMessage:
                        if (a < 0 || a > ClipboardLimitBytes) return;
                        var chatText = Encoding.UTF8.GetString(reader.ReadBytes(a));
                        _chat?.ShowMessage(chatText);
                        break;
                }
            }
        }
        catch (EndOfStreamException)
        {
            // the agent closed the session
        }
        catch (IOException)
        {
            // the agent closed the session
        }
        catch (ObjectDisposedException)
        {
            // the helper is exiting
        }
        finally
        {
            Stopped = true;
            try { _ui.Post(() => InputLock.Set(false)); } catch { /* the helper is going away, and the hooks go with it */ }
            if (_followInputDesktop) InputDesktop.Sync();
            ReleaseAll();
        }
    }

    private bool _lockWired;

    private void ApplyLock(bool on)
    {
        if (!_lockWired)
        {
            _lockWired = true;
            InputLock.Expired += () => { try { _ui.Post(() => InputLock.Set(false)); } catch { /* ending */ } };
        }
        var ok = InputLock.Set(on, state => SendControl(JsonSerializer.Serialize(new { type = "input.lock.state", locked = state, ok = true })));
        if (on && !ok) SendControl(JsonSerializer.Serialize(new { type = "input.lock.state", locked = false, ok = false, message = "Windows would not let the keyboard and mouse be locked on this computer." }));
    }

    private void ApplyMouse(uint flags, int data)
    {
        if ((flags & (MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_RIGHTDOWN | MOUSEEVENTF_MIDDLEDOWN)) != 0) _buttonsDown.Add(flags);
        if ((flags & MOUSEEVENTF_LEFTUP) != 0) _buttonsDown.Remove(MOUSEEVENTF_LEFTDOWN);
        if ((flags & MOUSEEVENTF_RIGHTUP) != 0) _buttonsDown.Remove(MOUSEEVENTF_RIGHTDOWN);
        if ((flags & MOUSEEVENTF_MIDDLEUP) != 0) _buttonsDown.Remove(MOUSEEVENTF_MIDDLEDOWN);
        SendMouse(flags, data);
    }

    private void ApplyKey(ushort vk, bool down)
    {
        if (down) _keysDown.Add(vk);
        else _keysDown.Remove(vk);
        SendKey(vk, down);
    }

    private void ReleaseAll()
    {
        foreach (var vk in _keysDown) SendKey(vk, false);
        _keysDown.Clear();

        foreach (var flag in _buttonsDown)
        {
            if (flag == MOUSEEVENTF_LEFTDOWN) SendMouse(MOUSEEVENTF_LEFTUP, 0);
            else if (flag == MOUSEEVENTF_RIGHTDOWN) SendMouse(MOUSEEVENTF_RIGHTUP, 0);
            else if (flag == MOUSEEVENTF_MIDDLEDOWN) SendMouse(MOUSEEVENTF_MIDDLEUP, 0);
        }
        _buttonsDown.Clear();
    }

    private static void SendMouse(uint flags, int data)
    {
        var inputs = new[]
        {
            new INPUT
            {
                type = INPUT_MOUSE,
                U = new InputUnion { mi = new MOUSEINPUT { mouseData = (uint)data, dwFlags = flags } },
            },
        };
        SendInput(1, inputs, Marshal.SizeOf<INPUT>());
    }

    private static void SendKey(ushort vk, bool down)
    {
        uint flags = down ? 0u : KEYEVENTF_KEYUP;
        if (IsExtended(vk)) flags |= KEYEVENTF_EXTENDEDKEY;

        var inputs = new[]
        {
            new INPUT
            {
                type = INPUT_KEYBOARD,
                U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = (ushort)MapVirtualKey(vk, 0), dwFlags = flags } },
            },
        };
        SendInput(1, inputs, Marshal.SizeOf<INPUT>());
    }

    // Without this flag, arrows and navigation keys act as their numeric keypad versions.
    private static bool IsExtended(ushort vk) => vk is
        0x21 or 0x22 or 0x23 or 0x24 or          // Page Up, Page Down, End, Home
        0x25 or 0x26 or 0x27 or 0x28 or          // arrows
        0x2C or 0x2D or 0x2E or                  // Print Screen, Insert, Delete
        0x5B or 0x5C or 0x5D or                  // Windows keys, Menu
        0x6F or 0x90 or                          // numpad divide, Num Lock
        0xA3 or 0xA5;                            // right Ctrl, right Alt

    private void WriteClipboard(string text)
    {
        if (!OpenClipboardWithRetry()) return;
        try
        {
            EmptyClipboard();

            var bytes = (text.Length + 1) * 2;
            var memory = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes);
            if (memory == IntPtr.Zero) return;

            var target = GlobalLock(memory);
            if (target == IntPtr.Zero)
            {
                GlobalFree(memory);
                return;
            }
            Marshal.Copy(text.ToCharArray(), 0, target, text.Length);
            Marshal.WriteInt16(target, text.Length * 2, 0);
            GlobalUnlock(memory);

            // On success the clipboard owns the memory.
            if (SetClipboardData(CF_UNICODETEXT, memory) == IntPtr.Zero) GlobalFree(memory);
        }
        finally
        {
            CloseClipboard();
        }
    }

    /// <summary>
    /// Something was copied on the device. Password managers mark their entries to be left out of
    /// tools like this one, and that request is honored.
    /// </summary>
    /// <summary>A notice or a permission question from the agent. The text is cut to a sensible length before it is shown.</summary>
    private void HandlePrompt(byte op, string json)
    {
        if (_prompts is null) return;

        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var seconds = root.TryGetProperty("seconds", out var s) && s.TryGetInt32(out var n) ? n : 20;

            if (op == ShowNotice)
            {
                var title = Cut(root.TryGetProperty("title", out var t) ? t.GetString() : null, 60, "Remote access");
                var message = Cut(root.TryGetProperty("message", out var m) ? m.GetString() : null, 240, "");
                _prompts.ShowNotice(title, message, seconds);
            }
            else
            {
                var technician = Cut(root.TryGetProperty("technician", out var who) ? who.GetString() : null, 60, "A technician");
                _prompts.AskConsent(technician, seconds);
            }
        }
        catch (JsonException)
        {
            // A message that cannot be read is not shown.
        }
    }

    private static string Cut(string? text, int max, string fallback)
    {
        var clean = new string((text ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (clean.Length > max) clean = clean[..max];
        return clean.Length == 0 ? fallback : clean;
    }

    /// <summary>Sends a control message to the agent, which passes it on to the viewer.</summary>
    private void SendControl(string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        lock (_writeLock)
        {
            _writer.Write(0);
            _writer.Write(0);
            _writer.Write(ControlTextFormat);
            _writer.Write(bytes.Length);
            _writer.Write(bytes);
            _writer.Flush();
        }
    }

    private void SendCopiedText()
    {
        if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return;
        if (IsClipboardFormatAvailable(RegisterClipboardFormatW("ExcludeClipboardContentFromMonitorProcessing"))) return;
        SendClipboard();
    }

    private void SendClipboard()
    {
        var text = "";
        if (OpenClipboardWithRetry())
        {
            try
            {
                var data = GetClipboardData(CF_UNICODETEXT);
                if (data != IntPtr.Zero)
                {
                    var source = GlobalLock(data);
                    if (source != IntPtr.Zero)
                    {
                        text = Marshal.PtrToStringUni(source) ?? "";
                        GlobalUnlock(data);
                    }
                }
            }
            finally
            {
                CloseClipboard();
            }
        }

        var bytes = Encoding.UTF8.GetBytes(text);
        if (bytes.Length > ClipboardLimitBytes) bytes = Array.Empty<byte>();

        lock (_writeLock)
        {
            _writer.Write(0);
            _writer.Write(0);
            _writer.Write(ClipboardTextFormat);
            _writer.Write(bytes.Length);
            _writer.Write(bytes);
            _writer.Flush();
        }
    }

    // Other programs hold the clipboard briefly, so a failed open is normal.
    // It opens with a window because Windows documents that SetClipboardData fails if the owner is NULL.
    private bool OpenClipboardWithRetry()
    {
        for (int i = 0; i < 10; i++)
        {
            if (OpenClipboard(_ui.Handle)) return true;
            Thread.Sleep(20);
        }
        return false;
    }

    public void Dispose()
    {
        // The thread is a background thread and ends when the pipe closes.
    }

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint CF_UNICODETEXT = 13;
    private const uint GMEM_MOVEABLE = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr hWndNewOwner);

    [DllImport("user32.dll")]
    private static extern bool IsClipboardFormatAvailable(uint format);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint RegisterClipboardFormatW(string name);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetClipboardData(uint uFormat);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalUnlock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalFree(IntPtr hMem);
}
