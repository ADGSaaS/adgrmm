using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Security.Cryptography;
using Microsoft.Extensions.Logging;
using RemoteIQ.Agent.Models;

namespace RemoteIQ.Agent.Services;

public sealed class PinnedHttpClientFactory
{
    private readonly AgentConfig _cfg;
    private readonly ILogger<PinnedHttpClientFactory> _log;

    // One handler for the agent's lifetime. Creating one per request leaks sockets.
    private HttpClientHandler? _handler;
    private readonly object _handlerLock = new();

    public PinnedHttpClientFactory(ConfigService config, ILogger<PinnedHttpClientFactory> log)
    {
        _cfg = config.Current;
        _log = log;
    }

    public HttpClient Create()
    {
        lock (_handlerLock)
        {
            if (_handler is null)
            {
                _handler = new HttpClientHandler();
                if (_cfg.Security.EnableCertPinning && _cfg.Security.PinnedSpkiSha256.Length > 0)
                {
                    _handler.ServerCertificateCustomValidationCallback = ValidatePin;
                }
            }
        }

        var http = new HttpClient(_handler, disposeHandler: false)
        {
            Timeout = TimeSpan.FromSeconds(30)
        };
        return http;
    }

    private bool ValidatePin(HttpRequestMessage _, X509Certificate2? cert, X509Chain? __, SslPolicyErrors errors)
    {
        if (cert is null) return false;
        if (errors != SslPolicyErrors.None)
        {
            _log.LogWarning("TLS policy errors: {errors}", errors);
        }

        try
        {
            byte[] spki;
            using var rsa = cert.GetRSAPublicKey();
            if (rsa is not null)
            {
                spki = rsa.ExportSubjectPublicKeyInfo();
            }
            else
            {
                using var ecdsa = cert.GetECDsaPublicKey();
                if (ecdsa is not null)
                    spki = ecdsa.ExportSubjectPublicKeyInfo();
                else
                    spki = cert.PublicKey.EncodedKeyValue.RawData;
            }

            var hash = SHA256.HashData(spki);
            var b64 = "sha256/" + Convert.ToBase64String(hash);

            var ok = _cfg.Security.PinnedSpkiSha256.Contains(b64, StringComparer.Ordinal);
            if (!ok) _log.LogError("Cert pin mismatch. Got {b64}", b64);
            return ok;
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Pin validation failed");
            return false;
        }
    }
}
