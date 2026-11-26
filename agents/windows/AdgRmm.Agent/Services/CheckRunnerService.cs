using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using AdgRmm.Agent.Shared;

namespace AdgRmm.Agent.Services;

public sealed class CheckRunnerService : BackgroundService
{
    private readonly ConfigService _cfg;
    private readonly PinnedHttpClientFactory _httpFactory;
    private readonly ILogger<CheckRunnerService> _log;
    private CheckRunner? _runner;

    public CheckRunnerService(ConfigService cfg, PinnedHttpClientFactory httpFactory, ILogger<CheckRunnerService> log)
    {
        _cfg = cfg; _httpFactory = httpFactory; _log = log;
    }

    /// <summary>Runs checks now, for the "run_checks" task. See <see cref="CheckRunner.RunNowAsync"/>.</summary>
    public Task<int> RunNowAsync(IReadOnlyCollection<string> keys, CancellationToken ct)
    {
        var runner = _runner ?? throw new InvalidOperationException("The check runner has not started yet.");
        return runner.RunNowAsync(keys, ct);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var runner = _runner = new CheckRunner(new WindowsCheckProbes(), new CheckRunnerOptions
        {
            ApiBaseUrl = () => _cfg.Current.ApiBaseUrl,
            Token = () => _cfg.Current.AgentKey,
            AgentId = () => _cfg.Current.AgentId,
            DeviceId = () => _cfg.Current.DeviceId,
            PublicKeyPem = () => _cfg.Current.Security.RsaPublicKeyPem,
            Http = _httpFactory.Create,
            Log = message => _log.LogInformation("{Message}", message),
            CurrentVersion = UpdateService.CurrentVersion,
            UpdateStateDir = new WindowsUpdatePlatform().StateDir,
        });

        try
        {
            await runner.RunAsync(stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // normal shutdown
        }
    }
}
