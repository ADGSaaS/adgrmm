// agents/windows/AdgRmm.Agent/Services/ConsoleHelperSession.cs

using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;

namespace AdgRmm.Agent.Services;

/// <summary>Finds the Windows session a technician should see.</summary>
internal static class ConsoleSessions
{
    private const uint NoSession = 0xFFFFFFFF;
    private const int WtsActive = 0;
    private const int WtsUserName = 5;

    public static bool RunningAsSystem()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return identity.IsSystem;
    }

    /// <summary>
    /// The signed-in session that is on screen, which is the one someone is using, whether at the
    /// device or over Remote Desktop. With nobody signed in it is the console's sign-in screen,
    /// which Windows keeps running. Null only when no session exists, such as during startup.
    /// </summary>
    public static uint? FindTarget()
    {
        var console = WTSGetActiveConsoleSessionId();
        if (console != NoSession && HasUser(console) && IsActive(console)) return console;

        foreach (var session in Enumerate())
        {
            if (session.State == WtsActive && session.Id != 0 && HasUser(session.Id)) return session.Id;
        }

        return console == NoSession ? null : console;
    }

    private static bool IsActive(uint sessionId) => Enumerate().Any(s => s.Id == sessionId && s.State == WtsActive);

    /// <summary>Whether someone is signed in to the session on screen, so a helper can run as them.</summary>
    public static bool SomeoneSignedIn() => FindTarget() is { } target && HasUser(target);

    /// <summary>
    /// DOMAIN\user for the signed-in session on screen, which may be a Remote Desktop one. Windows reports the
    /// console's user separately, and that is empty while the user's session is shown over Remote Desktop.
    /// </summary>
    public static string? TargetUser()
    {
        if (FindTarget() is not { } session) return null;

        var user = QuerySessionString(session, WtsUserName).Trim();
        if (user.Length == 0) return null;

        var domain = QuerySessionString(session, WtsDomainName).Trim();
        return domain.Length == 0 ? user : $"{domain}\\{user}";
    }

    private const int WtsDomainName = 7;

    private static string QuerySessionString(uint sessionId, int infoClass)
    {
        if (!WTSQuerySessionInformationW(IntPtr.Zero, sessionId, infoClass, out var buffer, out _)) return "";
        try
        {
            return Marshal.PtrToStringUni(buffer) ?? "";
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
    }

    // MessageBox styles, as WTSSendMessage takes them.
    private const uint MbOk = 0x0, MbYesNo = 0x4, MbIconQuestion = 0x20, MbIconInformation = 0x40,
        MbDefButton2 = 0x100, MbSetForeground = 0x10000, MbTopmost = 0x40000;
    private const int IdYes = 6, IdNo = 7;

    public enum ConsentAnswer { Allowed, Declined, NoAnswer, Unavailable }

    /// <summary>
    /// Asks the person signed in at the device whether to allow a technician. The service shows this in
    /// their own session, so it is the real Windows prompt on their screen. No answer counts as No.
    /// This waits for the answer, so call it from a thread that can block.
    /// </summary>
    public static ConsentAnswer AskToAllow(string? technician, int timeoutSeconds)
    {
        if (FindTarget() is not { } session || !HasUser(session)) return ConsentAnswer.Unavailable;

        var title = "Remote access request";
        var message = $"{CleanName(technician)} from your IT provider wants to view and control this computer.\n\n"
            + $"Allow this?\n\nIf you do not answer within {timeoutSeconds} seconds, it will be refused.";

        try
        {
            if (!WTSSendMessageW(IntPtr.Zero, session, title, title.Length * 2, message, message.Length * 2,
                    MbYesNo | MbIconQuestion | MbDefButton2 | MbSetForeground | MbTopmost, (uint)timeoutSeconds, out var response, true))
                return ConsentAnswer.Unavailable;

            return response switch { IdYes => ConsentAnswer.Allowed, IdNo => ConsentAnswer.Declined, _ => ConsentAnswer.NoAnswer };
        }
        catch (Exception)
        {
            return ConsentAnswer.Unavailable;
        }
    }

    /// <summary>Tells the person signed in at the device who connected. It does not wait, and goes away by itself.</summary>
    public static void TellSomeoneConnected(string? technician, int showSeconds)
    {
        if (FindTarget() is not { } session || !HasUser(session)) return;

        var title = "Remote access started";
        var message = $"{CleanName(technician)} from your IT provider has connected to this computer to provide support.";

        try
        {
            WTSSendMessageW(IntPtr.Zero, session, title, title.Length * 2, message, message.Length * 2,
                MbOk | MbIconInformation | MbTopmost, (uint)showSeconds, out _, false);
        }
        catch (Exception)
        {
            // A notice that cannot be shown must not stop the session.
        }
    }

    /// <summary>The technician's name as it will be shown to someone else, so it cannot carry line breaks or run on.</summary>
    internal static string CleanName(string? name)
    {
        var text = new string((name ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (text.Length > 60) text = text[..60];
        return text.Length == 0 ? "A technician" : text;
    }

    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool WTSSendMessageW(IntPtr server, uint sessionId, string title, int titleLength, string message, int messageLength,
        uint style, uint timeout, out int response, bool wait);

    private static bool HasUser(uint sessionId)
    {
        if (!WTSQuerySessionInformationW(IntPtr.Zero, sessionId, WtsUserName, out var buffer, out _)) return false;
        try
        {
            return !string.IsNullOrWhiteSpace(Marshal.PtrToStringUni(buffer));
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
    }

    private static List<(uint Id, int State)> Enumerate()
    {
        var found = new List<(uint, int)>();
        if (!WTSEnumerateSessionsW(IntPtr.Zero, 0, 1, out var list, out var count)) return found;
        try
        {
            var size = Marshal.SizeOf<WTS_SESSION_INFO>();
            for (var i = 0; i < count; i++)
            {
                var info = Marshal.PtrToStructure<WTS_SESSION_INFO>(list + (i * size));
                found.Add(((uint)info.SessionId, info.State));
            }
        }
        finally
        {
            WTSFreeMemory(list);
        }
        return found;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WTS_SESSION_INFO
    {
        public int SessionId;
        public IntPtr WinStationName;
        public int State;
    }

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool WTSEnumerateSessionsW(IntPtr server, int reserved, int version, out IntPtr sessions, out int count);

    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool WTSQuerySessionInformationW(IntPtr server, uint sessionId, int infoClass, out IntPtr buffer, out uint bytes);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr memory);
}

/// <summary>
/// A capture helper started as SYSTEM in a chosen session. Only SYSTEM can read the sign-in screen,
/// the lock screen and UAC prompts, and it needs nobody to be signed in. So nothing that a signed-in
/// user can type into runs this way: the chat window has its own helper, running as that user.
/// </summary>
internal sealed class SystemHelperProcess : IDisposable
{
    private const uint TOKEN_ALL_ACCESS = 0xF01FF;
    private const int TokenSessionId = 12;
    private const int SecurityImpersonation = 2;
    private const int TokenPrimary = 1;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint WAIT_OBJECT_0 = 0;

    private IntPtr _process;

    private SystemHelperProcess(IntPtr process) => _process = process;

    public static SystemHelperProcess Start(string exePath, string arguments, uint sessionId)
    {
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out var own))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed");

        var token = IntPtr.Zero;
        try
        {
            if (!DuplicateTokenEx(own, TOKEN_ALL_ACCESS, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out token))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateTokenEx failed");

            if (!SetTokenInformation(token, TokenSessionId, ref sessionId, sizeof(uint)))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetTokenInformation failed");

            var startup = new STARTUPINFO
            {
                cb = Marshal.SizeOf<STARTUPINFO>(),
                lpDesktop = @"winsta0\default",
            };
            var commandLine = new StringBuilder($"\"{exePath}\" {arguments}");
            var workingDirectory = Path.GetDirectoryName(exePath);

            if (!CreateProcessAsUserW(token, exePath, commandLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_NO_WINDOW,
                    IntPtr.Zero, workingDirectory, ref startup, out var info))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUser failed");

            CloseHandle(info.hThread);
            return new SystemHelperProcess(info.hProcess);
        }
        finally
        {
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(own);
        }
    }

    public bool HasExited => _process == IntPtr.Zero || WaitForSingleObject(_process, 0) == WAIT_OBJECT_0;

    public uint? ExitCode => _process != IntPtr.Zero && HasExited && GetExitCodeProcess(_process, out var code) ? code : null;

    /// <summary>A process running as SYSTEM must never outlive its session.</summary>
    public void Dispose()
    {
        if (_process == IntPtr.Zero) return;

        // Closing the pipe tells it to exit and release anything held, so it gets a moment to do that.
        if (WaitForSingleObject(_process, 3000) != WAIT_OBJECT_0) TerminateProcess(_process, 1);
        CloseHandle(_process);
        _process = IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(IntPtr token, int infoClass, ref uint info, int length);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUserW(IntPtr token, string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment,
        string? currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}

/// <summary>
/// Sends Ctrl+Alt+Del. Windows ignores those keys when a program types them, so a sign-in screen that
/// asks for them can only be reached this way.
/// </summary>
internal static class SecureAttention
{
    private const string PolicyKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
    private const string PolicyValue = "SoftwareSASGeneration";
    private const int AllowServices = 1;
    private const int RestoreAfterMs = 3000;

    private static readonly object Gate = new();

    public static void Send(ILogger log)
    {
        lock (Gate)
        {
            try
            {
                // Windows refuses unless policy allows services to do this, so it is allowed only for
                // the moment it is needed, and this machine's setting is put back afterwards.
                using var key = Registry.LocalMachine.CreateSubKey(PolicyKey, writable: true);
                var previous = key.GetValue(PolicyValue);
                var current = previous is int value ? value : 0;
                var changed = (current & AllowServices) == 0;
                if (changed) key.SetValue(PolicyValue, current | AllowServices, RegistryValueKind.DWord);

                SendSAS(false);

                if (changed)
                {
                    Thread.Sleep(RestoreAfterMs);
                    if (previous is null) key.DeleteValue(PolicyValue, throwOnMissingValue: false);
                    else key.SetValue(PolicyValue, previous, RegistryValueKind.DWord);
                }
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "RemoteConsole could not send Ctrl+Alt+Del");
            }
        }
    }

    [DllImport("sas.dll")]
    private static extern void SendSAS([MarshalAs(UnmanagedType.Bool)] bool asUser);
}
