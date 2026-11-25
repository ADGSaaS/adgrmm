using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
using RemoteIQ.Agent.Shared;

namespace RemoteIQ.Agent.Services;

/// <summary>
/// Signed-in users (WTS) and running a process inside one user's session (WTSQueryUserToken + CreateProcessAsUser).
/// Needs SYSTEM, which the agent service is. Cannot be exercised in unit tests: it is tied to real Windows sessions.
/// </summary>
internal static class UserSessions
{
    public sealed record Session(int Id, string Account);

    // ── Who is signed in ───────────────────────────────────────────────────

    /// <summary>Sessions in state Active or Connected that have a user name.</summary>
    public static List<Session> ActiveSessions()
    {
        var list = new List<Session>();
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var buf, out var count)) return list;
        try
        {
            var size = Marshal.SizeOf<WTS_SESSION_INFO>();
            for (var i = 0; i < count; i++)
            {
                var info = Marshal.PtrToStructure<WTS_SESSION_INFO>(buf + i * size);
                if (info.State is not (WTS_ACTIVE or WTS_CONNECTED)) continue;
                var user = Query(info.SessionId, WTSUserName);
                if (string.IsNullOrWhiteSpace(user)) continue;
                var domain = Query(info.SessionId, WTSDomainName);
                list.Add(new Session(info.SessionId, string.IsNullOrWhiteSpace(domain) ? $"{Environment.MachineName}\\{user}" : $"{domain}\\{user}"));
            }
        }
        finally { WTSFreeMemory(buf); }
        return list;
    }

    public static Session? Find(string account) =>
        ActiveSessions().FirstOrDefault(s => SoftwareInventoryCore.SameAccount(s.Account, account, Environment.MachineName));

    private static string Query(int session, int infoClass)
    {
        if (!WTSQuerySessionInformation(IntPtr.Zero, session, infoClass, out var p, out _)) return "";
        try { return Marshal.PtrToStringUni(p) ?? ""; }
        finally { WTSFreeMemory(p); }
    }

    // ── Run in the user's session ──────────────────────────────────────────

    public static async Task<ProcessOutcome> RunAsync(string account, string file, IReadOnlyList<string> args, TimeSpan timeout, int maxOutputBytes, CancellationToken ct)
    {
        var session = Find(account) ?? throw new InvalidOperationException($"{account} is not signed in.");
        if (!WTSQueryUserToken(session.Id, out var token)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not get the user's token");
        var env = IntPtr.Zero;
        try
        {
            if (!CreateEnvironmentBlock(out env, token, false)) env = IntPtr.Zero;
            var envVars = env == IntPtr.Zero ? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) : ReadEnvironment(env);

            var resolved = file;
            if (!Path.IsPathRooted(file))
            {
                resolved = ResolveInUserEnvironment(file, envVars) ?? "";
                if (resolved.Length == 0) return new ProcessOutcome(null, "", "", false, NotFound: true);
            }

            var cwd = envVars.TryGetValue("USERPROFILE", out var up) && Directory.Exists(up) ? up : null;
            return await StartAndWait(token, env, resolved, args, cwd, timeout, maxOutputBytes, ct);
        }
        finally
        {
            if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
            CloseHandle(token);
        }
    }

    /// <summary>
    /// Starts a program in one signed-in user's session, as that user and without waiting for it. Returns its process id. The program gets the
    /// user's own environment and no console window; nothing it does runs with more rights than the user has.
    /// </summary>
    public static int Launch(int sessionId, string file, string arguments)
    {
        if (!WTSQueryUserToken(sessionId, out var token)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not get the user's token");
        var env = IntPtr.Zero;
        try
        {
            if (!CreateEnvironmentBlock(out env, token, false)) env = IntPtr.Zero;
            var vars = env == IntPtr.Zero ? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) : ReadEnvironment(env);
            var cwd = vars.TryGetValue("USERPROFILE", out var up) && Directory.Exists(up) ? up : null;
            var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), lpDesktop = "winsta0\\default" };
            var commandLine = new StringBuilder($"\"{file}\" {arguments}");
            if (!CreateProcessAsUser(token, file, commandLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env, cwd, ref si, out var pi))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not start the program in the user's session");
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            return pi.dwProcessId;
        }
        finally
        {
            if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
            CloseHandle(token);
        }
    }

    /// <summary>The user's WindowsApps folder first (App Installer is per user), then every folder on their PATH.</summary>
    private static string? ResolveInUserEnvironment(string name, Dictionary<string, string> env)
    {
        var folders = new List<string>();
        if (env.TryGetValue("LOCALAPPDATA", out var local)) folders.Add(Path.Combine(local, "Microsoft", "WindowsApps"));
        if (env.TryGetValue("PATH", out var path)) folders.AddRange(path.Split(';', StringSplitOptions.RemoveEmptyEntries));
        foreach (var f in folders)
        {
            try
            {
                var candidate = Path.Combine(f.Trim().Trim('"'), name);
                if (File.Exists(candidate)) return candidate;
            }
            catch { /* bad path entry */ }
        }
        return null;
    }

    private static Dictionary<string, string> ReadEnvironment(IntPtr block)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var p = block;
        while (true)
        {
            var s = Marshal.PtrToStringUni(p) ?? "";
            if (s.Length == 0) break;
            var eq = s.IndexOf('=', 1);
            if (eq > 0) result[s[..eq]] = s[(eq + 1)..];
            p += (s.Length + 1) * 2;
        }
        return result;
    }

    private static async Task<ProcessOutcome> StartAndWait(IntPtr token, IntPtr env, string file, IReadOnlyList<string> args, string? cwd,
        TimeSpan timeout, int maxOutputBytes, CancellationToken ct)
    {
        var sa = new SECURITY_ATTRIBUTES { Length = Marshal.SizeOf<SECURITY_ATTRIBUTES>(), InheritHandle = true };
        if (!CreatePipe(out var outR, out var outW, ref sa, 0)) throw new Win32Exception();
        if (!CreatePipe(out var errR, out var errW, ref sa, 0)) throw new Win32Exception();
        if (!CreatePipe(out var inR, out var inW, ref sa, 0)) throw new Win32Exception();
        // The parent's ends must not be inherited by the child, or the pipes never close.
        SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(errR, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(inW, HANDLE_FLAG_INHERIT, 0);

        var si = new STARTUPINFO
        {
            cb = Marshal.SizeOf<STARTUPINFO>(),
            lpDesktop = "winsta0\\default",
            dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW,
            wShowWindow = 0, // SW_HIDE
            hStdInput = inR, hStdOutput = outW, hStdError = errW,
        };

        var commandLine = new StringBuilder(SoftwareInstall.QuoteCommandLine(file, args));
        PROCESS_INFORMATION pi;
        var ok = CreateProcessAsUser(token, file, commandLine, IntPtr.Zero, IntPtr.Zero, true,
            CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env, cwd, ref si, out pi);
        var err = Marshal.GetLastWin32Error();

        // The child has its own copies now (or never started): close ours.
        CloseHandle(outW); CloseHandle(errW); CloseHandle(inR); CloseHandle(inW);
        if (!ok)
        {
            CloseHandle(outR); CloseHandle(errR);
            throw new Win32Exception(err, "Could not start the process in the user's session");
        }

        using var outStream = new FileStream(new SafeFileHandle(outR, true), FileAccess.Read, 4096, false);
        using var errStream = new FileStream(new SafeFileHandle(errR, true), FileAccess.Read, 4096, false);
        var outTask = ReadCapped(outStream, maxOutputBytes);
        var errTask = ReadCapped(errStream, maxOutputBytes);

        var timedOut = false;
        var cancelled = false;
        try
        {
            var deadline = DateTime.UtcNow + timeout;
            while (WaitForSingleObject(pi.hProcess, 0) != 0)
            {
                if (ct.IsCancellationRequested) { cancelled = true; break; }
                if (DateTime.UtcNow >= deadline) { timedOut = true; break; }
                await Task.Delay(250, CancellationToken.None);
            }

            if (timedOut || cancelled)
            {
                try { System.Diagnostics.Process.GetProcessById(pi.dwProcessId).Kill(entireProcessTree: true); }
                catch { TerminateProcess(pi.hProcess, 1); }
                WaitForSingleObject(pi.hProcess, 10000);
            }

            int? code = null;
            if (!timedOut && !cancelled && GetExitCodeProcess(pi.hProcess, out var ec)) code = ec;

            // Grandchildren can keep the pipes open; do not wait for them for long.
            var both = Task.WhenAll(outTask, errTask);
            await Task.WhenAny(both, Task.Delay(3000, CancellationToken.None));
            var so = outTask.IsCompletedSuccessfully ? outTask.Result : "";
            var se = errTask.IsCompletedSuccessfully ? errTask.Result : "";

            if (cancelled) throw new OperationCanceledException(ct);
            return new ProcessOutcome(code, so, se, timedOut);
        }
        finally
        {
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
        }
    }

    /// <summary>Keeps the first maxBytes of output and keeps draining, so the child never blocks on a full pipe.</summary>
    private static Task<string> ReadCapped(Stream s, int maxBytes) => Task.Run(() =>
    {
        var kept = new MemoryStream();
        var buf = new byte[4096];
        var truncated = false;
        try
        {
            int n;
            while ((n = s.Read(buf, 0, buf.Length)) > 0)
            {
                var room = maxBytes - (int)kept.Length;
                if (room > 0) kept.Write(buf, 0, Math.Min(room, n));
                if (n > room) truncated = true;
            }
        }
        catch { /* pipe closed */ }
        var text = Encoding.UTF8.GetString(kept.ToArray());
        return truncated ? text + "\n[output truncated]" : text;
    });

    // ── Native ─────────────────────────────────────────────────────────────

    private const int WTS_ACTIVE = 0, WTS_CONNECTED = 1, WTSUserName = 5, WTSDomainName = 7;
    private const uint STARTF_USESHOWWINDOW = 1, STARTF_USESTDHANDLES = 0x100, CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_NO_WINDOW = 0x08000000, HANDLE_FLAG_INHERIT = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct WTS_SESSION_INFO { public int SessionId; public IntPtr WinStationName; public int State; }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES { public int Length; public IntPtr SecurityDescriptor; public bool InheritHandle; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb; public string? lpReserved; public string? lpDesktop; public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public uint dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("wtsapi32.dll", SetLastError = true, EntryPoint = "WTSEnumerateSessionsW")]
    private static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr info, out int count);

    // The Unicode entry point: the plain name is the ANSI one, and its strings would be misread as UTF-16 below.
    [DllImport("wtsapi32.dll", SetLastError = true, EntryPoint = "WTSQuerySessionInformationW")]
    private static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr p);

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(int session, out IntPtr token);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr env);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(IntPtr token, string? application, StringBuilder commandLine, IntPtr processAttrs, IntPtr threadAttrs,
        bool inheritHandles, uint flags, IntPtr env, string? cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr h, uint ms);

    [DllImport("kernel32.dll")]
    private static extern bool GetExitCodeProcess(IntPtr h, out int code);

    [DllImport("kernel32.dll")]
    private static extern bool TerminateProcess(IntPtr h, uint code);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr h);
}
