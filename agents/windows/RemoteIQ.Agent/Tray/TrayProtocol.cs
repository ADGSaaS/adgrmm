// RemoteIQ.Agent/Tray/TrayProtocol.cs
//
// The tray app talks to the agent service over a local named pipe, one request and one answer per connection, each one line of JSON.
// The agent holds the device's token and makes the call to the server; the tray (which runs as whoever is signed in) never sees the token.
// Only the four things below can be asked, and the size of a request is limited.
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RemoteIQ.Agent.Tray;

internal static class TrayProtocol
{
    public const string PipeName = "RemoteIQ.Tray.Bridge";
    /// <summary>A request is a short message plus a few fields; anything bigger is refused before it is parsed.</summary>
    public const int MaxRequestBytes = 16 * 1024;
    public const int MaxMessageChars = 2000;

    public const string OpStatus = "status";
    public const string OpHelp = "help";
    public const string OpChatGet = "chat.get";
    public const string OpChatSend = "chat.send";
    public const string OpTicketGet = "ticket.get";
    public const string OpTicketReply = "ticket.reply";
    public const string OpTicketResolve = "ticket.resolve";
    public const string OpChatEnd = "chat.end";
    public const string OpContact = "contact";
    /// <summary>Restart the agent service. Handled by the service itself, never sent on to the server. There is no way to stop it.</summary>
    public const string OpRestart = "restart";

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    public sealed record Request(string? Op, string? Message, string? User, bool Urgent, string? After, string? Subject = null, int Number = 0, string? Email = null, string? Name = null, string? Phone = null,
        string? Category = null, string? AppName = null, string? AppPublisher = null, string? AppVersion = null);

    /// <summary>The server's answer as it came (<see cref="Body"/> is its JSON), or why there is none.</summary>
    public sealed record Response(bool Ok, int Status, JsonElement? Body, string? Error);

    /// <summary>Checks a request before anything is sent on: a known operation, and text that fits.</summary>
    public static string? Validate(Request? r)
    {
        if (r is null || string.IsNullOrEmpty(r.Op)) return "No operation.";
        switch (r.Op)
        {
            case OpStatus: return null;
            case OpRestart: return null;
            case OpChatEnd: return null;
            case OpContact:
                if (r.Email is { Length: > 200 } || r.Name is { Length: > 120 } || r.Phone is { Length: > 40 } || r.User is { Length: > 200 }) return "That is too long.";
                return null;
            case OpTicketResolve:
                if (r.Number <= 0) return "Which ticket?";
                if (r.Message is null || r.Message.Trim().Length < 3) return "Please say why this is solved.";
                if (r.Message.Length > MaxMessageChars) return "That is too long.";
                return null;
            case OpTicketGet: return r.Number > 0 ? null : "Which ticket?";
            case OpTicketReply:
                if (r.Number <= 0) return "Which ticket?";
                if (string.IsNullOrWhiteSpace(r.Message)) return "Write something first.";
                if (r.Message.Length > MaxMessageChars) return "That is too long.";
                if (r.User is { Length: > 200 }) return "Bad name.";
                return null;
            case OpChatGet: return r.After is { Length: > 40 } ? "Bad time." : null;
            case OpHelp:
            case OpChatSend:
                if (string.IsNullOrWhiteSpace(r.Message)) return "Write something first.";
                if (r.Message.Length > MaxMessageChars) return "That is too long.";
                if (r.User is { Length: > 200 }) return "Bad name.";
                if (r.Subject is { Length: > 120 }) return "The subject is too long (120 characters at most).";
                if (r.Email is { Length: > 200 } || r.Name is { Length: > 120 } || r.Phone is { Length: > 40 }) return "That is too long.";
                if (r.Category is { Length: > 60 } || r.AppName is { Length: > 120 } || r.AppPublisher is { Length: > 120 } || r.AppVersion is { Length: > 60 }) return "That is too long.";
                return null;
            default: return "Unknown operation.";
        }
    }

    public static string ErrorText(JsonElement? body, int status)
    {
        if (body is { ValueKind: JsonValueKind.Object } b && b.TryGetProperty("message", out var m))
        {
            if (m.ValueKind == JsonValueKind.String) return m.GetString() ?? "";
            if (m.ValueKind == JsonValueKind.Array) return string.Join(" ", m.EnumerateArray().Select(x => x.ToString()));
        }
        return status switch { 403 => "That is not turned on for this computer.", 401 => "This computer is not signed in to support.", _ => $"Support could not be reached (status {status})." };
    }
}
