//remoteiq-minimal-e2e\agents\windows\RemoteIQ.Agent\Services\UpdateService.cs

using System.Reflection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using RemoteIQ.Agent.Shared;

namespace RemoteIQ.Agent.Services;

public sealed class UpdateService : BackgroundService
{
    private readonly ConfigService _cfg;
    private readonly PinnedHttpClientFactory _httpFactory;
    private readonly ILogger<UpdateService> _log;

    public UpdateService(ConfigService cfg, PinnedHttpClientFactory httpFactory, ILogger<UpdateService> log)
    {
        _cfg = cfg; _httpFactory = httpFactory; _log = log;
    }

    public static string CurrentVersion =>
        Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.0.0";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var updater = new AgentUpdater(new WindowsUpdatePlatform(), new AgentUpdaterOptions
        {
            CurrentVersion = CurrentVersion,
            ApiBaseUrl = () => _cfg.Current.ApiBaseUrl,
            Token = () => _cfg.Current.AgentKey,
            PublicKeyPem = () => _cfg.Current.Security.RsaPublicKeyPem,
            Http = _httpFactory.Create,
            Interval = () => TimeSpan.FromMinutes(Math.Max(_cfg.Current.PollIntervals.UpdateCheckMinutes, 1)),
            Log = message => _log.LogInformation("{Message}", message),
        });

        try
        {
            await updater.RunAsync(stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // normal shutdown
        }
    }
}
