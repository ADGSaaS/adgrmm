// AdgRmm.Agent/Services/ThreatFactsCollector.cs
//
// What Windows Defender has found on the machine recently: the threats, how serious they were, when they were found and
// whether they were dealt with. Read-only. A machine without Defender (or with another product in charge) simply has
// nothing here, which the report shows as "not reported" rather than as clean.
using System.Management;
using System.Runtime.Versioning;

namespace AdgRmm.Agent.Services;

public sealed class ThreatFacts
{
    /// <summary>When the list was read, so a report can tell a quiet machine from one that was never asked.</summary>
    public DateTimeOffset? ReadAt { get; set; }
    public int? ActiveCount { get; set; }
    public List<ThreatItem>? Items { get; set; }
}

public sealed class ThreatItem
{
    public string? Name { get; set; }
    public string? Severity { get; set; }      // low, moderate, high, severe
    public DateTimeOffset? DetectedAt { get; set; }
    public string? Status { get; set; }        // active, cleaned, quarantined, removed, failed, allowed, unknown
    public string? Action { get; set; }
    public string? Resource { get; set; }
    public string? User { get; set; }
}

[SupportedOSPlatform("windows")]
public static class ThreatFactsCollector
{
    private const string DefenderScope = @"\\.\root\Microsoft\Windows\Defender";
    private static readonly TimeSpan WmiTimeout = TimeSpan.FromSeconds(6);
    private static readonly TimeSpan Window = TimeSpan.FromDays(30);
    private const int MaxItems = 50;

    public static ThreatFacts? Collect()
    {
        // The namespace only exists where Defender is installed.
        var names = new Dictionary<long, (string? Name, string? Severity, bool Active)>();
        foreach (var row in Query("SELECT ThreatID, ThreatName, SeverityID, IsActive FROM MSFT_MpThreat"))
        {
            var id = Long(row, "ThreatID");
            if (id is null) continue;
            names[id.Value] = (Str(row, "ThreatName"), Severity(Long(row, "SeverityID")), row["IsActive"] is bool b && b);
        }

        var cutoff = DateTimeOffset.UtcNow - Window;
        var items = new List<ThreatItem>();
        foreach (var row in Query("SELECT ThreatID, InitialDetectionTime, ActionSuccess, CleaningActionID, CurrentThreatExecutionStatusID, DomainUser, Resources FROM MSFT_MpThreatDetection"))
        {
            var at = Date(row, "InitialDetectionTime");
            if (at is null || at < cutoff) continue;
            var id = Long(row, "ThreatID");
            names.TryGetValue(id ?? -1, out var known);
            var success = row["ActionSuccess"] is bool s ? s : (bool?)null;
            var action = Long(row, "CleaningActionID");
            items.Add(new ThreatItem
            {
                Name = known.Name ?? (id is null ? null : $"Threat {id}"),
                Severity = known.Severity,
                DetectedAt = at,
                Status = known.Active ? "active" : StatusOf(action, success),
                Action = ActionName(action),
                Resource = Resource(row),
                User = Str(row, "DomainUser"),
            });
        }

        items = items.OrderByDescending(i => i.DetectedAt).Take(MaxItems).ToList();
        return new ThreatFacts { ReadAt = DateTimeOffset.UtcNow, ActiveCount = names.Values.Count(v => v.Active), Items = items };
    }

    private static List<ManagementBaseObject> Query(string query)
    {
        var results = new List<ManagementBaseObject>();
        var options = new System.Management.EnumerationOptions { Timeout = WmiTimeout, ReturnImmediately = false };
        using var searcher = new ManagementObjectSearcher(new ManagementScope(DefenderScope), new ObjectQuery(query), options);
        foreach (var item in searcher.Get()) results.Add(item);
        return results;
    }

    private static string? Str(ManagementBaseObject o, string name)
    {
        var s = o[name]?.ToString()?.Trim();
        return string.IsNullOrEmpty(s) ? null : s;
    }

    private static long? Long(ManagementBaseObject o, string name)
    {
        var v = o[name];
        return v switch { null => null, long l => l, int i => i, uint u => u, ushort us => us, byte b => b, _ => long.TryParse(v.ToString(), out var p) ? p : null };
    }

    private static DateTimeOffset? Date(ManagementBaseObject o, string name)
    {
        var s = Str(o, name);
        if (s is null) return null;
        try { return new DateTimeOffset(ManagementDateTimeConverter.ToDateTime(s)); }
        catch { return null; }
    }

    private static string? Severity(long? id) => id switch { 1 => "low", 2 => "moderate", 4 => "high", 5 => "severe", _ => null };

    /// <summary>What Defender did, in its own numbering (CleaningActionID).</summary>
    private static string? ActionName(long? id) => id switch
    {
        1 => "Cleaned",
        2 => "Quarantined",
        3 => "Removed",
        4 => "Allowed",
        5 => "User defined",
        6 => "No action",
        7 => "Blocked",
        _ => null,
    };

    private static string StatusOf(long? action, bool? success)
    {
        if (success == false) return "failed";
        return action switch { 1 => "cleaned", 2 => "quarantined", 3 => "removed", 4 => "allowed", 7 => "blocked", _ => success == true ? "cleaned" : "unknown" };
    }

    private static string? Resource(ManagementBaseObject o)
    {
        var first = (o["Resources"] as string[])?.FirstOrDefault(r => !string.IsNullOrWhiteSpace(r));
        if (first is null) return null;
        // "file:_C:\path\x.exe" is how Defender writes it.
        var clean = first.Replace("file:_", "").Trim();
        return clean.Length > 220 ? clean[..220] : clean;
    }
}
