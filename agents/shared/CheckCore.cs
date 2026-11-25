using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace RemoteIQ.Agent.Shared;

public sealed class CheckDefinition
{
    public string Key { get; set; } = "";
    public string Type { get; set; } = "";
    public string Name { get; set; } = "";
    public int IntervalSec { get; set; } = 300;
    public int TimeoutSec { get; set; } = 30;

    public string? Path { get; set; }
    public string? Service { get; set; }
    public string? Process { get; set; }
    public string? Host { get; set; }
    public int? Port { get; set; }
    public double? Warn { get; set; }
    public double? Crit { get; set; }

    /// <summary>Status when a service, process or host is down: WARN or CRIT.</summary>
    public string? DownStatus { get; set; }
}

public sealed class CheckPlan
{
    public string Mode { get; set; } = "default";
    public List<CheckDefinition> Checks { get; set; } = new();
    public bool IncludeDefaults { get; set; }
}

public sealed class CheckRun
{
    public string? DedupeKey { get; set; }
    public string? CheckType { get; set; }
    public string? CheckName { get; set; }
    public string Status { get; set; } = "UNKNOWN";
    public string? Severity { get; set; }
    public Dictionary<string, object>? Metrics { get; set; }
    public string? Output { get; set; }
    public string? StartedAt { get; set; }
    public string? FinishedAt { get; set; }
}

public readonly record struct CpuTimes(ulong Idle, ulong Total);
public readonly record struct MemorySample(long TotalBytes, long AvailableBytes);
public readonly record struct DiskSample(string Mount, long TotalBytes, long FreeBytes);
public readonly record struct ServiceSample(bool Exists, bool Running, string Detail);

/// <summary>Read-only measurements. Nothing here changes the machine.</summary>
public interface ICheckProbes
{
    CpuTimes? ReadCpuTimes();
    MemorySample? ReadMemory();
    IReadOnlyList<DiskSample> ReadDisks();
    ServiceSample ReadService(string name);

    /// <summary>Names of units that have failed, or null where the OS has no such idea.</summary>
    IReadOnlyList<string>? ReadFailedServices();

    IReadOnlyList<CheckDefinition> PlatformDefaults();

    /// <summary>Cumulative byte counters of the real network adapters that are up (see PerfFilters). Null where unsupported.</summary>
    NetworkSample? ReadNetwork() => null;

    /// <summary>Disk activity of the physical disks (see DiskIoReading). Nothing here blocks for long.</summary>
    DiskIoReading ReadDiskIo() => new(Reason: "Disk activity is not measured on this system.");
}

public static class CheckEvaluation
{
    public const string FailedUnitsService = "*failed*";

    /// <summary>Measurements that are never pass/fail: their results always carry status OK, so they cannot raise an alert.</summary>
    public static bool IsInformational(string? type) =>
        string.Equals(type, "NETWORK", StringComparison.OrdinalIgnoreCase) || string.Equals(type, "DISKIO", StringComparison.OrdinalIgnoreCase);

    public static string HigherIsWorse(double value, double warn, double crit) =>
        value >= crit ? "CRIT" : value >= warn ? "WARN" : "OK";

    public static string LowerIsWorse(double value, double warn, double crit) =>
        value <= crit ? "CRIT" : value <= warn ? "WARN" : "OK";

    public static double CpuBusyPercent(CpuTimes before, CpuTimes after)
    {
        if (after.Total <= before.Total) return 0;
        var total = after.Total - before.Total;
        var idle = after.Idle >= before.Idle ? after.Idle - before.Idle : 0;
        return Math.Clamp(100.0 * (total - Math.Min(idle, total)) / total, 0, 100);
    }

    // Severity is only meaningful for a problem, so a passing run does not carry one.
    public static string? SeverityFor(string status) => status switch
    {
        "WARN" => "WARN",
        "CRIT" or "TIMEOUT" => "CRIT",
        _ => null,
    };

    public static bool IsSafeServiceName(string? name) =>
        !string.IsNullOrEmpty(name) && name.Length <= 256 && Regex.IsMatch(name, @"^[A-Za-z0-9:_.@\\ -]+$") && !name.StartsWith('-');

    public static bool IsSafeHost(string? host) =>
        !string.IsNullOrEmpty(host) && host.Length <= 253 && Regex.IsMatch(host, @"^[A-Za-z0-9.:\-\[\]]+$") && !host.StartsWith('-');

    /// <summary>Checks every device gets when nothing custom is assigned to it.</summary>
    public static List<CheckDefinition> Defaults(ICheckProbes probes)
    {
        var list = new List<CheckDefinition>
        {
            new() { Key = "builtin:disk", Type = "DISK", Name = "Disk free", Warn = 10, Crit = 5 },
            new() { Key = "builtin:memory", Type = "MEMORY", Name = "Memory usage", Warn = 90, Crit = 97 },
            new() { Key = "builtin:cpu", Type = "CPU", Name = "CPU usage", Warn = 90, Crit = 98 },
            // Informational: no thresholds, never a problem. They only feed the performance graphs.
            new() { Key = "builtin:network", Type = "NETWORK", Name = "Network traffic" },
            new() { Key = "builtin:diskio", Type = "DISKIO", Name = "Disk activity" },
            new() { Key = "builtin:server", Type = "PORT", Name = "Connection to server", DownStatus = "WARN" },
            new() { Key = "builtin:agent-update", Type = "AGENT", Name = "Agent update" },
        };
        list.AddRange(probes.PlatformDefaults());
        return list;
    }

    /// <summary>Opens a { payload, sig } envelope from the server. Only the signed bytes are parsed.</summary>
    public static bool TryOpenPlan(string? payloadB64, string? sigB64, string? publicKeyPem, string agentId, DateTimeOffset now, out CheckPlan? plan, out string reason)
    {
        plan = null;
        if (string.IsNullOrWhiteSpace(publicKeyPem)) { reason = "This agent has no signing key."; return false; }
        if (string.IsNullOrEmpty(payloadB64) || string.IsNullOrEmpty(sigB64)) { reason = "The plan is not signed."; return false; }

        try
        {
            var bytes = Convert.FromBase64String(payloadB64);
            using var rsa = RSA.Create();
            rsa.ImportFromPem(publicKeyPem);
            if (!rsa.VerifyData(bytes, Convert.FromBase64String(sigB64), HashAlgorithmName.SHA256, RSASignaturePadding.Pss))
            {
                reason = "The plan's signature is invalid.";
                return false;
            }

            using var doc = JsonDocument.Parse(bytes);
            var root = doc.RootElement;

            var signedFor = root.TryGetProperty("agentId", out var a) ? a.GetString() : null;
            if (!string.Equals(signedFor, agentId, StringComparison.OrdinalIgnoreCase))
            {
                reason = "The plan was signed for a different agent.";
                return false;
            }

            var issued = root.TryGetProperty("iat", out var i) && i.TryGetInt64(out var ms)
                ? DateTimeOffset.FromUnixTimeMilliseconds(ms)
                : DateTimeOffset.MinValue;
            if ((now - issued).Duration() > TimeSpan.FromMinutes(15))
            {
                reason = "The plan's signature has expired. Check this device's clock.";
                return false;
            }

            plan = root.Deserialize<CheckPlan>(new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            reason = plan is null ? "The plan is empty." : "";
            return plan is not null;
        }
        catch (Exception ex)
        {
            reason = "The plan could not be read: " + ex.Message;
            return false;
        }
    }
}

public sealed class CheckRunnerOptions
{
    public required Func<string> ApiBaseUrl { get; init; }
    public required Func<string> Token { get; init; }
    public required Func<string> AgentId { get; init; }
    public required Func<string> DeviceId { get; init; }
    public required Func<string> PublicKeyPem { get; init; }
    public required Func<HttpClient> Http { get; init; }
    public required Action<string> Log { get; init; }
    public required string CurrentVersion { get; init; }
    public required string UpdateStateDir { get; init; }
}

/// <summary>
/// Runs read-only checks on the agent's own schedule and posts the results. The agent schedules
/// them because it stays useful when the server is briefly away, and results sent late still count.
/// </summary>
public sealed class CheckRunner
{
    private const int MaxBuffered = 500;
    private const int MaxBatch = 100;
    private static readonly TimeSpan PlanEvery = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(15);

    private static readonly JsonSerializerOptions JsonOut = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly ICheckProbes _probes;
    private readonly CheckRunnerOptions _o;
    private readonly Dictionary<string, DateTimeOffset> _nextDue = new();
    // One thing at a time touches the schedule and the buffer: the timer loop, or a run requested from the server.
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly List<CheckRun> _buffer = new();

    private List<CheckDefinition> _checks;
    private CpuTimes? _lastCpu;
    private readonly CounterRateTracker _netRate = new();
    private readonly CounterRateTracker _diskRate = new();
    private DateTimeOffset _planFetchedAt = DateTimeOffset.MinValue;
    private string _lastPlanProblem = "";
    private string _lastPostProblem = "";

    public CheckRunner(ICheckProbes probes, CheckRunnerOptions options)
    {
        _probes = probes;
        _o = options;
        _checks = CheckEvaluation.Defaults(probes);
    }

    public IReadOnlyList<CheckRun> Buffered => _buffer;
    public IReadOnlyList<CheckDefinition> CurrentChecks => _checks;

    public async Task RunAsync(CancellationToken ct)
    {
        // Spread out so agents restarted together do not all report in the same instant.
        await Task.Delay(TimeSpan.FromSeconds(10 + Random.Shared.Next(50)), ct);

        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (!string.IsNullOrEmpty(_o.Token()) && !string.IsNullOrEmpty(_o.AgentId()))
                {
                    await _gate.WaitAsync(ct);
                    try
                    {
                        if (DateTimeOffset.UtcNow - _planFetchedAt > PlanEvery) await RefreshPlanAsync(ct);
                        await RunDueAsync(ct);
                        await FlushAsync(ct);
                    }
                    finally
                    {
                        _gate.Release();
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _o.Log($"Check runner error: {ex.Message}");
            }

            await Task.Delay(Tick, ct);
        }
    }

    /// <summary>
    /// Runs checks now instead of waiting for their schedule, and sends the results at once. With no keys every check runs;
    /// otherwise the checks whose key matches (a result key such as "disk:c:" matches the "disk" check that made it).
    /// The plan is fetched first, so a check someone added a moment ago is known. Returns how many ran.
    /// </summary>
    public async Task<int> RunNowAsync(IReadOnlyCollection<string> keys, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(_o.Token()) || string.IsNullOrEmpty(_o.AgentId()))
            throw new InvalidOperationException("This agent is not enrolled yet.");

        await _gate.WaitAsync(ct);
        try
        {
            await RefreshPlanAsync(ct);
            var wanted = keys.Count == 0
                ? _checks.ToList()
                : _checks.Where(c => keys.Any(k => MatchesKey(k, c.Key))).ToList();

            var now = DateTimeOffset.UtcNow;
            foreach (var check in wanted)
            {
                // The schedule carries on from this run, so the same check does not run again a moment later.
                _nextDue[check.Key] = now.AddSeconds(Math.Clamp(check.IntervalSec, 60, 86400));
                foreach (var run in await ExecuteAsync(check, ct))
                    Buffer(run);
            }

            await FlushAsync(ct);
            return wanted.Count;
        }
        finally
        {
            _gate.Release();
        }
    }

    private static bool MatchesKey(string requested, string key) =>
        string.Equals(requested, key, StringComparison.OrdinalIgnoreCase) ||
        requested.StartsWith(key + ":", StringComparison.OrdinalIgnoreCase);

    public async Task RefreshPlanAsync(CancellationToken ct)
    {
        _planFetchedAt = DateTimeOffset.UtcNow;
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{_o.ApiBaseUrl().TrimEnd('/')}/api/agent/ingest/check-plan");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _o.Token());
            using var resp = await _o.Http().SendAsync(req, ct);
            resp.EnsureSuccessStatusCode();

            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
            var payload = doc.RootElement.TryGetProperty("payload", out var p) ? p.GetString() : null;
            var sig = doc.RootElement.TryGetProperty("sig", out var s) ? s.GetString() : null;

            if (!CheckEvaluation.TryOpenPlan(payload, sig, _o.PublicKeyPem(), _o.AgentId(), DateTimeOffset.UtcNow, out var plan, out var reason))
                throw new InvalidDataException(reason);

            _checks = plan!.Mode == "custom" && plan.Checks.Count > 0
                ? (plan.IncludeDefaults ? CheckEvaluation.Defaults(_probes).Concat(plan.Checks).ToList() : plan.Checks)
                : CheckEvaluation.Defaults(_probes);
            _lastPlanProblem = "";
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // What it was already running is safe to continue, since checks only read.
            if (ex.Message != _lastPlanProblem) _o.Log($"Could not get the check plan; keeping the current one: {ex.Message}");
            _lastPlanProblem = ex.Message;
        }
    }

    public async Task RunDueAsync(CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var check in _checks.ToArray())
        {
            if (_nextDue.TryGetValue(check.Key, out var due) && now < due) continue;

            // A little jitter, so a fleet that started together drifts apart.
            var seconds = Math.Clamp(check.IntervalSec, 60, 86400);
            _nextDue[check.Key] = now.AddSeconds(seconds * (0.95 + 0.1 * Random.Shared.NextDouble()));

            foreach (var run in await ExecuteAsync(check, ct))
                Buffer(run);
        }
    }

    private void Buffer(CheckRun run)
    {
        _buffer.Add(run);
        if (_buffer.Count > MaxBuffered) _buffer.RemoveRange(0, _buffer.Count - MaxBuffered);
    }

    public async Task FlushAsync(CancellationToken ct)
    {
        while (_buffer.Count > 0)
        {
            var batch = _buffer.Take(MaxBatch).ToList();
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, $"{_o.ApiBaseUrl().TrimEnd('/')}/api/agent/ingest/check-runs");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _o.Token());
                req.Content = JsonContent.Create(new { deviceId = _o.DeviceId(), runs = batch }, options: JsonOut);
                using var resp = await _o.Http().SendAsync(req, ct);

                // A rejected batch would be rejected again, so it must not block everything after it.
                if ((int)resp.StatusCode is >= 400 and < 500 and not 401 and not 408 and not 429)
                {
                    var detail = await resp.Content.ReadAsStringAsync(ct);
                    _o.Log($"The server rejected {batch.Count} check result(s) with {(int)resp.StatusCode}: {detail[..Math.Min(detail.Length, 300)]}");
                }
                else
                {
                    resp.EnsureSuccessStatusCode();
                }

                _buffer.RemoveRange(0, batch.Count);
                _lastPostProblem = "";
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                if (ex.Message != _lastPostProblem) _o.Log($"Could not send check results; keeping them: {ex.Message}");
                _lastPostProblem = ex.Message;
                return;
            }
        }
    }

    public async Task<List<CheckRun>> ExecuteAsync(CheckDefinition check, CancellationToken ct)
    {
        var started = DateTimeOffset.UtcNow;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(check.TimeoutSec, 1, 300)));

        List<CheckRun> runs;
        try
        {
            // Probes can block on a hung mount or service manager, so they stay off this loop.
            runs = await Task.Run(() => ProbeAsync(check, timeout.Token), timeout.Token).WaitAsync(timeout.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            runs = new() { Make(check, check.Key, check.Name, "TIMEOUT", $"The check did not finish within {check.TimeoutSec} seconds.", null) };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            runs = new() { Make(check, check.Key, check.Name, "UNKNOWN", $"The check could not run: {ex.Message}", null) };
        }

        var finished = DateTimeOffset.UtcNow;
        foreach (var run in runs)
        {
            if (IsInformationalType(check.Type))
            {
                // A measurement that failed is not a problem with the device: report why, as an OK result.
                if (run.Metrics is null) run.Metrics = new() { ["reason"] = run.Output ?? "Not measured." };
                run.Status = "OK";
                run.Severity = null;
            }
            run.StartedAt = started.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
            run.FinishedAt = finished.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
        }
        return runs;
    }

    private async Task<List<CheckRun>> ProbeAsync(CheckDefinition c, CancellationToken ct)
    {
        switch (c.Type.ToUpperInvariant())
        {
            case "DISK": return ProbeDisks(c);
            case "MEMORY": return new() { ProbeMemory(c) };
            case "CPU": return new() { await ProbeCpuAsync(c, ct) };
            case "SERVICE": return new() { ProbeService(c) };
            case "PROCESS": return new() { ProbeProcess(c) };
            case "PORT": return new() { await ProbePortAsync(c, ct) };
            case "PING": return new() { await ProbePingAsync(c, ct) };
            case "AGENT": return new() { ProbeAgentUpdate(c) };
            case "NETWORK": return ProbeNetwork(c);
            case "DISKIO": return ProbeDiskIo(c);
            default: return new() { Make(c, c.Key, c.Name, "UNKNOWN", $"This agent has no check of type {c.Type}.", null) };
        }
    }

    private static Dictionary<string, object> WithThresholds(Dictionary<string, object> metrics, double warn, double crit)
    {
        metrics["thresholds"] = new Dictionary<string, object> { ["warn"] = warn, ["crit"] = crit };
        return metrics;
    }

    private List<CheckRun> ProbeDisks(CheckDefinition c)
    {
        var warn = c.Warn ?? 10;
        var crit = c.Crit ?? 5;
        var disks = _probes.ReadDisks();
        if (!string.IsNullOrEmpty(c.Path))
            disks = disks.Where(d => string.Equals(d.Mount.TrimEnd('\\', '/'), c.Path.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase)).ToList();
        if (disks.Count == 0)
            return new() { Make(c, c.Key, c.Name, "UNKNOWN", string.IsNullOrEmpty(c.Path) ? "No fixed disks were found." : $"{c.Path} was not found.", null) };

        return disks.Select(d =>
        {
            var percent = d.TotalBytes > 0 ? Math.Round(d.FreeBytes * 100.0 / d.TotalBytes, 1) : 0;
            var freeGb = Math.Round(d.FreeBytes / 1073741824.0, 1);
            var totalGb = Math.Round(d.TotalBytes / 1073741824.0, 1);
            var status = CheckEvaluation.LowerIsWorse(percent, warn, crit);
            var mount = d.Mount.Length > 1 ? d.Mount.TrimEnd('\\', '/') : d.Mount;
            return Make(c, $"{c.Key}:{mount.ToLowerInvariant()}", $"{c.Name} {mount}", status,
                $"{mount} has {freeGb} GB free of {totalGb} GB ({percent}%).",
                WithThresholds(new() { ["freePercent"] = percent, ["freeGb"] = freeGb, ["totalGb"] = totalGb }, warn, crit));
        }).ToList();
    }

    private static bool IsInformationalType(string type) => CheckEvaluation.IsInformational(type);

    private static double MaxRateGapSeconds(CheckDefinition c) => Math.Max(900, 3.0 * Math.Clamp(c.IntervalSec, 60, 86400));

    private static string Rate(double bytesPerSec) =>
        bytesPerSec >= 1048576 ? (bytesPerSec / 1048576).ToString("0.0", CultureInfo.InvariantCulture) + " MB/s"
        : bytesPerSec >= 1024 ? (bytesPerSec / 1024).ToString("0.0", CultureInfo.InvariantCulture) + " KB/s"
        : Math.Round(bytesPerSec).ToString(CultureInfo.InvariantCulture) + " B/s";

    private static string Minutes(double seconds) => (seconds / 60).ToString("0.0", CultureInfo.InvariantCulture) + " minutes";

    /// <summary>
    /// Bytes received and sent per second, averaged over the time since the previous sample, summed over the real adapters.
    /// The first sample after an agent start only sets the baseline and sends nothing.
    /// </summary>
    private List<CheckRun> ProbeNetwork(CheckDefinition c)
    {
        var sample = _probes.ReadNetwork();
        if (sample is null) return new() { Make(c, c.Key, c.Name, "OK", "Network traffic is not measured on this system.", null) };
        if (sample.Adapters.Count == 0)
        {
            _netRate.Reset();
            return new() { Make(c, c.Key, c.Name, "OK", sample.Reason ?? "No physical network adapter is up.", null) };
        }

        var now = System.Diagnostics.Stopwatch.GetTimestamp() / (double)System.Diagnostics.Stopwatch.Frequency;
        var rate = _netRate.Update(sample.Adapters.Select(a => (a.Name, a.RxBytes, a.TxBytes)), now, MaxRateGapSeconds(c));
        if (rate is not { } r) return new();

        var metrics = new Dictionary<string, object>
        {
            ["rxBytesPerSec"] = Math.Round(r.A),
            ["txBytesPerSec"] = Math.Round(r.B),
            ["intervalSec"] = Math.Round(r.Seconds),
            ["adapters"] = r.Counted,
        };
        var link = sample.Adapters.Where(a => a.LinkBitsPerSec > 0 && a.LinkBitsPerSec < 1_000_000_000_000).Sum(a => a.LinkBitsPerSec) / 1_000_000;
        if (link > 0) metrics["linkMbps"] = link;
        return new() { Make(c, c.Key, c.Name, "OK", $"Received {Rate(r.A)}, sent {Rate(r.B)} (average over {Minutes(r.Seconds)}).", metrics) };
    }

    /// <summary>Bytes read and written per second over the physical disks, averaged over the time since the previous sample.</summary>
    private List<CheckRun> ProbeDiskIo(CheckDefinition c)
    {
        var reading = _probes.ReadDiskIo();
        if (!string.IsNullOrEmpty(reading.Reason))
        {
            _diskRate.Reset();
            return new() { Make(c, c.Key, c.Name, "OK", reading.Reason!, null) };
        }

        double? read = reading.ReadBytesPerSec, write = reading.WriteBytesPerSec;
        var devices = 0;
        var seconds = 0.0;
        if (reading.Devices is { } list)
        {
            var now = System.Diagnostics.Stopwatch.GetTimestamp() / (double)System.Diagnostics.Stopwatch.Frequency;
            if (_diskRate.Update(list.Select(d => (d.Name, d.ReadBytes, d.WriteBytes)), now, MaxRateGapSeconds(c)) is not { } r) return new();
            read = r.A; write = r.B; devices = r.Counted; seconds = r.Seconds;
        }
        if (read is null || write is null) return new();

        var metrics = new Dictionary<string, object> { ["readBytesPerSec"] = Math.Round(read.Value), ["writeBytesPerSec"] = Math.Round(write.Value) };
        if (seconds > 0) metrics["intervalSec"] = Math.Round(seconds);
        if (devices > 0) metrics["devices"] = devices;
        return new() { Make(c, c.Key, c.Name, "OK", $"Read {Rate(read.Value)}, wrote {Rate(write.Value)}{(seconds > 0 ? $" (average over {Minutes(seconds)})" : "")}.", metrics) };
    }

    private CheckRun ProbeMemory(CheckDefinition c)
    {
        var warn = c.Warn ?? 90;
        var crit = c.Crit ?? 97;
        if (_probes.ReadMemory() is not { TotalBytes: > 0 } mem)
            return Make(c, c.Key, c.Name, "UNKNOWN", "Memory could not be read.", null);

        var used = Math.Round((mem.TotalBytes - mem.AvailableBytes) * 100.0 / mem.TotalBytes, 1);
        var availableGb = Math.Round(mem.AvailableBytes / 1073741824.0, 1);
        var totalGb = Math.Round(mem.TotalBytes / 1073741824.0, 1);
        return Make(c, c.Key, c.Name, CheckEvaluation.HigherIsWorse(used, warn, crit),
            $"{used}% in use; {availableGb} GB available of {totalGb} GB.",
            WithThresholds(new() { ["usedPercent"] = used, ["availableGb"] = availableGb, ["totalGb"] = totalGb }, warn, crit));
    }

    private async Task<CheckRun> ProbeCpuAsync(CheckDefinition c, CancellationToken ct)
    {
        var warn = c.Warn ?? 90;
        var crit = c.Crit ?? 98;

        // An average since the last run, so a brief spike between runs neither alerts nor goes unseen.
        var before = _lastCpu;
        var described = "since the last check";
        if (before is null)
        {
            before = _probes.ReadCpuTimes();
            described = "over 5 seconds";
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }

        var after = _probes.ReadCpuTimes();
        if (before is null || after is null) return Make(c, c.Key, c.Name, "UNKNOWN", "CPU usage could not be read.", null);
        _lastCpu = after;

        var busy = Math.Round(CheckEvaluation.CpuBusyPercent(before.Value, after.Value), 1);
        return Make(c, c.Key, c.Name, CheckEvaluation.HigherIsWorse(busy, warn, crit),
            $"Average {busy}% busy {described}.",
            WithThresholds(new() { ["busyPercent"] = busy }, warn, crit));
    }

    private CheckRun ProbeService(CheckDefinition c)
    {
        var down = c.DownStatus ?? "CRIT";

        if (c.Service == CheckEvaluation.FailedUnitsService)
        {
            var failed = _probes.ReadFailedServices();
            if (failed is null) return Make(c, c.Key, c.Name, "UNKNOWN", "This could not be read here.", null);
            return failed.Count == 0
                ? Make(c, c.Key, c.Name, "OK", "No failed units.", new() { ["failed"] = 0 })
                : Make(c, c.Key, c.Name, down, "Failed: " + string.Join(", ", failed.Take(20)), new() { ["failed"] = failed.Count });
        }

        if (!CheckEvaluation.IsSafeServiceName(c.Service))
            return Make(c, c.Key, c.Name, "UNKNOWN", "This check has no usable service name.", null);

        var state = _probes.ReadService(c.Service!);
        if (!state.Exists) return Make(c, c.Key, c.Name, "WARN", $"{c.Service} is not installed here.", null);
        return state.Running
            ? Make(c, c.Key, c.Name, "OK", $"{c.Service} is running.", null)
            : Make(c, c.Key, c.Name, down, $"{c.Service} is not running ({state.Detail}).", null);
    }

    private static CheckRun ProbeProcess(CheckDefinition c)
    {
        var name = (c.Process ?? "").Trim();
        if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name[..^4];
        if (name.Length == 0) return Make(c, c.Key, c.Name, "UNKNOWN", "This check has no process name.", null);

        var found = System.Diagnostics.Process.GetProcessesByName(name);
        var count = found.Length;
        foreach (var p in found) p.Dispose();
        return count > 0
            ? Make(c, c.Key, c.Name, "OK", $"{name} is running ({count}).", new() { ["count"] = count })
            : Make(c, c.Key, c.Name, c.DownStatus ?? "CRIT", $"{name} is not running.", new() { ["count"] = 0 });
    }

    private async Task<CheckRun> ProbePortAsync(CheckDefinition c, CancellationToken ct)
    {
        var host = c.Host;
        var port = c.Port;
        if (string.IsNullOrEmpty(host) && Uri.TryCreate(_o.ApiBaseUrl(), UriKind.Absolute, out var server))
        {
            host = server.DnsSafeHost;
            port = server.Port;
        }
        if (!CheckEvaluation.IsSafeHost(host) || port is not (> 0 and <= 65535))
            return Make(c, c.Key, c.Name, "UNKNOWN", "This check has no usable host and port.", null);

        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            using var tcp = new TcpClient();
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limit.CancelAfter(TimeSpan.FromSeconds(5));
            await tcp.ConnectAsync(host!, port.Value, limit.Token);
            var ms = sw.ElapsedMilliseconds;
            return Make(c, c.Key, c.Name, "OK", $"Connected to {host}:{port} in {ms} ms.", new() { ["connectMs"] = ms });
        }
        catch (Exception ex) when (ex is SocketException || (ex is OperationCanceledException && !ct.IsCancellationRequested))
        {
            return Make(c, c.Key, c.Name, c.DownStatus ?? "CRIT", $"Could not connect to {host}:{port}: {ex.Message}", null);
        }
    }

    private static async Task<CheckRun> ProbePingAsync(CheckDefinition c, CancellationToken ct)
    {
        if (!CheckEvaluation.IsSafeHost(c.Host)) return Make(c, c.Key, c.Name, "UNKNOWN", "This check has no usable host.", null);

        using var ping = new Ping();
        for (var i = 0; i < 3; i++)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var reply = await ping.SendPingAsync(c.Host!, 2000);
                if (reply.Status == IPStatus.Success)
                    return Make(c, c.Key, c.Name, "OK", $"{c.Host} answered in {reply.RoundtripTime} ms.", new() { ["rttMs"] = reply.RoundtripTime });
            }
            catch (PingException)
            {
                // Name lookup failures land here; the final result reports it as not answering.
            }
        }
        return Make(c, c.Key, c.Name, c.DownStatus ?? "CRIT", $"{c.Host} did not answer 3 pings.", null);
    }

    private CheckRun ProbeAgentUpdate(CheckDefinition c)
    {
        var last = AgentUpdater.ReadLastResult(_o.UpdateStateDir);
        if (last is { IsFailure: true } && AgentVersion.IsNewer(last.Version, _o.CurrentVersion))
        {
            return Make(c, c.Key, c.Name, last.Outcome == "failed" ? "WARN" : "CRIT",
                $"Running {_o.CurrentVersion}. The update to {last.Version} did not complete ({last.Outcome}) at {last.AtUtc}. {last.Detail}".TrimEnd(),
                new() { ["version"] = _o.CurrentVersion, ["failedVersion"] = last.Version });
        }
        return Make(c, c.Key, c.Name, "OK", $"Running {_o.CurrentVersion}.", new() { ["version"] = _o.CurrentVersion });
    }

    private static CheckRun Make(CheckDefinition c, string key, string name, string status, string output, Dictionary<string, object>? metrics) => new()
    {
        DedupeKey = key,
        CheckType = c.Type.ToUpperInvariant(),
        CheckName = name,
        Status = status,
        Severity = CheckEvaluation.SeverityFor(status),
        Metrics = metrics,
        Output = output,
    };
}
