// AdgRmm.Agent/Services/RiskFactsCollector.cs
//
// Settings that put a device at risk, for the risky-configuration report: Remote Desktop and whether it demands
// network-level authentication, SMBv1, automatic logon, User Account Control, the guest account, who the local
// administrators are, the password and lockout rules, and whether the screen locks by itself. Read-only: nothing here
// changes a setting. Every probe stands alone and may fail; a field it could not read is left out, and the report shows
// that as "not reported" rather than as safe.
using System.Management;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace AdgRmm.Agent.Services;

public sealed class RiskFacts
{
    public RdpFacts? Rdp { get; set; }
    public bool? Smb1Enabled { get; set; }
    public bool? AutoLogon { get; set; }
    public bool? UacEnabled { get; set; }
    public bool? GuestEnabled { get; set; }
    public List<string>? LocalAdmins { get; set; }
    public PasswordPolicyFacts? PasswordPolicy { get; set; }
    public int? ScreenLockMinutes { get; set; }
}

public sealed class RdpFacts
{
    public bool? Enabled { get; set; }
    public bool? Nla { get; set; }
}

public sealed class PasswordPolicyFacts
{
    public int? MinLength { get; set; }
    public int? LockoutThreshold { get; set; }
}

[SupportedOSPlatform("windows")]
public static class RiskFactsCollector
{
    private static readonly TimeSpan WmiTimeout = TimeSpan.FromSeconds(6);

    public static RiskFacts? Collect()
    {
        var admins = Task.Run(() => Try(ReadLocalAdmins));
        var guest = Task.Run(() => Try(ReadGuestEnabled));
        var policy = Task.Run(() => Try(ReadPasswordPolicy));
        Task.WaitAll(new Task[] { admins, guest, policy }, TimeSpan.FromSeconds(5));

        var risk = new RiskFacts
        {
            Rdp = Try(ReadRdp),
            Smb1Enabled = Try(ReadSmb1),
            AutoLogon = Try(() => (bool?)(RegString(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon", "AutoAdminLogon") == "1")),
            UacEnabled = Try(() => RegInt(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "EnableLUA") is { } v ? v == 1 : (bool?)null),
            GuestEnabled = guest.IsCompletedSuccessfully ? guest.Result : null,
            LocalAdmins = admins.IsCompletedSuccessfully ? admins.Result : null,
            PasswordPolicy = policy.IsCompletedSuccessfully ? policy.Result : null,
            ScreenLockMinutes = Try(ReadScreenLock),
        };
        var any = risk.Rdp is not null || risk.Smb1Enabled is not null || risk.AutoLogon is not null || risk.UacEnabled is not null
            || risk.GuestEnabled is not null || risk.LocalAdmins is not null || risk.PasswordPolicy is not null || risk.ScreenLockMinutes is not null;
        return any ? risk : null;
    }

    private static T? Try<T>(Func<T?> probe)
    {
        try { return probe(); }
        catch { return default; }
    }

    /* ------------------------------ registry ------------------------------ */

    private static object? Reg(string subKey, string name)
    {
        using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var key = baseKey.OpenSubKey(subKey);
        return key?.GetValue(name);
    }

    private static int? RegInt(string subKey, string name) => Reg(subKey, name) is int v ? v : null;
    private static string? RegString(string subKey, string name) => Reg(subKey, name)?.ToString();

    private static RdpFacts? ReadRdp()
    {
        var deny = RegInt(@"SYSTEM\CurrentControlSet\Control\Terminal Server", "fDenyTSConnections");
        if (deny is null) return null;
        var nla = RegInt(@"SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp", "UserAuthentication");
        return new RdpFacts { Enabled = deny == 0, Nla = nla is null ? null : nla == 1 };
    }

    /// <summary>SMBv1 is off by default on current Windows, so a missing setting is read as off.</summary>
    private static bool? ReadSmb1()
    {
        var v = RegInt(@"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters", "SMB1");
        return v is null ? false : v != 0;
    }

    /// <summary>Inactivity lock set by policy, in minutes. Not set means this could not be told, so it is left out.</summary>
    private static int? ReadScreenLock()
    {
        var seconds = RegInt(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "InactivityTimeoutSecs");
        return seconds is null ? null : (int)Math.Ceiling(seconds.Value / 60.0);
    }

    /* ------------------------------ accounts ------------------------------ */

    private static System.Management.EnumerationOptions Options() => new() { Timeout = WmiTimeout, ReturnImmediately = false };

    private static bool? ReadGuestEnabled()
    {
        // The guest account is the one whose SID ends in -501, whatever it has been renamed to.
        using var searcher = new ManagementObjectSearcher(new ManagementScope(@"\\.\root\cimv2"), new ObjectQuery("SELECT SID, Disabled FROM Win32_UserAccount WHERE LocalAccount = True"), Options());
        foreach (var item in searcher.Get())
        {
            var sid = item["SID"]?.ToString();
            if (sid is not null && sid.EndsWith("-501", StringComparison.Ordinal)) return item["Disabled"] is bool disabled ? !disabled : null;
        }
        return null;
    }

    private static List<string>? ReadLocalAdmins()
    {
        // The Administrators group is found by its well-known SID, since its name depends on the language of Windows.
        string? domain = null, name = null;
        using (var groups = new ManagementObjectSearcher(new ManagementScope(@"\\.\root\cimv2"), new ObjectQuery("SELECT Name, Domain FROM Win32_Group WHERE SID = 'S-1-5-32-544'"), Options()))
        {
            foreach (var g in groups.Get()) { name = g["Name"]?.ToString(); domain = g["Domain"]?.ToString(); }
        }
        if (name is null || domain is null) return null;
        var path = $"Win32_Group.Domain='{domain.Replace("'", "''")}',Name='{name.Replace("'", "''")}'";
        var members = new List<string>();
        using var related = new ManagementObjectSearcher(new ManagementScope(@"\\.\root\cimv2"), new RelatedObjectQuery(path, null, "Win32_GroupUser", null, null, "PartComponent", "GroupComponent", false), Options());
        foreach (var m in related.Get())
        {
            var n = m["Name"]?.ToString();
            var d = m["Domain"]?.ToString();
            if (string.IsNullOrWhiteSpace(n)) continue;
            // Local accounts show by name alone; domain accounts and groups with their domain.
            members.Add(string.Equals(d, Environment.MachineName, StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(d) ? n! : $"{d}\\{n}");
        }
        return members;
    }

    /* ------------------------------ password and lockout rules ------------------------------ */

    [StructLayout(LayoutKind.Sequential)]
    private struct UserModalsInfo0 { public uint MinPasswdLen; public uint MaxPasswdAge; public uint MinPasswdAge; public uint ForceLogoff; public uint PasswordHistLen; }

    [StructLayout(LayoutKind.Sequential)]
    private struct UserModalsInfo3 { public uint LockoutDuration; public uint LockoutObservationWindow; public uint LockoutThreshold; }

    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetUserModalsGet(string? server, int level, out IntPtr buffer);

    [DllImport("netapi32.dll")]
    private static extern int NetApiBufferFree(IntPtr buffer);

    private static PasswordPolicyFacts? ReadPasswordPolicy()
    {
        var policy = new PasswordPolicyFacts();
        if (NetUserModalsGet(null, 0, out var p0) == 0)
        {
            try { policy.MinLength = (int)Marshal.PtrToStructure<UserModalsInfo0>(p0).MinPasswdLen; }
            finally { NetApiBufferFree(p0); }
        }
        if (NetUserModalsGet(null, 3, out var p3) == 0)
        {
            try { policy.LockoutThreshold = (int)Marshal.PtrToStructure<UserModalsInfo3>(p3).LockoutThreshold; }
            finally { NetApiBufferFree(p3); }
        }
        return policy.MinLength is null && policy.LockoutThreshold is null ? null : policy;
    }
}
