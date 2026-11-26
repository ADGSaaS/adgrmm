using System.Diagnostics.Eventing.Reader;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32;
using AdgRmm.Agent.Shared;

namespace AdgRmm.Agent.Services;

/// <summary>
/// Programs installed for one user (their own hive), and who installed machine programs (Application event log).
/// The agent runs as SYSTEM, so it can load profiles that are not logged in. Every step is best effort.
/// </summary>
internal static class UserSoftwareReader
{
    private static readonly string[] UninstallPaths =
    {
        @"Software\Microsoft\Windows\CurrentVersion\Uninstall",
        @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    };

    private const string ProfileListKey = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList";

    // ── Per-user programs ──────────────────────────────────────────────────

    public static List<SoftwareItem> ReadAllUsers(Action<string>? log = null, Func<string, bool>? accountFilter = null)
    {
        var items = new List<SoftwareItem>();
        HashSet<string> loaded = new(StringComparer.OrdinalIgnoreCase);

        // Users that are logged in already have their hive under HKEY_USERS.
        try
        {
            foreach (var sid in Registry.Users.GetSubKeyNames().Where(SoftwareInventoryCore.IsUserSid))
            {
                loaded.Add(sid);
                try
                {
                    var account = AccountName(sid, null);
                    if (accountFilter is null || accountFilter(account)) items.AddRange(ReadHive(sid, account));
                }
                catch (Exception ex) { log?.Invoke($"user software {sid}: {ex.Message}"); }
            }
        }
        catch (Exception ex) { log?.Invoke($"user software (loaded hives): {ex.Message}"); }

        // Everyone else: load their NTUSER.DAT, read it, unload it.
        try
        {
            using var list = Registry.LocalMachine.OpenSubKey(ProfileListKey);
            if (list is not null)
            {
                foreach (var sid in list.GetSubKeyNames().Where(s => SoftwareInventoryCore.IsUserSid(s) && !loaded.Contains(s)))
                {
                    try
                    {
                        using var p = list.OpenSubKey(sid);
                        var folder = Environment.ExpandEnvironmentVariables(p?.GetValue("ProfileImagePath")?.ToString() ?? "");
                        if (string.IsNullOrWhiteSpace(folder)) continue;
                        var dat = Path.Combine(folder, "NTUSER.DAT");
                        if (!File.Exists(dat)) continue;
                        var account = AccountName(sid, folder);
                        if (accountFilter is null || accountFilter(account)) items.AddRange(ReadUnloadedHive(sid, dat, account, log));
                    }
                    catch (Exception ex) { log?.Invoke($"user software {sid}: {ex.Message}"); }
                }
            }
        }
        catch (Exception ex) { log?.Invoke($"user software (profiles): {ex.Message}"); }

        return items;
    }

    private static List<SoftwareItem> ReadUnloadedHive(string sid, string datPath, string account, Action<string>? log)
    {
        EnablePrivilege("SeBackupPrivilege");
        EnablePrivilege("SeRestorePrivilege");

        var name = "AdgRmm_" + sid.Replace('-', '_');
        var rc = RegLoadKey(HKEY_USERS, name, datPath);
        if (rc != 0) { log?.Invoke($"could not load {datPath} (error {rc})"); return new List<SoftwareItem>(); }
        try
        {
            return ReadHive(name, account);
        }
        finally
        {
            // Registry handles must be gone before the hive can be unloaded.
            GC.Collect();
            GC.WaitForPendingFinalizers();
            var unloaded = false;
            for (var i = 0; i < 5 && !unloaded; i++)
            {
                unloaded = RegUnLoadKey(HKEY_USERS, name) == 0;
                if (!unloaded) Thread.Sleep(200);
            }
            if (!unloaded) log?.Invoke($"could not unload hive {name}");
        }
    }

    /// <summary>Reads both Uninstall keys under HKEY_USERS\<paramref name="hiveName"/>. All handles are closed before it returns.</summary>
    private static List<SoftwareItem> ReadHive(string hiveName, string account)
    {
        var items = new List<SoftwareItem>();
        foreach (var path in UninstallPaths)
        {
            using var key = Registry.Users.OpenSubKey(hiveName + "\\" + path);
            if (key is null) continue;
            foreach (var sub in key.GetSubKeyNames())
            {
                using var sk = key.OpenSubKey(sub);
                if (sk is null) continue;
                var name = SoftwareInventoryCore.Clean(sk.GetValue("DisplayName")?.ToString());
                if (name is null) continue;

                int? sysComp = sk.GetValue("SystemComponent") is int sc ? sc : null;
                if (SoftwareInventoryCore.IsHiddenUserEntry(sysComp, sk.GetValue("ParentKeyName")?.ToString(), sk.GetValue("ReleaseType")?.ToString()))
                    continue;

                items.Add(new SoftwareItem
                {
                    Name = name,
                    Version = SoftwareInventoryCore.Clean(sk.GetValue("DisplayVersion")?.ToString()),
                    Publisher = SoftwareInventoryCore.Clean(sk.GetValue("Publisher")?.ToString()),
                    InstallDate = SystemInfoCollector.NormalizeInstallDate(sk.GetValue("InstallDate")?.ToString()),
                    Scope = "user",
                    User = SoftwareInventoryCore.Limit256(account),
                    InstalledBy = SoftwareInventoryCore.Limit256(account),
                });
            }
        }
        return items;
    }

    /// <summary>Every real profile on the PC, with whether that account has a session now.</summary>
    public static List<SoftwareUserEntry> ListUsers(Action<string>? log = null)
    {
        var profiles = new List<string>();
        try
        {
            using var list = Registry.LocalMachine.OpenSubKey(ProfileListKey);
            if (list is not null)
            {
                foreach (var sid in list.GetSubKeyNames().Where(SoftwareInventoryCore.IsUserSid))
                {
                    try
                    {
                        using var p = list.OpenSubKey(sid);
                        var folder = Environment.ExpandEnvironmentVariables(p?.GetValue("ProfileImagePath")?.ToString() ?? "");
                        profiles.Add(AccountName(sid, folder));
                    }
                    catch (Exception ex) { log?.Invoke($"profile {sid}: {ex.Message}"); }
                }
            }
        }
        catch (Exception ex) { log?.Invoke($"profiles: {ex.Message}"); }

        var signedIn = new List<string>();
        try { signedIn.AddRange(UserSessions.ActiveSessions().Select(s => s.Account)); }
        catch (Exception ex) { log?.Invoke($"sessions: {ex.Message}"); }

        return SoftwareInventoryCore.MergeUsers(profiles, signedIn, Environment.MachineName);
    }

    // ── Names ──────────────────────────────────────────────────────────────

    private static readonly Dictionary<string, string?> NameCache = new(StringComparer.OrdinalIgnoreCase);

    public static string AccountName(string sid, string? profileFolder)
    {
        try
        {
            return new SecurityIdentifier(sid).Translate(typeof(NTAccount)).Value;
        }
        catch
        {
            var folder = string.IsNullOrWhiteSpace(profileFolder) ? null : Path.GetFileName(profileFolder.TrimEnd('\\', '/'));
            return string.IsNullOrWhiteSpace(folder) ? sid : $"{Environment.MachineName}\\{folder}";
        }
    }

    public static string? TryAccountName(string sid)
    {
        lock (NameCache)
        {
            if (NameCache.TryGetValue(sid, out var cached)) return cached;
            string? v = null;
            try { v = new SecurityIdentifier(sid).Translate(typeof(NTAccount)).Value; } catch { /* unknown SID */ }
            NameCache[sid] = v;
            return v;
        }
    }

    // ── Who installed machine programs ─────────────────────────────────────

    /// <summary>MsiInstaller events (11707, 1033) from the last 90 days. One query, newest first, at most 5000 events.</summary>
    public static List<InstallEvent> ReadInstallEvents(Action<string>? log = null)
    {
        var events = new List<InstallEvent>();
        try
        {
            const string xpath = "*[System[Provider[@Name='MsiInstaller'] and (EventID=11707 or EventID=1033) and TimeCreated[timediff(@SystemTime) <= 7776000000]]]";
            var query = new EventLogQuery("Application", PathType.LogName, xpath) { ReverseDirection = true };
            using var reader = new EventLogReader(query);
            for (var i = 0; i < 5000; i++)
            {
                using var rec = reader.ReadEvent();
                if (rec is null) break;
                string? message = null;
                try { message = rec.FormatDescription(); } catch { /* no message DLL */ }
                if (string.IsNullOrEmpty(message) && rec.Properties.Count > 0) message = rec.Properties[0].Value?.ToString();
                if (string.IsNullOrEmpty(message)) continue;
                events.Add(new InstallEvent(rec.TimeCreated ?? DateTime.MinValue, rec.UserId?.Value, message));
            }
        }
        catch (Exception ex) { log?.Invoke($"install events: {ex.Message}"); }
        return events;
    }

    // ── Native ─────────────────────────────────────────────────────────────

    private static readonly IntPtr HKEY_USERS = new(unchecked((int)0x80000003));

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegLoadKey(IntPtr hKey, string subKey, string file);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegUnLoadKey(IntPtr hKey, string subKey);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LookupPrivilegeValue(string? system, string name, out long luid);

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct TokenPrivileges { public int Count; public long Luid; public int Attributes; }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state, int len, IntPtr prev, IntPtr retLen);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr h);

    private static void EnablePrivilege(string name)
    {
        const uint TOKEN_ADJUST_PRIVILEGES = 0x20, TOKEN_QUERY = 0x8;
        if (!OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle, TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out var token)) return;
        try
        {
            if (!LookupPrivilegeValue(null, name, out var luid)) return;
            var tp = new TokenPrivileges { Count = 1, Luid = luid, Attributes = 2 /* SE_PRIVILEGE_ENABLED */ };
            AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
        }
        finally { CloseHandle(token); }
    }
}
