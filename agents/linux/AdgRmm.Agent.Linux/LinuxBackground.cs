using AdgRmm.Agent.Shared;

namespace AdgRmm.Agent.Linux;

/// <summary>Self-update and check running, started beside the loops in Program.cs.</summary>
internal static class LinuxBackground
{
    public static void Start(AgentConfig cfg, string version, string arch, HttpClient http, Action<string> log, CancellationToken stop)
    {
        var platform = new LinuxUpdatePlatform(arch);

        var updater = new AgentUpdater(platform, new AgentUpdaterOptions
        {
            CurrentVersion = version,
            ApiBaseUrl = () => cfg.ApiBaseUrl,
            Token = () => cfg.AgentKey,
            PublicKeyPem = () => cfg.JobSigningPublicKey,
            Http = () => http,
            Interval = () => TimeSpan.FromMinutes(30),
            Log = log,
        });

        var runner = new CheckRunner(new LinuxCheckProbes(), new CheckRunnerOptions
        {
            ApiBaseUrl = () => cfg.ApiBaseUrl,
            Token = () => cfg.AgentKey,
            AgentId = () => cfg.AgentId,
            DeviceId = () => cfg.DeviceId,
            PublicKeyPem = () => cfg.JobSigningPublicKey,
            Http = () => http,
            Log = log,
            CurrentVersion = version,
            UpdateStateDir = platform.StateDir,
        });

        // Signed tasks from the server: patch_scan and patch_install.
        var tasks = new LinuxTaskWorker(new LinuxTaskWorkerOptions
        {
            ApiBaseUrl = () => cfg.ApiBaseUrl,
            Token = () => cfg.AgentKey,
            AgentId = () => cfg.AgentId,
            PublicKeyPem = () => cfg.JobSigningPublicKey,
            Http = () => http,
            Log = log,
            StateDir = platform.StateDir,
        });

        _ = Guarded(updater.RunAsync, "Self-update", log, stop);
        _ = Guarded(tasks.RunAsync, "Task worker", log, stop);
        _ = Guarded(runner.RunAsync, "Check runner", log, stop);
    }

    // One failing feature must not take down the whole agent.
    private static async Task Guarded(Func<CancellationToken, Task> body, string name, Action<string> log, CancellationToken stop)
    {
        try
        {
            await body(stop);
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
            // normal shutdown
        }
        catch (Exception ex)
        {
            log($"{name} stopped: {ex.Message}");
        }
    }
}
