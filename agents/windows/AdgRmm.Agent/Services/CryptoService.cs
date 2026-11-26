using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using AdgRmm.Agent.Shared;

namespace AdgRmm.Agent.Services;

public sealed class CryptoService
{
    private readonly ILogger<CryptoService> _log;
    private readonly ConfigService _config;
    private readonly object _keyLock = new();
    private RSA? _rsa;
    private string _loadedPem = "";

    // A signed job is only valid briefly, and only once.
    private static readonly TimeSpan MaxJobAge = TimeSpan.FromMinutes(15);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _seenJobs = new();
    private readonly SessionStartVerifier _sessionStarts = new();

    public CryptoService(ConfigService config, ILogger<CryptoService> log)
    {
        _config = config;
        _log = log;
    }

    // Loaded on demand, because enrollment delivers the key after this service starts.
    private RSA? CurrentKey()
    {
        var pem = _config.Current.Security.RsaPublicKeyPem?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(pem)) return null;

        lock (_keyLock)
        {
            if (_rsa is not null && _loadedPem == pem) return _rsa;
            try
            {
                var rsa = RSA.Create();
                rsa.ImportFromPem(pem);
                _rsa = rsa;
                _loadedPem = pem;
                return _rsa;
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "Failed to import RSA public key PEM.");
                return null;
            }
        }
    }

    /// <summary>
    /// Verifies a { payload, sig } envelope from the server and returns its contents,
    /// or null with the reason. Only the bytes that were signed are ever parsed.
    /// </summary>
    public JsonElement? OpenSigned(string? payloadB64, string? sigB64, string uniqueIdProperty, out string reason)
    {
        var rsa = CurrentKey();
        if (rsa is null)
        {
            reason = "This agent has no job signing key. Run the installer again.";
            return null;
        }
        if (string.IsNullOrEmpty(payloadB64) || string.IsNullOrEmpty(sigB64))
        {
            reason = "The job is not signed.";
            return null;
        }

        try
        {
            var bytes = Convert.FromBase64String(payloadB64);
            if (!rsa.VerifyData(bytes, Convert.FromBase64String(sigB64), HashAlgorithmName.SHA256, RSASignaturePadding.Pss))
            {
                reason = "The job's signature is invalid.";
                return null;
            }

            using var doc = JsonDocument.Parse(bytes);
            var root = doc.RootElement;

            var agentId = root.TryGetProperty("agentId", out var a) ? a.GetString() : null;
            if (!string.Equals(agentId, _config.Current.AgentId, StringComparison.OrdinalIgnoreCase))
            {
                reason = "The job was signed for a different agent.";
                return null;
            }

            var now = DateTimeOffset.UtcNow;
            var issued = root.TryGetProperty("iat", out var i) && i.TryGetInt64(out var ms)
                ? DateTimeOffset.FromUnixTimeMilliseconds(ms)
                : DateTimeOffset.MinValue;
            if ((now - issued).Duration() > MaxJobAge)
            {
                reason = "The job's signature has expired. Check this device's clock.";
                return null;
            }

            var id = root.TryGetProperty(uniqueIdProperty, out var u) ? u.GetString() : null;
            if (string.IsNullOrEmpty(id) || !_seenJobs.TryAdd(id, now))
            {
                reason = "The job was already delivered.";
                return null;
            }
            foreach (var kv in _seenJobs)
                if (now - kv.Value > MaxJobAge + MaxJobAge) _seenJobs.TryRemove(kv.Key, out _);

            reason = "";
            return root.Clone();
        }
        catch (Exception ex)
        {
            reason = "The job could not be read: " + ex.Message;
            return null;
        }
    }

    /// <summary>
    /// Checks that the server's key signed this exact session start for this agent. Workers read
    /// anything they act on from the returned contents, not from the rest of the message.
    /// </summary>
    public JsonElement? OpenSessionStart(JsonElement message, string kind, string sessionId, out string reason)
        => _sessionStarts.Open(message, _config.Current.Security.RsaPublicKeyPem, _config.Current.AgentId, kind, sessionId, out reason);

    public bool VerifyTaskSignature(object taskEnvelope, string? signatureBase64)
    {
        var rsa = CurrentKey();
        if (rsa is null) return false;
        if (string.IsNullOrEmpty(signatureBase64)) return false;

        try
        {
            var json = System.Text.Json.JsonSerializer.Serialize(taskEnvelope, new System.Text.Json.JsonSerializerOptions
            {
                WriteIndented = false
            });
            var data = Encoding.UTF8.GetBytes(json);
            var sig = Convert.FromBase64String(signatureBase64);
            return rsa.VerifyData(data, sig, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
        }
        catch
        {
            return false;
        }
    }

    public bool VerifyBlob(string canonical, string signatureBase64)
    {
        var rsa = CurrentKey();
        if (rsa is null) return false;
        try
        {
            var data = Encoding.UTF8.GetBytes(canonical);
            var sig = Convert.FromBase64String(signatureBase64);
            return rsa.VerifyData(data, sig, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
        }
        catch
        {
            return false;
        }
    }
}
