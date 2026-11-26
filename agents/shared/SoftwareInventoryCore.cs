using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace AdgRmm.Agent.Shared;

/// <summary>One installed program as reported to the server.</summary>
public sealed class SoftwareItem
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("version")] public string? Version { get; set; }
    [JsonPropertyName("publisher")] public string? Publisher { get; set; }
    [JsonPropertyName("installDate")] public string? InstallDate { get; set; }
    [JsonPropertyName("scope")] public string Scope { get; set; } = "machine";
    [JsonPropertyName("user")] public string? User { get; set; }
    [JsonPropertyName("installedBy")] public string? InstalledBy { get; set; }
}

/// <summary>A real local or domain account on this PC, and whether it has a session right now.</summary>
public sealed class SoftwareUserEntry
{
    [JsonPropertyName("account")] public string Account { get; set; } = "";
    [JsonPropertyName("loggedIn")] public bool LoggedIn { get; set; }
}

/// <summary>An Application-log installer event: who ran an installer for which product.</summary>
public sealed record InstallEvent(DateTime When, string? UserSid, string Message);

/// <summary>The parts of the software inventory that need no registry, so they can be tested.</summary>
public static class SoftwareInventoryCore
{
    private static readonly Regex Product11707 = new(@"Product:\s*(.+?)\s*--", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex Product1033 = new(@"Product Name:\s*(.+?)\.\s*Product Version", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>Real people have S-1-5-21-... (local or domain) or S-1-12-1-... (Entra ID) SIDs. Service accounts and *_Classes hives are not.</summary>
    public static bool IsUserSid(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return false;
        if (key.EndsWith("_Classes", StringComparison.OrdinalIgnoreCase)) return false;
        return key.StartsWith("S-1-5-21-", StringComparison.OrdinalIgnoreCase) || key.StartsWith("S-1-12-1-", StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsSystemSid(string? sid) =>
        sid is not null && (sid.Equals("S-1-5-18", StringComparison.OrdinalIgnoreCase) || sid.Equals("S-1-5-19", StringComparison.OrdinalIgnoreCase) || sid.Equals("S-1-5-20", StringComparison.OrdinalIgnoreCase));

    /// <summary>User hives skip components and updates that are not programs the person installed.</summary>
    public static bool IsHiddenUserEntry(int? systemComponent, string? parentKeyName, string? releaseType)
    {
        if (systemComponent == 1) return true;
        if (!string.IsNullOrWhiteSpace(parentKeyName)) return true;
        return releaseType is not null && (releaseType.Contains("Update", StringComparison.OrdinalIgnoreCase) || releaseType.Contains("Hotfix", StringComparison.OrdinalIgnoreCase));
    }

    public static string? Clean(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    public static string? ProductFromMessage(string? message)
    {
        if (string.IsNullOrEmpty(message)) return null;
        var m = Product11707.Match(message);
        if (!m.Success) m = Product1033.Match(message);
        return m.Success ? m.Groups[1].Value.Trim() : null;
    }

    /// <summary>Product name to the SID of whoever installed it most recently. Installs by the system account are left out.</summary>
    public static Dictionary<string, string> BuildInstallerMap(IEnumerable<InstallEvent> events)
    {
        var map = new Dictionary<string, (DateTime When, string Sid)>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in events)
        {
            if (string.IsNullOrEmpty(e.UserSid) || IsSystemSid(e.UserSid)) continue;
            var product = ProductFromMessage(e.Message);
            if (product is null) continue;
            if (!map.TryGetValue(product, out var cur) || e.When > cur.When) map[product] = (e.When, e.UserSid);
        }
        return map.ToDictionary(k => k.Key, k => k.Value.Sid, StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>Finds who installed a program: an exact product name first, then one name containing the other (at least 4 characters).</summary>
    public static string? FindInstallerSid(IReadOnlyDictionary<string, string> map, string displayName)
    {
        if (map.TryGetValue(displayName.Trim(), out var exact)) return exact;
        foreach (var (product, sid) in map)
        {
            if (product.Length < 4 || displayName.Length < 4) continue;
            if (displayName.Contains(product, StringComparison.OrdinalIgnoreCase) || product.Contains(displayName, StringComparison.OrdinalIgnoreCase)) return sid;
        }
        return null;
    }

    /// <summary>
    /// Machine items first, then user items. A user's copy is kept once per user, name and version
    /// (the same program in the 64 and 32 bit views would otherwise appear twice). Machine copies are never merged with user copies.
    /// </summary>
    public static List<SoftwareItem> Merge(IEnumerable<SoftwareItem> machine, IEnumerable<SoftwareItem> user)
    {
        var result = new List<SoftwareItem>(machine);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var u in user)
        {
            u.Scope = "user";
            if (seen.Add($"{u.User}|{u.Name}|{u.Version}")) result.Add(u);
        }
        return result;
    }

    /// <summary>Splits DOMAIN\name. Both parts must be present, with no control characters or further backslashes.</summary>
    public static bool TryParseAccount(string? account, out string domain, out string name)
    {
        domain = name = "";
        if (string.IsNullOrWhiteSpace(account) || account.Length > 256 || account.Any(char.IsControl)) return false;
        var parts = account.Trim().Split('\\');
        if (parts.Length != 2 || parts[0].Length == 0 || parts[1].Length == 0 || parts[1].Contains('/')) return false;
        domain = parts[0]; name = parts[1];
        return true;
    }

    /// <summary>Same account, ignoring case; "." and the machine name count as the same local domain.</summary>
    public static bool SameAccount(string a, string b, string machineName)
    {
        if (!TryParseAccount(a, out var da, out var na) || !TryParseAccount(b, out var db, out var nb)) return false;
        string D(string d) => d == "." ? machineName : d;
        return string.Equals(D(da), D(db), StringComparison.OrdinalIgnoreCase) && string.Equals(na, nb, StringComparison.OrdinalIgnoreCase);
    }

    private static readonly string[] ServiceDomains = { "NT AUTHORITY", "NT SERVICE", "Window Manager", "Font Driver Host", "IIS APPPOOL", "Virtual Users", "Workgroup" };

    /// <summary>SYSTEM, LOCAL SERVICE, NETWORK SERVICE, DWM/UMFD and app-pool style accounts are not people.</summary>
    public static bool IsServiceAccount(string account)
    {
        if (!TryParseAccount(account, out var d, out var n)) return true;
        if (ServiceDomains.Any(s => s.Equals(d, StringComparison.OrdinalIgnoreCase))) return true;
        if (n.EndsWith("$")) return true;
        return n.StartsWith("DefaultAppPool", StringComparison.OrdinalIgnoreCase) || n.StartsWith("UMFD-", StringComparison.OrdinalIgnoreCase) || n.StartsWith("DWM-", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Profile accounts plus accounts with a session now, without service accounts or duplicates. Signed-in users sort first.</summary>
    public static List<SoftwareUserEntry> MergeUsers(IEnumerable<string> profileAccounts, IEnumerable<string> signedInAccounts, string machineName)
    {
        var map = new Dictionary<string, SoftwareUserEntry>(StringComparer.OrdinalIgnoreCase);
        string Key(string a) { TryParseAccount(a, out var d, out var n); return (d == "." ? machineName : d) + "\\" + n; }
        foreach (var a in profileAccounts)
        {
            if (IsServiceAccount(a)) continue;
            map.TryAdd(Key(a), new SoftwareUserEntry { Account = Limit256(a.Trim())! });
        }
        foreach (var a in signedInAccounts)
        {
            if (IsServiceAccount(a)) continue;
            if (map.TryGetValue(Key(a), out var e)) e.LoggedIn = true;
            else map[Key(a)] = new SoftwareUserEntry { Account = Limit256(a.Trim())!, LoggedIn = true };
        }
        return map.Values.OrderByDescending(u => u.LoggedIn).ThenBy(u => u.Account, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public static string? Limit256(string? s) => s is null ? null : (s.Length > 256 ? s[..256] : s);
}
