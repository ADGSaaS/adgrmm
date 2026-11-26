using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using AdgRmm.Agent.Shared;

namespace AdgRmm.Agent.Linux;

/// <summary>Runs the package manager on this machine for LinuxPatchEngine.</summary>
public sealed class LinuxPatchHost : ILinuxPatchHost
{
    private static readonly string[] BinDirs = { "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin" };

    public bool HasCommand(string name) => BinDirs.Any(d => File.Exists(Path.Combine(d, name)));
    public bool FileExists(string path) => File.Exists(path);

    public string? ReadText(string path)
    {
        try { return File.ReadAllText(path); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    public Task DelayAsync(TimeSpan delay, CancellationToken ct) => Task.Delay(delay, ct);

    public async Task<PatchProcResult> RunAsync(string file, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct)
    {
        var path = BinDirs.Select(d => Path.Combine(d, file)).FirstOrDefault(File.Exists) ?? file;
        var psi = new ProcessStartInfo(path)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        // English output, so the parsers and error markers work on any system language, and nothing that waits for a person.
        psi.Environment["LC_ALL"] = "C";
        psi.Environment["LANG"] = "C";
        psi.Environment["LANGUAGE"] = "C";
        psi.Environment["PATH"] = string.Join(':', BinDirs);
        psi.Environment["DEBIAN_FRONTEND"] = "noninteractive";
        psi.Environment["DEBIAN_PRIORITY"] = "critical";
        psi.Environment["APT_LISTCHANGES_FRONTEND"] = "none";
        psi.Environment["NEEDRESTART_SUSPEND"] = "1";
        psi.Environment["UCF_FORCE_CONFFOLD"] = "1";
        psi.Environment["ZYPP_LOCK_TIMEOUT"] = "120";
        psi.Environment["TERM"] = "dumb";

        Process proc;
        try { proc = Process.Start(psi) ?? throw new InvalidOperationException("could not start"); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return new PatchProcResult(127, "", $"{file}: {ex.Message}", false);
        }

        using (proc)
        {
            try { proc.StandardInput.Close(); } catch (IOException) { /* it already ended */ }
            var stdout = proc.StandardOutput.ReadToEndAsync();
            var stderr = proc.StandardError.ReadToEndAsync();

            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limit.CancelAfter(timeout);
            try
            {
                await proc.WaitForExitAsync(limit.Token);
            }
            catch (OperationCanceledException)
            {
                try { proc.Kill(entireProcessTree: true); } catch (InvalidOperationException) { /* already gone */ }
                ct.ThrowIfCancellationRequested();
                return new PatchProcResult(-1, await Safe(stdout), await Safe(stderr), true);
            }
            return new PatchProcResult(proc.ExitCode, await stdout, await stderr, false);
        }
    }

    private static async Task<string> Safe(Task<string> t)
    {
        try { return await t.WaitAsync(TimeSpan.FromSeconds(2)); }
        catch (Exception ex) when (ex is TimeoutException or IOException or ObjectDisposedException) { return ""; }
    }
}

/// <summary>
/// Whether this machine is waiting for a restart. Files the distribution writes are read as they are; for the rest, a
/// patch task leaves a marker that names the current boot, so a restart clears it by itself.
/// </summary>
public static class LinuxPendingReboot
{
    private const string BootIdPath = "/proc/sys/kernel/random/boot_id";

    public static string MarkerPath(string stateDir) => Path.Combine(stateDir, "reboot-needed");

    public static (bool Pending, string? Reason) Read(string stateDir)
    {
        try
        {
            if (File.Exists("/var/run/reboot-required") || File.Exists("/run/reboot-required"))
            {
                var pkgs = "";
                try { pkgs = File.ReadAllText(File.Exists("/run/reboot-required.pkgs") ? "/run/reboot-required.pkgs" : "/var/run/reboot-required.pkgs"); } catch (IOException) { /* optional */ }
                var names = pkgs.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(p => p.Trim()).Distinct().Take(6).ToArray();
                return (true, names.Length > 0 ? "Updates need a restart: " + string.Join(", ", names) : "Updates need a restart");
            }
            if (File.Exists("/run/reboot-needed")) return (true, "Updates need a restart");

            var marker = MarkerPath(stateDir);
            if (File.Exists(marker) && File.ReadAllText(marker).Trim() == File.ReadAllText(BootIdPath).Trim())
                return (true, "Updates need a restart");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* report no restart */ }
        return (false, null);
    }

    public static void Record(string stateDir, bool needed)
    {
        try
        {
            var marker = MarkerPath(stateDir);
            if (!needed) { File.Delete(marker); return; }
            Directory.CreateDirectory(stateDir);
            File.WriteAllText(marker, File.ReadAllText(BootIdPath).Trim());
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* best effort */ }
    }
}

public sealed class LinuxTaskWorkerOptions
{
    public required Func<string> ApiBaseUrl { get; init; }
    public required Func<string> Token { get; init; }
    public required Func<string> AgentId { get; init; }
    public required Func<string> PublicKeyPem { get; init; }
    public required Func<HttpClient> Http { get; init; }
    public required Action<string> Log { get; init; }
    public required string StateDir { get; init; }
    public ILinuxPatchHost Host { get; init; } = new LinuxPatchHost();
}

/// <summary>
/// Picks up signed tasks from the server the way the Windows agent does (POST /api/agent/tasks/next, then
/// /api/agent/tasks/complete) and runs the ones it understands: patch_scan and patch_install. Any other task type is
/// finished as failed with a plain message rather than left running for ever.
/// </summary>
public sealed class LinuxTaskWorker
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly LinuxTaskWorkerOptions _o;
    public LinuxTaskWorker(LinuxTaskWorkerOptions options) => _o = options;

    public async Task RunAsync(CancellationToken stop)
    {
        var idle = TimeSpan.FromSeconds(10);
        while (!stop.IsCancellationRequested)
        {
            var wait = idle;
            try
            {
                if (string.IsNullOrWhiteSpace(_o.Token()) || string.IsNullOrWhiteSpace(_o.AgentId()) || string.IsNullOrWhiteSpace(_o.ApiBaseUrl()))
                {
                    await Task.Delay(idle, stop);
                    continue;
                }
                wait = await PollOnce(stop) ? TimeSpan.FromSeconds(2) : idle;
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                _o.Log($"Task check failed: {ex.Message}");
                wait = TimeSpan.FromSeconds(30);
            }
            try { await Task.Delay(wait, stop); }
            catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>Returns true when a task was handled, so the next one is looked for soon.</summary>
    public async Task<bool> PollOnce(CancellationToken stop)
    {
        var baseUrl = _o.ApiBaseUrl().TrimEnd('/');
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/api/agent/tasks/next");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _o.Token());
        using var resp = await _o.Http().SendAsync(req, stop);

        if (resp.StatusCode == HttpStatusCode.NoContent) return false;
        if (resp.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.MethodNotAllowed)
        {
            // A server that has no task queue: ask again much later instead of every few seconds.
            await Task.Delay(TimeSpan.FromMinutes(5), stop);
            return false;
        }
        if (!resp.IsSuccessStatusCode)
        {
            _o.Log($"Task check failed: HTTP {(int)resp.StatusCode}");
            await Task.Delay(TimeSpan.FromSeconds(20), stop);
            return false;
        }

        var next = await resp.Content.ReadFromJsonAsync<NextTaskResponse>(JsonOpts, stop);
        if (next?.Task is null || next.Run is null || string.IsNullOrWhiteSpace(next.Task.Id) || string.IsNullOrWhiteSpace(next.Run.Id)) return false;

        var taskId = next.Task.Id;
        var runId = next.Run.Id;

        if (!AgentTaskEnvelope.TryOpen(next.Signed?.Payload, next.Signed?.Sig, _o.PublicKeyPem(), _o.AgentId(), taskId, next.Task.Type, DateTimeOffset.UtcNow, out var task, out var reason))
        {
            _o.Log($"Rejected task {taskId}: {reason}");
            await Complete(taskId, runId, "failed", null, reason, new { ok = false }, null, stop);
            return true;
        }

        _o.Log($"Claimed task {taskId} type={task!.Type}");
        try
        {
            switch (task.Type)
            {
                case "patch_scan": await HandleScan(task, runId, stop); break;
                case "patch_install": await HandleInstall(task, runId, stop); break;
                default:
                    await Complete(taskId, runId, "failed", null, $"The Linux agent does not run \"{task.Type}\" tasks.", new { ok = false }, null, stop);
                    break;
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
            // The agent is stopping or being updated; say so rather than leave the task looking busy.
            using var brief = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            try { await Complete(taskId, runId, "failed", null, "The agent was stopped before this finished.", new { ok = false }, null, brief.Token); } catch (Exception) { /* nothing more to do */ }
            throw;
        }
        return true;
    }

    private async Task HandleScan(OpenedTask task, string runId, CancellationToken ct)
    {
        try
        {
            var scan = await NewEngine().ScanAsync(task.ReadBool("includeOptional"), ct);
            LinuxPendingReboot.Record(_o.StateDir, scan.RebootRequired);
            await Complete(task.TaskId, runId, "succeeded", LinuxPatchReport.ScanStdout(scan), null,
                new { ok = true, count = scan.Patches.Count }, LinuxPatchReport.ScanArtifacts(scan), ct);
        }
        catch (LinuxPatchException ex)
        {
            await Complete(task.TaskId, runId, "failed", LinuxPatchParsers.Truncate(ex.Log, 12_000), ex.Message, new { ok = false }, null, ct);
        }
    }

    private async Task HandleInstall(OpenedTask task, string runId, CancellationToken ct)
    {
        var engine = NewEngine();
        var seconds = task.ReadInt("timeoutSec");
        if (seconds is { } s) engine.InstallTimeout = TimeSpan.FromSeconds(Math.Clamp(s, 300, 4 * 3600));
        try
        {
            var request = new LinuxInstallRequest { Mode = task.ReadString("mode") ?? "selected", Ids = task.ReadStrings("ids"), IncludeOptional = task.ReadBool("includeOptional") };
            var result = await engine.InstallAsync(request, ct);
            LinuxPendingReboot.Record(_o.StateDir, result.RebootRequired);
            var manager = LinuxPatchEngine.Detect(_o.Host, out _);
            await Complete(task.TaskId, runId, result.Ok ? "succeeded" : "failed", LinuxPatchReport.InstallStdout(result), result.Ok ? null : result.Message,
                new { ok = result.Ok, requiresReboot = result.RebootRequired }, LinuxPatchReport.InstallArtifacts(result, manager), ct);
        }
        catch (LinuxPatchException ex)
        {
            await Complete(task.TaskId, runId, "failed", LinuxPatchParsers.Truncate(ex.Log.Length > 0 ? ex.Log : engine.Log, 12_000), ex.Message, new { ok = false }, null, ct);
        }
    }

    private LinuxPatchEngine NewEngine() => new(_o.Host);

    private async Task Complete(string taskId, string runId, string status, string? stdout, string? stderr, object output, object? artifacts, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{_o.ApiBaseUrl().TrimEnd('/')}/api/agent/tasks/complete");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _o.Token());
        req.Content = JsonContent.Create(new { taskId, runId, status, stdout, stderr, output, artifacts }, options: JsonOpts);
        using var resp = await _o.Http().SendAsync(req, ct);
        resp.EnsureSuccessStatusCode();
    }

    private sealed class NextTaskResponse
    {
        public ClaimedTask? Task { get; set; }
        public ClaimedRun? Run { get; set; }
        public SignedBody? Signed { get; set; }
    }
    private sealed class SignedBody { public string Payload { get; set; } = ""; public string Sig { get; set; } = ""; }
    private sealed class ClaimedTask { public string Id { get; set; } = ""; public string Type { get; set; } = ""; }
    private sealed class ClaimedRun { public string Id { get; set; } = ""; }
}
