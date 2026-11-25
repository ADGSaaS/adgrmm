// RemoteIQ.Agent/Services/DeviceFacts.cs

namespace RemoteIQ.Agent.Services;

public sealed class DeviceFacts
{
    public HardwareFacts? Hardware { get; set; }
    public List<DiskFacts>? Disks { get; set; }

    // Added in agent 1.3.26, for the health, security and patching reports.
    public OsFacts? Os { get; set; }
    public BootFacts? Boot { get; set; }
    public BiosFacts? Bios { get; set; }
    public SecurityFacts? Security { get; set; }
    public List<NicFacts>? Network { get; set; }

    // Added in agent 1.3.27, for the risky-configuration report.
    public RiskFacts? Risk { get; set; }

    // Added in agent 1.3.28, for the antivirus threats report.
    public ThreatFacts? Threats { get; set; }
}

public sealed class OsFacts
{
    public string? Name { get; set; }            // "Windows 11 Pro"
    public string? Edition { get; set; }         // "Professional"
    public string? Version { get; set; }         // "10.0.22631"
    public string? DisplayVersion { get; set; }  // "23H2"
    public string? Build { get; set; }           // "22631"
    public string? BuildRevision { get; set; }   // "22631.3007", which moves with every cumulative update
    public string? Architecture { get; set; }
    public DateTimeOffset? InstalledAt { get; set; }
}

public sealed class BootFacts
{
    public DateTimeOffset? LastBootAt { get; set; }
    public bool? PendingReboot { get; set; }
    public List<string>? PendingRebootReasons { get; set; }
}

public sealed class BiosFacts
{
    public string? Vendor { get; set; }
    public string? Version { get; set; }
    public string? ReleaseDate { get; set; }     // yyyy-MM-dd, the best guide to a machine's age
}

public sealed class SecurityFacts
{
    public List<AntivirusFacts>? Antivirus { get; set; }
    public DefenderFacts? Defender { get; set; }
    public FirewallFacts? Firewall { get; set; }
    public List<BitLockerFacts>? BitLocker { get; set; }
    public TpmFacts? Tpm { get; set; }
    public bool? SecureBoot { get; set; }
}

public sealed class AntivirusFacts
{
    public string? Name { get; set; }
    public string? State { get; set; }           // on, off, snoozed, unknown
    public bool? UpToDate { get; set; }
}

public sealed class DefenderFacts
{
    public bool? ServiceEnabled { get; set; }
    public bool? AntivirusEnabled { get; set; }
    public bool? RealTimeProtection { get; set; }
    public DateTimeOffset? SignatureUpdatedAt { get; set; }
    public int? SignatureAgeDays { get; set; }
    public int? QuickScanAgeDays { get; set; }
    public bool? TamperProtected { get; set; }
}

public sealed class FirewallFacts
{
    public bool? Domain { get; set; }
    public bool? Private { get; set; }
    public bool? Public { get; set; }
}

public sealed class BitLockerFacts
{
    public string? Mount { get; set; }
    public string? Protection { get; set; }      // on, off, unknown
    public string? Status { get; set; }          // encrypted, decrypted, encrypting ...
}

public sealed class TpmFacts
{
    public bool? Present { get; set; }
    public bool? Enabled { get; set; }
    public bool? Activated { get; set; }
    public string? Version { get; set; }        // "2.0"
}

public sealed class NicFacts
{
    public string? Description { get; set; }
    public string? Mac { get; set; }
    public List<string>? Ipv4 { get; set; }
    public string? Gateway { get; set; }
    public bool? Dhcp { get; set; }
}

public sealed class HardwareFacts
{
    public string? Model { get; set; }
    public string? Cpu { get; set; }

    // Accurate + UI-friendly
    public long? RamBytes { get; set; }
    public string? Ram { get; set; }

    // Some machines have multiple adapters
    public List<string>? Gpu { get; set; }

    public string? Serial { get; set; }
}

public sealed class DiskFacts
{
    public string? Mount { get; set; }     // "C:" or "/"
    public string? Name { get; set; }      // optional
    public string? Fs { get; set; }        // "NTFS"
    public long? TotalBytes { get; set; }
    public long? FreeBytes { get; set; }

    // Optional, UI can compute if needed
    public long? UsedBytes { get; set; }
    public double? UsedPercent { get; set; }

    // Optional pretty string: "2.9 TB free of 7.3 TB"
    public string? Summary { get; set; }
}
