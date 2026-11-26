// AdgRmm.Agent/Services/HealthFactsCollector.cs
//
// What the reports need to say how a device is doing: the exact Windows build, when it last started and whether it is
// waiting for a restart, the firmware date, antivirus, firewall, disk encryption and the TPM, and the network adapters.
// Every probe stands alone and is allowed to fail: a machine without BitLocker, or a server without Security Center,
// simply has nothing for that field, which the reports show as "not reported" rather than as a problem.
using System.Globalization;
using System.Management;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace AdgRmm.Agent.Services;

[SupportedOSPlatform("windows")]
public static class HealthFactsCollector
{
    private static readonly TimeSpan WmiTimeout = TimeSpan.FromSeconds(8);

    /// <summary>How long the whole collection may take. A probe still running after this is left out, not waited for.</summary>
    private static readonly TimeSpan Budget = TimeSpan.FromSeconds(7);

    public static void Fill(DeviceFacts facts)
    {
        // The probes are independent and some can stall (a protected WMI namespace can take seconds to refuse), so they
        // run side by side under one time limit.
        var os = Task.Run(() => Safe(CollectOs));
        var boot = Task.Run(() => Safe(CollectBoot));
        var bios = Task.Run(() => Safe(CollectBios));
        var security = Task.Run(() => Safe(CollectSecurity));
        var network = Task.Run(() => Safe(CollectNetwork));
        var risk = Task.Run(() => Safe(RiskFactsCollector.Collect));
        var threats = Task.Run(() => Safe(ThreatFactsCollector.Collect));
        Task.WaitAll(new Task[] { os, boot, bios, security, network, risk, threats }, Budget);

        facts.Os = os.IsCompletedSuccessfully ? os.Result : null;
        facts.Boot = boot.IsCompletedSuccessfully ? boot.Result : null;
        facts.Bios = bios.IsCompletedSuccessfully ? bios.Result : null;
        facts.Security = security.IsCompletedSuccessfully ? security.Result : null;
        facts.Network = network.IsCompletedSuccessfully ? network.Result : null;
        facts.Risk = risk.IsCompletedSuccessfully ? risk.Result : null;
        facts.Threats = threats.IsCompletedSuccessfully ? threats.Result : null;
    }

    private static T? Safe<T>(Func<T?> probe) where T : class
    {
        try { return probe(); }
        catch { return null; }
    }

    private static T? Try<T>(Func<T> probe, T? fallback = default)
    {
        try { return probe(); }
        catch { return fallback; }
    }

    /* ------------------------------ WMI helpers ------------------------------ */

    private static List<ManagementBaseObject> Query(string scope, string query)
    {
        var results = new List<ManagementBaseObject>();
        var options = new System.Management.EnumerationOptions { Timeout = WmiTimeout, ReturnImmediately = false, Rewindable = false };
        using var searcher = new ManagementObjectSearcher(new ManagementScope(scope), new ObjectQuery(query), options);
        foreach (var item in searcher.Get()) results.Add(item);
        return results;
    }

    private static string? Str(ManagementBaseObject o, string name)
    {
        var v = Try(() => o[name]);
        var s = v?.ToString()?.Trim();
        return string.IsNullOrEmpty(s) ? null : s;
    }

    private static uint? UInt(ManagementBaseObject o, string name)
    {
        var v = Try(() => o[name]);
        return v switch
        {
            null => null,
            uint u => u,
            int i when i >= 0 => (uint)i,
            ushort us => us,
            byte b => b,
            _ => Try(() => (uint?)Convert.ToUInt32(v, CultureInfo.InvariantCulture)),
        };
    }

    private static bool? Bool(ManagementBaseObject o, string name)
    {
        var v = Try(() => o[name]);
        return v switch { null => null, bool b => b, _ => null };
    }

    private static DateTimeOffset? CimDate(ManagementBaseObject o, string name)
    {
        var s = Str(o, name);
        if (s is null) return null;
        try { return new DateTimeOffset(ManagementDateTimeConverter.ToDateTime(s)); }
        catch { return null; }
    }

    private static object? RegistryValue(string hive, string subKey, string name)
    {
        using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var key = baseKey.OpenSubKey(subKey);
        return key?.GetValue(name);
    }

    /* ------------------------------ operating system ------------------------------ */

    private static OsFacts? CollectOs()
    {
        var os = new OsFacts();
        var row = Query(@"\\.\root\cimv2", "SELECT Caption, Version, BuildNumber, OSArchitecture, InstallDate FROM Win32_OperatingSystem").FirstOrDefault();
        if (row is not null)
        {
            os.Name = Str(row, "Caption")?.Replace("Microsoft ", "");
            os.Version = Str(row, "Version");
            os.Build = Str(row, "BuildNumber");
            os.Architecture = Str(row, "OSArchitecture");
            os.InstalledAt = CimDate(row, "InstallDate");
        }
        const string cv = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        os.Edition = RegistryValue("HKLM", cv, "EditionID")?.ToString();
        // 22H2, 23H2 and so on; older builds call it ReleaseId.
        os.DisplayVersion = RegistryValue("HKLM", cv, "DisplayVersion")?.ToString() ?? RegistryValue("HKLM", cv, "ReleaseId")?.ToString();
        var ubr = RegistryValue("HKLM", cv, "UBR");
        if (ubr is int u && os.Build is not null) os.BuildRevision = $"{os.Build}.{u}";
        return os.Name is null && os.Build is null ? null : os;
    }

    /* ------------------------------ start time and restarts ------------------------------ */

    private static BootFacts? CollectBoot()
    {
        var boot = new BootFacts();
        var row = Query(@"\\.\root\cimv2", "SELECT LastBootUpTime FROM Win32_OperatingSystem").FirstOrDefault();
        if (row is not null) boot.LastBootAt = CimDate(row, "LastBootUpTime");

        // The three places Windows leaves a note that a restart is needed to finish something.
        var reasons = new List<string>();
        if (Try(() => KeyExists(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending"))) reasons.Add("Windows servicing");
        if (Try(() => KeyExists(@"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired"))) reasons.Add("Windows Update");
        var renames = Try(() => RegistryValue("HKLM", @"SYSTEM\CurrentControlSet\Control\Session Manager", "PendingFileRenameOperations"));
        if (renames is string[] list && list.Any(s => !string.IsNullOrWhiteSpace(s))) reasons.Add("Pending file changes");
        boot.PendingReboot = reasons.Count > 0;
        boot.PendingRebootReasons = reasons.Count > 0 ? reasons : null;
        return boot.LastBootAt is null ? null : boot;
    }

    private static bool KeyExists(string subKey)
    {
        using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var key = baseKey.OpenSubKey(subKey);
        return key is not null;
    }

    /* ------------------------------ firmware ------------------------------ */

    private static BiosFacts? CollectBios()
    {
        var row = Query(@"\\.\root\cimv2", "SELECT Manufacturer, SMBIOSBIOSVersion, ReleaseDate FROM Win32_BIOS").FirstOrDefault();
        if (row is null) return null;
        var date = CimDate(row, "ReleaseDate");
        return new BiosFacts
        {
            Vendor = Str(row, "Manufacturer"),
            Version = Str(row, "SMBIOSBIOSVersion"),
            ReleaseDate = date?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        };
    }

    /* ------------------------------ protection ------------------------------ */

    private static SecurityFacts? CollectSecurity()
    {
        // Side by side, so a protected namespace that is slow to refuse (BitLocker and the TPM both are) cannot cost the
        // antivirus and firewall answers.
        var antivirus = Task.Run(() => Safe(CollectAntivirus));
        var defender = Task.Run(() => Safe(CollectDefender));
        var firewall = Task.Run(() => Safe(CollectFirewall));
        var bitlocker = Task.Run(() => Safe(CollectBitLocker));
        var tpm = Task.Run(() => Safe(CollectTpm));
        Task.WaitAll(new Task[] { antivirus, defender, firewall, bitlocker, tpm }, Budget - TimeSpan.FromSeconds(1));

        var s = new SecurityFacts
        {
            Antivirus = antivirus.IsCompletedSuccessfully ? antivirus.Result : null,
            Defender = defender.IsCompletedSuccessfully ? defender.Result : null,
            Firewall = firewall.IsCompletedSuccessfully ? firewall.Result : null,
            BitLocker = bitlocker.IsCompletedSuccessfully ? bitlocker.Result : null,
            Tpm = tpm.IsCompletedSuccessfully ? tpm.Result : null,
            SecureBoot = Try<bool?>(() => RegistryValue("HKLM", @"SYSTEM\CurrentControlSet\Control\SecureBoot\State", "UEFISecureBootEnabled") is int v ? v == 1 : null),
        };
        return s.Antivirus is null && s.Defender is null && s.Firewall is null && s.BitLocker is null && s.Tpm is null && s.SecureBoot is null ? null : s;
    }

    /// <summary>What Security Center knows about: Windows Defender and any other product that registers itself. Client editions only.</summary>
    private static List<AntivirusFacts>? CollectAntivirus()
    {
        var list = new List<AntivirusFacts>();
        foreach (var row in Query(@"\\.\root\SecurityCenter2", "SELECT displayName, productState FROM AntiVirusProduct"))
        {
            var state = UInt(row, "productState");
            var name = Str(row, "displayName");
            if (name is null) continue;
            // productState packs the product's status in 0xF000 (0x1000 on, 0x2000 snoozed, 0 off) and
            // whether its definitions are current in 0x00F0 (0x10 means out of date).
            string status = state is null ? "unknown" : (state.Value & 0xF000) switch { 0x1000 => "on", 0x2000 => "snoozed", 0x0000 => "off", _ => "unknown" };
            list.Add(new AntivirusFacts { Name = name, State = status, UpToDate = state is null ? null : (state.Value & 0x00F0) == 0 });
        }
        return list.Count > 0 ? list : null;
    }

    private static DefenderFacts? CollectDefender()
    {
        var row = Query(@"\\.\root\Microsoft\Windows\Defender", "SELECT AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated, AntivirusSignatureAge, QuickScanAge, IsTamperProtected FROM MSFT_MpComputerStatus").FirstOrDefault();
        if (row is null) return null;
        return new DefenderFacts
        {
            ServiceEnabled = Bool(row, "AMServiceEnabled"),
            AntivirusEnabled = Bool(row, "AntivirusEnabled"),
            RealTimeProtection = Bool(row, "RealTimeProtectionEnabled"),
            SignatureUpdatedAt = CimDate(row, "AntivirusSignatureLastUpdated"),
            SignatureAgeDays = UInt(row, "AntivirusSignatureAge") is { } a && a < 100_000 ? (int)a : null,
            QuickScanAgeDays = UInt(row, "QuickScanAge") is { } q && q < 100_000 ? (int)q : null,
            TamperProtected = Bool(row, "IsTamperProtected"),
        };
    }

    private static FirewallFacts? CollectFirewall()
    {
        const string root = @"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy";
        bool? Profile(string name) => RegistryValue("HKLM", $@"{root}\{name}", "EnableFirewall") is int v ? v == 1 : null;
        var f = new FirewallFacts { Domain = Try(() => Profile("DomainProfile")), Private = Try(() => Profile("StandardProfile")), Public = Try(() => Profile("PublicProfile")) };
        return f.Domain is null && f.Private is null && f.Public is null ? null : f;
    }

    /// <summary>Needs the service account, which is what the agent runs as. A machine without BitLocker has no volumes to list.</summary>
    private static List<BitLockerFacts>? CollectBitLocker()
    {
        var list = new List<BitLockerFacts>();
        foreach (var row in Query(@"\\.\root\CIMV2\Security\MicrosoftVolumeEncryption", "SELECT DriveLetter, ProtectionStatus, ConversionStatus FROM Win32_EncryptableVolume"))
        {
            var mount = Str(row, "DriveLetter");
            if (mount is null) continue;
            var protection = UInt(row, "ProtectionStatus");
            var conversion = UInt(row, "ConversionStatus");
            list.Add(new BitLockerFacts
            {
                Mount = mount,
                Protection = protection switch { 1 => "on", 0 => "off", _ => "unknown" },
                Status = conversion switch { 0 => "decrypted", 1 => "encrypted", 2 => "encrypting", 3 => "decrypting", 4 => "encryption paused", 5 => "decryption paused", _ => null },
            });
        }
        return list.Count > 0 ? list : null;
    }

    private static TpmFacts? CollectTpm()
    {
        var row = Query(@"\\.\root\CIMV2\Security\MicrosoftTpm", "SELECT IsEnabled_InitialValue, IsActivated_InitialValue, SpecVersion FROM Win32_Tpm").FirstOrDefault();
        if (row is null) return new TpmFacts { Present = false };
        var spec = Str(row, "SpecVersion");
        return new TpmFacts
        {
            Present = true,
            Enabled = Bool(row, "IsEnabled_InitialValue"),
            Activated = Bool(row, "IsActivated_InitialValue"),
            // "2.0, 0, 1.38": the first part is the TPM version.
            Version = spec?.Split(',')[0].Trim(),
        };
    }

    /* ------------------------------ network ------------------------------ */

    private static List<NicFacts>? CollectNetwork()
    {
        var list = new List<NicFacts>();
        foreach (var row in Query(@"\\.\root\cimv2", "SELECT Description, MACAddress, IPAddress, DefaultIPGateway, DHCPEnabled FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled = TRUE"))
        {
            var ips = (Try(() => row["IPAddress"] as string[]) ?? Array.Empty<string>()).Where(a => a.Contains('.')).ToList();
            if (ips.Count == 0) continue;
            list.Add(new NicFacts
            {
                Description = Str(row, "Description"),
                Mac = Str(row, "MACAddress"),
                Ipv4 = ips,
                Gateway = (Try(() => row["DefaultIPGateway"] as string[]) ?? Array.Empty<string>()).FirstOrDefault(a => a.Contains('.')),
                Dhcp = Bool(row, "DHCPEnabled"),
            });
            if (list.Count >= 8) break;
        }
        return list.Count > 0 ? list : null;
    }
}
