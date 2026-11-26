// agents/windows/AdgRmm.Agent/Services/SessionIndicator.cs

using System.Collections.Concurrent;

namespace AdgRmm.Agent.Services;

/// <summary>
/// Connects the part of the agent that decides a session needs an indicator on the device's screen to the part
/// that shows it. The indicator and its End session button live in a helper that belongs to the signed-in user.
/// When the person presses the button, the helper tells the peer, and the peer calls RequestEnd, which the
/// worker answers by ending the session.
/// </summary>
internal static class SessionIndicator
{
    private sealed record Entry(string Text, Action EndRequested);

    private static readonly ConcurrentDictionary<string, Entry> Sessions = new();

    /// <summary>Marks a session as one that gets an indicator, saying who is connected.</summary>
    public static void Register(string sessionId, string? technician, Action endRequested)
    {
        var text = $"{ConsoleSessions.CleanName(technician)} from your IT provider is connected to this computer.";
        Sessions[sessionId] = new Entry(text, endRequested);
    }

    /// <summary>What the indicator says, or null when this session gets none, such as when the customer chose to show nothing.</summary>
    public static string? TextFor(string sessionId) => Sessions.TryGetValue(sessionId, out var entry) ? entry.Text : null;

    /// <summary>The person at the device pressed End session.</summary>
    public static void RequestEnd(string sessionId)
    {
        if (Sessions.TryGetValue(sessionId, out var entry)) entry.EndRequested();
    }

    public static void Forget(string sessionId) => Sessions.TryRemove(sessionId, out _);
}
