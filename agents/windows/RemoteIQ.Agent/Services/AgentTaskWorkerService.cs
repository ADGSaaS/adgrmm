// RemoteIQ.Agent/Services/AgentTaskWorkerService.cs

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using RemoteIQ.Agent.Shared;

namespace RemoteIQ.Agent.Services;

public sealed class AgentTaskWorkerService : BackgroundService
{
    private readonly ConfigService _cfg;
    private readonly PinnedHttpClientFactory _httpFactory;
    private readonly PatchService _patch;
    private readonly CheckRunnerService _checks;
    private readonly SoftwareInstallService _software;
    private readonly CryptoService _crypto;
    private readonly ILogger<AgentTaskWorkerService> _log;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };

    public AgentTaskWorkerService(
        ConfigService cfg,
        PinnedHttpClientFactory httpFactory,
        PatchService patch,
        CheckRunnerService checks,
        SoftwareInstallService software,
        CryptoService crypto,
        ILogger<AgentTaskWorkerService> log)
    {
        _crypto = crypto;
        _cfg = cfg;
        _httpFactory = httpFactory;
        _patch = patch;
        _checks = checks;
        _software = software;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var idleDelay = TimeSpan.FromSeconds(10);
        var afterWorkDelay = TimeSpan.FromSeconds(2);
        var errorDelay = TimeSpan.FromSeconds(5);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(_cfg.Current.AgentId) ||
                    string.IsNullOrWhiteSpace(_cfg.Current.AgentKey) ||
                    string.IsNullOrWhiteSpace(_cfg.Current.ApiBaseUrl))
                {
                    await Task.Delay(idleDelay, stoppingToken);
                    continue;
                }

                var http = _httpFactory.Create();
                http.DefaultRequestHeaders.Authorization =
                    new AuthenticationHeaderValue("Bearer", _cfg.Current.AgentKey);

                var baseUrl = _cfg.Current.ApiBaseUrl.TrimEnd('/');

                // ✅ Backend is POST /api/agent/tasks/next
                var nextUrl = $"{baseUrl}/api/agent/tasks/next";
                using var resp = await http.PostAsync(nextUrl, content: null, cancellationToken: stoppingToken);

                if (resp.StatusCode == HttpStatusCode.NoContent)
                {
                    await Task.Delay(idleDelay, stoppingToken);
                    continue;
                }

                if (!resp.IsSuccessStatusCode)
                {
                    var bodyText = "";
                    try { bodyText = await resp.Content.ReadAsStringAsync(stoppingToken); } catch { /* ignore */ }

                    // Always show the status at WARNING (your logger is Info+, so you'll actually see it)
                    _log.LogWarning("Task next failed: HTTP {Status} {Reason}. Body: {Body}",
                        (int)resp.StatusCode, resp.ReasonPhrase ?? "", bodyText);

                    await Task.Delay(idleDelay, stoppingToken);
                    continue;
                }


                var nextResp = await resp.Content.ReadFromJsonAsync<NextTaskResponse>(JsonOpts, stoppingToken);
                if (nextResp?.Task is null || nextResp.Run is null ||
                    string.IsNullOrWhiteSpace(nextResp.Task.Id) ||
                    string.IsNullOrWhiteSpace(nextResp.Run.Id))
                {
                    await Task.Delay(idleDelay, stoppingToken);
                    continue;
                }

                var taskId = nextResp.Task.Id;
                var runId = nextResp.Run.Id;

                // Tasks follow the same rule as jobs: nothing runs unless the server signed it.
                var signed = _crypto.OpenSigned(nextResp.Signed?.Payload, nextResp.Signed?.Sig, "taskId", out var signReason);
                var signedTaskId = signed is { } s1 && s1.TryGetProperty("taskId", out var sid) ? sid.GetString() : null;
                var signedType = signed is { } s2 && s2.TryGetProperty("type", out var sty) ? sty.GetString() : null;
                if (signed is null || signedTaskId != taskId || signedType != nextResp.Task.Type)
                {
                    _log.LogWarning("Rejected task {TaskId}: {Reason}", taskId, signed is null ? signReason : "signed details do not match");
                    await Task.Delay(afterWorkDelay, stoppingToken);
                    continue;
                }
                nextResp.Task.Payload = signed.Value.TryGetProperty("payload", out var signedPayload) && signedPayload.ValueKind == JsonValueKind.Object
                    ? JsonSerializer.Deserialize<Dictionary<string, object>>(signedPayload.GetRawText(), JsonOpts)
                    : null;

                _log.LogInformation("Claimed task {TaskId} type={Type} run={RunId} attempt={Attempt}",
                    taskId, nextResp.Task.Type, runId, nextResp.Run.Attempt);

                if (string.Equals(nextResp.Task.Type, "patch_scan", StringComparison.OrdinalIgnoreCase))
                {
                    await HandlePatchScan(http, baseUrl, taskId, runId, nextResp.Task.Payload, stoppingToken);
                }
                else if (string.Equals(nextResp.Task.Type, "patch_install", StringComparison.OrdinalIgnoreCase))
                {
                    await HandlePatchInstall(http, baseUrl, taskId, runId, nextResp.Task.Payload, stoppingToken);
                }
                else if (string.Equals(nextResp.Task.Type, "run_checks", StringComparison.OrdinalIgnoreCase))
                {
                    await HandleRunChecks(http, baseUrl, taskId, runId, nextResp.Task.Payload, stoppingToken);
                }
                else if (string.Equals(nextResp.Task.Type, "software_install", StringComparison.OrdinalIgnoreCase))
                {
                    await HandleSoftwareInstall(http, baseUrl, taskId, runId, nextResp.Task.Payload, stoppingToken);
                }
                else if (string.Equals(nextResp.Task.Type, "software_updates_scan", StringComparison.OrdinalIgnoreCase))
                {
                    await HandleSoftwareUpdatesScan(http, baseUrl, taskId, runId, nextResp.Task.Payload, stoppingToken);
                }
                else
                {
                    await Complete(http, baseUrl, taskId, runId,
                        status: "failed",
                        stdout: null,
                        stderr: $"Unknown task type: {nextResp.Task.Type}",
                        output: new { ok = false },
                        artifacts: null,
                        ct: stoppingToken);
                }

                await Task.Delay(afterWorkDelay, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _log.LogDebugThrottled("task-worker", TimeSpan.FromMinutes(1),
                    "Task worker error: {Msg}", ex.Message);
                await Task.Delay(errorDelay, stoppingToken);
            }
        }
    }

    /// <summary>Runs the named checks (or all of them) right now. The results go to the server the usual way.</summary>
    private async Task HandleRunChecks(
        HttpClient http,
        string baseUrl,
        string taskId,
        string runId,
        Dictionary<string, object>? payload,
        CancellationToken ct)
    {
        try
        {
            var keys = ReadStringArray(payload, "keys");
            var ran = await _checks.RunNowAsync(keys, ct);

            await Complete(http, baseUrl, taskId, runId,
                status: "succeeded",
                stdout: $"Ran {ran} check(s).",
                stderr: null,
                output: new { ok = true, count = ran },
                artifacts: null,
                ct: ct);
        }
        catch (Exception ex)
        {
            await Complete(http, baseUrl, taskId, runId,
                status: "failed",
                stdout: null,
                stderr: ex.Message,
                output: new { ok = false },
                artifacts: null,
                ct: ct);
        }
    }

    /// <summary>Installs or uninstalls a library program. See <see cref="SoftwareInstallService"/>.</summary>
    private async Task HandleSoftwareInstall(
        HttpClient http,
        string baseUrl,
        string taskId,
        string runId,
        Dictionary<string, object>? payload,
        CancellationToken ct)
    {
        try
        {
            if (!SoftwareInstallRequest.TryParse(key => ReadString(payload, key), out var request, out var error))
            {
                await Complete(http, baseUrl, taskId, runId,
                    status: "failed",
                    stdout: null,
                    stderr: error,
                    output: new { ok = false, verified = false, method = ReadString(payload, "method"), action = ReadString(payload, "action"), exitCode = (int?)null, message = error },
                    artifacts: null,
                    ct: ct);
                return;
            }

            var r = await _software.RunAsync(request, ct);
            await Complete(http, baseUrl, taskId, runId,
                status: r.Ok ? "succeeded" : "failed",
                stdout: r.Stdout,
                stderr: r.Stderr,
                output: new { ok = r.Ok, verified = r.Verified, method = r.Method, action = r.Action, exitCode = r.ExitCode, message = r.Message },
                artifacts: null,
                ct: ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            await Complete(http, baseUrl, taskId, runId,
                status: "failed",
                stdout: null,
                stderr: ex.Message,
                output: new { ok = false, verified = false, method = (string?)null, action = (string?)null, exitCode = (int?)null, message = ex.Message },
                artifacts: null,
                ct: ct);
        }
    }

    /// <summary>Lists programs with a newer version (winget, Chocolatey). Changes nothing. See <see cref="SoftwareInstallService.ScanAsync"/>.</summary>
    private async Task HandleSoftwareUpdatesScan(
        HttpClient http,
        string baseUrl,
        string taskId,
        string runId,
        Dictionary<string, object>? payload,
        CancellationToken ct)
    {
        try
        {
            if (!UpdatesScanRequest.TryParse(key => ReadString(payload, key), out var request, out var error))
            {
                await Complete(http, baseUrl, taskId, runId, status: "failed", stdout: null, stderr: error,
                    output: new { ok = false, message = error }, artifacts: null, ct: ct);
                return;
            }
            var r = await _software.ScanAsync(request, ct);
            await Complete(http, baseUrl, taskId, runId,
                status: r.Ok ? "succeeded" : "failed",
                stdout: r.Message,
                stderr: r.Ok ? null : r.Message,
                output: new { ok = r.Ok, message = r.Message, count = r.Apps.Count },
                artifacts: new
                {
                    apps = r.Apps,
                    winget = new { state = r.Winget.State, message = r.Winget.Message },
                    chocolatey = new { state = r.Chocolatey.State, message = r.Chocolatey.Message },
                },
                ct: ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            await Complete(http, baseUrl, taskId, runId, status: "failed", stdout: null, stderr: ex.Message,
                output: new { ok = false, message = ex.Message }, artifacts: null, ct: ct);
        }
    }

    private static string? ReadString(Dictionary<string, object>? payload, string key)
    {
        if (payload is null) return null;
        // "runAs.user" reads the user field of the runAs object.
        var dot = key.IndexOf('.');
        if (dot > 0)
        {
            if (!payload.TryGetValue(key[..dot], out var parent) || parent is not JsonElement pe || pe.ValueKind != JsonValueKind.Object) return null;
            return pe.TryGetProperty(key[(dot + 1)..], out var child) && child.ValueKind == JsonValueKind.String ? child.GetString() : null;
        }
        if (!payload.TryGetValue(key, out var raw) || raw is null) return null;
        if (raw is JsonElement je)
            return je.ValueKind switch
            {
                JsonValueKind.String => je.GetString(),
                JsonValueKind.Null or JsonValueKind.Undefined => null,
                _ => je.ToString()
            };
        return raw.ToString();
    }

    private async Task HandlePatchScan(
        HttpClient http,
        string baseUrl,
        string taskId,
        string runId,
        Dictionary<string, object>? payload,
        CancellationToken ct)
    {
        try
        {
            var includeOptional = ReadBool(payload, "includeOptional", defaultValue: false);
            var patches = _patch.ScanWindowsUpdates(includeOptional);

            var artifacts = new
            {
                patches = patches.Select(p => new
                {
                    id = p.Id,
                    title = p.Title,
                    severity = p.Severity,
                    requiresReboot = p.RequiresReboot,
                    kbIds = p.KbIds
                }).ToList()
            };

            await Complete(http, baseUrl, taskId, runId,
                status: "succeeded",
                stdout: $"Found {patches.Count} available update(s).",
                stderr: null,
                output: new { ok = true, count = patches.Count },
                artifacts: artifacts,
                ct: ct);
        }
        catch (Exception ex)
        {
            await Complete(http, baseUrl, taskId, runId,
                status: "failed",
                stdout: null,
                stderr: ex.Message,
                output: new { ok = false },
                artifacts: null,
                ct: ct);
        }
    }

    private async Task HandlePatchInstall(
        HttpClient http,
        string baseUrl,
        string taskId,
        string runId,
        Dictionary<string, object>? payload,
        CancellationToken ct)
    {
        try
        {
            var includeOptional = ReadBool(payload, "includeOptional", defaultValue: false);
            var ids = ReadStringArray(payload, "ids");

            if (ids.Length == 0)
            {
                await Complete(http, baseUrl, taskId, runId,
                    status: "failed",
                    stdout: null,
                    stderr: "payload.ids is required",
                    output: new { ok = false },
                    artifacts: null,
                    ct: ct);
                return;
            }

            var (ok, stdout, stderr, reboot, installed) = _patch.InstallWindowsUpdatesByIds(ids, includeOptional);

            await Complete(http, baseUrl, taskId, runId,
                status: ok ? "succeeded" : "failed",
                stdout: stdout,
                stderr: stderr,
                output: new { ok, requiresReboot = reboot },
                artifacts: new { installed, requiresReboot = reboot },
                ct: ct);
        }
        catch (Exception ex)
        {
            await Complete(http, baseUrl, taskId, runId,
                status: "failed",
                stdout: null,
                stderr: ex.Message,
                output: new { ok = false },
                artifacts: null,
                ct: ct);
        }
    }

    // ✅ Backend endpoint is POST /api/agent/tasks/complete
    private static async Task Complete(
        HttpClient http,
        string baseUrl,
        string taskId,
        string runId,
        string status,
        string? stdout,
        string? stderr,
        object? output,
        object? artifacts,
        CancellationToken ct)
    {
        var url = $"{baseUrl}/api/agent/tasks/complete";
        var body = new
        {
            taskId,
            runId,
            status,
            stdout,
            stderr,
            output,
            artifacts
        };

        var resp = await http.PostAsJsonAsync(url, body, JsonOpts, ct);
        resp.EnsureSuccessStatusCode();
    }

    private static bool ReadBool(Dictionary<string, object>? payload, string key, bool defaultValue)
    {
        if (payload is null) return defaultValue;
        if (!payload.TryGetValue(key, out var raw) || raw is null) return defaultValue;

        try
        {
            if (raw is bool b) return b;

            if (raw is JsonElement je)
            {
                if (je.ValueKind == JsonValueKind.True) return true;
                if (je.ValueKind == JsonValueKind.False) return false;

                if (je.ValueKind == JsonValueKind.Number && je.TryGetInt32(out var i)) return i != 0;
                if (je.ValueKind == JsonValueKind.String && bool.TryParse(je.GetString(), out var sb)) return sb;
            }

            if (raw is string s && bool.TryParse(s, out var bs)) return bs;
            if (raw is int i2) return i2 != 0;
            if (raw is long l2) return l2 != 0;
        }
        catch
        {
            // ignore
        }

        return defaultValue;
    }

    private static string[] ReadStringArray(Dictionary<string, object>? payload, string key)
    {
        if (payload is null) return Array.Empty<string>();
        if (!payload.TryGetValue(key, out var raw) || raw is null) return Array.Empty<string>();

        try
        {
            if (raw is JsonElement je && je.ValueKind == JsonValueKind.Array)
            {
                return je.EnumerateArray()
                    .Select(x => x.ValueKind == JsonValueKind.String ? x.GetString() : x.ToString())
                    .Where(s => !string.IsNullOrWhiteSpace(s))
                    .Select(s => s!.Trim())
                    .ToArray();
            }

            if (raw is object[] arr)
            {
                return arr.Select(x => x?.ToString() ?? "")
                    .Where(s => !string.IsNullOrWhiteSpace(s))
                    .Select(s => s.Trim())
                    .ToArray();
            }

            if (raw is string s && !string.IsNullOrWhiteSpace(s))
                return new[] { s.Trim() };
        }
        catch
        {
            // ignore
        }

        return Array.Empty<string>();
    }

    // Matches backend response: { ok, task, run }
    private sealed class NextTaskResponse
    {
        public bool Ok { get; set; }
        public ClaimedTask? Task { get; set; }
        public ClaimedRun? Run { get; set; }
        public SignedEnvelope? Signed { get; set; }
    }

    private sealed class SignedEnvelope
    {
        public string Payload { get; set; } = "";
        public string Sig { get; set; } = "";
    }

    private sealed class ClaimedTask
    {
        public string Id { get; set; } = "";
        public string Type { get; set; } = "";
        public Dictionary<string, object>? Payload { get; set; }
    }

    private sealed class ClaimedRun
    {
        public string Id { get; set; } = "";
        public string TaskId { get; set; } = "";
        public int Attempt { get; set; }
        public string Status { get; set; } = "";
        public string StartedAt { get; set; } = "";
    }
}
