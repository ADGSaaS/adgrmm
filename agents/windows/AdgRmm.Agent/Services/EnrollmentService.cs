using System.Net.Http.Json;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using AdgRmm.Agent.Models;

namespace AdgRmm.Agent.Services;

public sealed class EnrollmentService : BackgroundService
{
    private readonly ConfigService _config;
    private readonly PinnedHttpClientFactory _httpFactory;
    private readonly ILogger<EnrollmentService> _log;

    public EnrollmentService(ConfigService cfg, PinnedHttpClientFactory http, ILogger<EnrollmentService> log)
    {
        _config = cfg; _httpFactory = http; _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var retrySeconds = 15;

        while (!stoppingToken.IsCancellationRequested)
        {
            if (!string.IsNullOrEmpty(_config.Current.AgentId) && !string.IsNullOrEmpty(_config.Current.AgentKey))
                return;

            var secret = _config.Current.EnrollmentSecret;
            var key = _config.Current.EnrollmentKey;

            // Must have these to enroll
            if (string.IsNullOrWhiteSpace(_config.Current.ApiBaseUrl) ||
                string.IsNullOrWhiteSpace(_config.Current.DeviceId) ||
                (string.IsNullOrWhiteSpace(secret) && string.IsNullOrWhiteSpace(key)))
            {
                _log.LogError("Agent not enrolled and missing ApiBaseUrl, DeviceId or an enrollment key in config. Waiting.");
                await Task.Delay(TimeSpan.FromMinutes(2), stoppingToken);
                continue;
            }

            var http = _httpFactory.Create();
            try
            {
                var body = new EnrollmentRequest
                {
                    EnrollmentSecret = string.IsNullOrWhiteSpace(secret) ? null : secret,
                    EnrollmentKey = string.IsNullOrWhiteSpace(secret) ? key : null,
                    DeviceId = _config.Current.DeviceId,
                    Hostname = Environment.MachineName,
                    Os = "windows",
                    Arch = RuntimeInformation.OSArchitecture switch
                    {
                        Architecture.Arm64 => "arm64",
                        Architecture.X64 => "x64",
                        _ => "x86",
                    },
                    Version = typeof(EnrollmentService).Assembly.GetName().Version?.ToString(3) ?? "1.0.0"
                };


                var url = $"{_config.Current.ApiBaseUrl.TrimEnd('/')}/api/agent/enroll";
                var resp = await http.PostAsJsonAsync(url, body, stoppingToken);
                if (!resp.IsSuccessStatusCode)
                {
                    var detail = await resp.Content.ReadAsStringAsync(stoppingToken);
                    if (detail.Length > 500) detail = detail[..500];
                    throw new HttpRequestException($"Server returned {(int)resp.StatusCode}: {detail}");
                }

                var er = await resp.Content.ReadFromJsonAsync<EnrollmentResponse>(cancellationToken: stoppingToken)
                         ?? throw new InvalidOperationException("Empty enrollment response");

                if (string.IsNullOrWhiteSpace(er.AgentId) || string.IsNullOrWhiteSpace(er.AgentToken))
                    throw new InvalidOperationException("Enrollment response missing agentId or agentToken");

                _config.Current.AgentId = er.AgentId;
                _config.Current.AgentKey = er.AgentToken;
                if (!string.IsNullOrWhiteSpace(er.JobSigningPublicKey))
                    _config.Current.Security.RsaPublicKeyPem = er.JobSigningPublicKey;

                // keep device id aligned with backend
                if (!string.IsNullOrWhiteSpace(er.DeviceId))
                    _config.Current.DeviceId = er.DeviceId;

                // important: clear enrollment secret after successful enrollment
                _config.Current.EnrollmentSecret = "";
                _config.Current.EnrollmentKey = "";

                _config.Save(_config.Current);

                _log.LogInformation("Enrollment successful: {AgentId}", er.AgentId);
                return;
            }
            catch (Exception ex)
            {
                _log.LogWarning("Enrollment failed; retrying in {Seconds}s: {Message}", retrySeconds, ex.Message);
                await Task.Delay(TimeSpan.FromSeconds(retrySeconds), stoppingToken);
                retrySeconds = Math.Min(retrySeconds * 2, 300);
            }
        }
    }
}
