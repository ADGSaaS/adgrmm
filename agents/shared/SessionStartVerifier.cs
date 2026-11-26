using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;

namespace AdgRmm.Agent.Shared;

/// <summary>
/// Decides whether a remote session may start. The server signs each session start with the job
/// signing key, for one agent, one kind of session and one session id. Both agents use this.
/// </summary>
public sealed class SessionStartVerifier
{
    // The same window as signed jobs. It is checked against this device's clock, so a clock far off refuses sessions.
    private static readonly TimeSpan MaxAge = TimeSpan.FromMinutes(15);

    private readonly ConcurrentDictionary<string, DateTimeOffset> _seenNonces = new();

    /// <summary>Returns the signed contents, or null with a reason that can be shown to the technician.</summary>
    public JsonElement? Open(JsonElement message, string? publicKeyPem, string? agentId, string kind, string sessionId, out string reason)
    {
        if (string.IsNullOrWhiteSpace(publicKeyPem))
        {
            reason = "This agent has no signing key, so it refused the session. Run the installer again.";
            return null;
        }

        if (message.ValueKind != JsonValueKind.Object
            || !message.TryGetProperty("signed", out var envelope)
            || envelope.ValueKind != JsonValueKind.Object
            || !TryGetString(envelope, "payload", out var payloadB64)
            || !TryGetString(envelope, "sig", out var sigB64))
        {
            reason = "The session start is not signed, so this agent refused it. The server may need updating.";
            return null;
        }

        try
        {
            var bytes = Convert.FromBase64String(payloadB64);
            var sig = Convert.FromBase64String(sigB64);

            using var rsa = RSA.Create();
            rsa.ImportFromPem(publicKeyPem);
            if (!rsa.VerifyData(bytes, sig, HashAlgorithmName.SHA256, RSASignaturePadding.Pss))
            {
                reason = "The session start's signature is invalid, so this agent refused it.";
                return null;
            }

            // Only the bytes that were signed are ever parsed.
            using var doc = JsonDocument.Parse(bytes);
            var root = doc.RootElement;

            // Anything else signed with this key, such as a job, is not a session start.
            if (!Matches(root, "t", "session_start", StringComparison.Ordinal))
            {
                reason = "The signed message is not a session start, so this agent refused it.";
                return null;
            }
            if (!Matches(root, "agentId", agentId, StringComparison.OrdinalIgnoreCase))
            {
                reason = "The session start was signed for a different agent, so this agent refused it.";
                return null;
            }
            if (!Matches(root, "kind", kind, StringComparison.Ordinal))
            {
                reason = "The session start was signed for a different kind of session, so this agent refused it.";
                return null;
            }
            if (!Matches(root, "sessionId", sessionId, StringComparison.Ordinal))
            {
                reason = "The session start was signed for a different session, so this agent refused it.";
                return null;
            }

            var now = DateTimeOffset.UtcNow;
            var issued = root.TryGetProperty("iat", out var i) && i.ValueKind == JsonValueKind.Number && i.TryGetInt64(out var ms)
                ? DateTimeOffset.FromUnixTimeMilliseconds(ms)
                : DateTimeOffset.MinValue;
            if ((now - issued).Duration() > MaxAge)
            {
                reason = "The session start's signature has expired, so this agent refused it. Check this device's clock.";
                return null;
            }

            // Last, so a message refused above cannot use up a nonce that a genuine one needs.
            if (!TryGetString(root, "nonce", out var nonce) || !_seenNonces.TryAdd(nonce, now))
            {
                reason = "The session start was already used, so this agent refused it.";
                return null;
            }
            foreach (var kv in _seenNonces)
                if (now - kv.Value > MaxAge + MaxAge) _seenNonces.TryRemove(kv.Key, out _);

            reason = "";
            return root.Clone();
        }
        catch (Exception ex) when (ex is FormatException or JsonException or CryptographicException or ArgumentException or InvalidOperationException)
        {
            reason = "The session start could not be read, so this agent refused it: " + ex.Message;
            return null;
        }
    }

    private static bool TryGetString(JsonElement obj, string name, out string value)
    {
        value = "";
        if (!obj.TryGetProperty(name, out var el) || el.ValueKind != JsonValueKind.String) return false;
        value = el.GetString() ?? "";
        return value.Length > 0;
    }

    private static bool Matches(JsonElement obj, string name, string? expected, StringComparison comparison)
        => !string.IsNullOrEmpty(expected) && TryGetString(obj, name, out var value) && string.Equals(value, expected, comparison);
}
