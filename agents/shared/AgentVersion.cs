namespace RemoteIQ.Agent.Shared;

/// <summary>Numeric version comparison, so 1.10.0 is newer than 1.9.0.</summary>
public static class AgentVersion
{
    /// <summary>Accepts one to four numeric parts. Anything else is rejected rather than guessed at.</summary>
    public static bool TryParse(string? text, out int[] parts)
    {
        parts = Array.Empty<int>();
        var pieces = (text ?? "").Trim().Split('.');
        if (pieces.Length is < 1 or > 4) return false;

        var parsed = new int[pieces.Length];
        for (var i = 0; i < pieces.Length; i++)
        {
            var p = pieces[i];
            if (p.Length is 0 or > 9 || !p.All(char.IsAsciiDigit)) return false;
            parsed[i] = int.Parse(p);
        }

        parts = parsed;
        return true;
    }

    public static int Compare(int[] a, int[] b)
    {
        for (var i = 0; i < Math.Max(a.Length, b.Length); i++)
        {
            var x = i < a.Length ? a[i] : 0;
            var y = i < b.Length ? b[i] : 0;
            if (x != y) return x < y ? -1 : 1;
        }
        return 0;
    }

    /// <summary>False when either side cannot be parsed, so bad data can never cause an install.</summary>
    public static bool IsNewer(string? candidate, string? current) =>
        TryParse(candidate, out var a) && TryParse(current, out var b) && Compare(a, b) > 0;

    public static bool AreEqual(string? a, string? b) =>
        TryParse(a, out var x) && TryParse(b, out var y) && Compare(x, y) == 0;
}
