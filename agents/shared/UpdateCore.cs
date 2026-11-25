using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RemoteIQ.Agent.Shared;

public sealed class UpdateManifest
{
    public string Version { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public string Url { get; set; } = "";
    public string Signature { get; set; } = "";

    // Only used to check free disk space, so it does not need to be signed.
    public long SizeBytes { get; set; }
}

public static class UpdateManifestVerifier
{
    public static string DownloadPath(string os) => $"/api/agent/updates/download/{os}";

    // The prefix keeps a manifest signature from ever being valid for anything else the key signs.
    public static string Canonical(string version, string sha256, string url) =>
        $"remoteiq-update-v1|{version}|{sha256}|{url}";

    /// <summary>
    /// Only a manifest for this OS, signed by the pinned key, and newer than what is running passes.
    /// The URL must be the fixed relative path, so the agent token is never sent to another host.
    /// </summary>
    public static bool Verify(UpdateManifest? m, string? publicKeyPem, string os, string currentVersion, out string reason)
    {
        if (m is null) { reason = "The manifest is empty."; return false; }
        if (string.IsNullOrWhiteSpace(publicKeyPem)) { reason = "This agent has no signing key."; return false; }
        if (string.IsNullOrEmpty(m.Signature)) { reason = "The manifest is not signed."; return false; }
        if (!Regex.IsMatch(m.Sha256 ?? "", "^[0-9a-f]{64}$")) { reason = "The manifest has a malformed hash."; return false; }
        if (!AgentVersion.TryParse(m.Version, out _)) { reason = "The manifest has a malformed version."; return false; }
        if (m.Url != DownloadPath(os)) { reason = "The manifest points at an unexpected URL."; return false; }

        try
        {
            using var rsa = RSA.Create();
            rsa.ImportFromPem(publicKeyPem);
            var data = Encoding.UTF8.GetBytes(Canonical(m.Version, m.Sha256!, m.Url));
            if (!rsa.VerifyData(data, Convert.FromBase64String(m.Signature), HashAlgorithmName.SHA256, RSASignaturePadding.Pss))
            {
                reason = "The manifest signature is invalid.";
                return false;
            }
        }
        catch (Exception ex)
        {
            reason = "The manifest signature could not be checked: " + ex.Message;
            return false;
        }

        if (!AgentVersion.IsNewer(m.Version, currentVersion))
        {
            reason = $"Version {m.Version} is not newer than {currentVersion}.";
            return false;
        }

        reason = "";
        return true;
    }
}

public sealed class UpdateAttempts
{
    public string TargetVersion { get; set; } = "";
    public int Attempts { get; set; }
    public DateTimeOffset LastAttemptUtc { get; set; }
}

public sealed class UpdateResult
{
    public string Version { get; set; } = "";
    public string Outcome { get; set; } = "";
    public string Detail { get; set; } = "";
    public string AtUtc { get; set; } = "";

    public bool IsFailure => Outcome is "rolled_back" or "rollback_failed" or "failed";
}

/// <summary>Decides whether another try is allowed. Kept in a file so a crash loop cannot reset it.</summary>
public static class UpdatePolicy
{
    public const int MaxAttempts = 3;

    // Applies across versions too, so a server flipping between versions cannot cause a loop.
    public static readonly TimeSpan MinimumGap = TimeSpan.FromMinutes(30);

    public static TimeSpan BackoffAfter(int attempts) => attempts switch
    {
        <= 0 => TimeSpan.Zero,
        1 => TimeSpan.FromHours(1),
        _ => TimeSpan.FromHours(6),
    };

    public static bool CanAttempt(UpdateAttempts? state, string target, DateTimeOffset now, out string reason)
    {
        reason = "";
        if (state is null || string.IsNullOrEmpty(state.TargetVersion)) return true;

        if (now - state.LastAttemptUtc < MinimumGap)
        {
            reason = "An update was tried moments ago.";
            return false;
        }
        if (!AgentVersion.AreEqual(state.TargetVersion, target)) return true;

        if (state.Attempts >= MaxAttempts)
        {
            reason = $"Version {target} failed {state.Attempts} times; waiting for a newer release.";
            return false;
        }
        if (now - state.LastAttemptUtc < BackoffAfter(state.Attempts))
        {
            reason = $"Version {target} failed recently; waiting before trying again.";
            return false;
        }
        return true;
    }

    public static UpdateAttempts Record(UpdateAttempts? state, string target, DateTimeOffset now) => new()
    {
        TargetVersion = target,
        Attempts = state is not null && AgentVersion.AreEqual(state.TargetVersion, target) ? state.Attempts + 1 : 1,
        LastAttemptUtc = now,
    };
}

/// <summary>The parts of an update that differ between Windows and Linux.</summary>
public interface IUpdatePlatform
{
    string Os { get; }
    string Arch { get; }
    string InstallDir { get; }

    /// <summary>A folder only the system account can write to. It holds the apply script.</summary>
    string StateDir { get; }

    string ExecutableName { get; }
    bool CanSelfUpdate(out string reason);
    Task ExtractAsync(string packagePath, string targetDir, CancellationToken ct);

    /// <summary>Starts the apply script so it outlives this service, and returns.</summary>
    void LaunchApply(string targetVersion);
}

public sealed class AgentUpdaterOptions
{
    public required string CurrentVersion { get; init; }
    public required Func<string> ApiBaseUrl { get; init; }
    public required Func<string> Token { get; init; }
    public required Func<string> PublicKeyPem { get; init; }
    public required Func<HttpClient> Http { get; init; }
    public required Func<TimeSpan> Interval { get; init; }
    public required Action<string> Log { get; init; }
}

public enum UpdateCheckOutcome { NotEnrolled, Unavailable, UpToDate, Rejected, Deferred, NotSupported, Failed, Launched }

public sealed class AgentUpdater
{
    private const long MaxPackageBytes = 1024L * 1024 * 1024;
    private static readonly JsonSerializerOptions JsonIn = new() { PropertyNameCaseInsensitive = true };

    private readonly IUpdatePlatform _platform;
    private readonly AgentUpdaterOptions _o;
    private string _lastDeferral = "";

    // One updater per process, and the job handler that asks for a check has no reference to it.
    private static readonly SemaphoreSlim CheckRequested = new(0, 1);
    private static int _manualCheck;

    /// <summary>
    /// A technician asked for this from the console. It checks now and ignores the waiting periods
    /// after a failed attempt. Signature and hash checks, and rollback, still apply.
    /// </summary>
    public static void RequestCheckNow()
    {
        Interlocked.Exchange(ref _manualCheck, 1);
        try { CheckRequested.Release(); }
        catch (SemaphoreFullException) { /* a check is already waiting to run */ }
    }

    private static async Task WaitForNextCheckAsync(TimeSpan delay, CancellationToken ct)
    {
        await CheckRequested.WaitAsync(delay, ct);
    }

    public AgentUpdater(IUpdatePlatform platform, AgentUpdaterOptions options)
    {
        _platform = platform;
        _o = options;
    }

    private string StatePath => Path.Combine(_platform.StateDir, "attempts.json");
    private string PendingPath => Path.Combine(_platform.StateDir, "pending.txt");
    private string OkPath => Path.Combine(_platform.StateDir, "ok.txt");
    private string StartedPath => Path.Combine(_platform.StateDir, "apply.started");
    private string StagingDir => _platform.InstallDir + ".update";
    private string PreviousDir => _platform.InstallDir + ".prev";
    private string FailedDir => _platform.InstallDir + ".failed";

    /// <summary>
    /// Spreads a fleet out: the base interval is stretched by up to half again, so agents that
    /// started together drift apart instead of checking in step.
    /// </summary>
    public static TimeSpan JitteredInterval(TimeSpan baseInterval, double random) =>
        TimeSpan.FromSeconds(Math.Max(baseInterval.TotalSeconds, 60) * (1 + 0.5 * random));

    public async Task RunAsync(CancellationToken ct)
    {
        await ConfirmPendingAsync(ct);

        // The first check lands anywhere in the first interval, so a server restart or a fleet
        // rebooting together does not bring every agent back at once.
        var first = Math.Max(_o.Interval().TotalSeconds, 60) * Random.Shared.NextDouble();
        await WaitForNextCheckAsync(TimeSpan.FromSeconds(Math.Max(first, 30)), ct);

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var manual = Interlocked.Exchange(ref _manualCheck, 0) == 1;
                var outcome = await CheckOnceAsync(ct, manual);
                if (manual) _o.Log($"Update check requested from the console finished: {outcome}.");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _o.Log($"Update check failed: {ex.Message}");
            }

            await WaitForNextCheckAsync(JitteredInterval(_o.Interval(), Random.Shared.NextDouble()), ct);
        }
    }

    /// <summary>
    /// Run once at startup. If this process is the version being applied, proving it can reach the
    /// server with its token is what tells the apply script that it may keep this version.
    /// </summary>
    public async Task ConfirmPendingAsync(CancellationToken ct)
    {
        string pending;
        try
        {
            if (!File.Exists(PendingPath)) return;
            pending = File.ReadAllText(PendingPath).Trim();
        }
        catch (Exception ex)
        {
            _o.Log($"Could not read the pending update: {ex.Message}");
            return;
        }

        if (!AgentVersion.AreEqual(pending, _o.CurrentVersion))
        {
            // The previous version is running again, so the apply script has already rolled back.
            TryDelete(PendingPath);
            return;
        }

        var deadline = DateTimeOffset.UtcNow.AddMinutes(10);
        while (!ct.IsCancellationRequested && DateTimeOffset.UtcNow < deadline)
        {
            try
            {
                using var resp = await SendCheckAsync(ct);
                if (resp.IsSuccessStatusCode)
                {
                    AtomicWrite(OkPath, _o.CurrentVersion);
                    TryDelete(PendingPath);
                    _o.Log($"Update to {_o.CurrentVersion} confirmed.");
                    return;
                }
                _o.Log($"Update confirmation got status {(int)resp.StatusCode}; retrying.");
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                _o.Log($"Update confirmation failed; retrying: {ex.Message}");
            }

            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    private Task<HttpResponseMessage> SendCheckAsync(CancellationToken ct)
    {
        var url = $"{_o.ApiBaseUrl().TrimEnd('/')}/api/agent/updates/check" +
                  $"?os={_platform.Os}&arch={_platform.Arch}&version={Uri.EscapeDataString(_o.CurrentVersion)}" +
                  FailureQuery(ReadLastResult(_platform.StateDir), _o.CurrentVersion);
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _o.Token());
        return _o.Http().SendAsync(req, ct);
    }

    public async Task<UpdateCheckOutcome> CheckOnceAsync(CancellationToken ct, bool manual = false)
    {
        if (string.IsNullOrEmpty(_o.Token())) return UpdateCheckOutcome.NotEnrolled;

        using var resp = await SendCheckAsync(ct);
        if (resp.StatusCode == HttpStatusCode.NoContent) return UpdateCheckOutcome.UpToDate;
        if (!resp.IsSuccessStatusCode)
        {
            _o.Log($"Update check got status {(int)resp.StatusCode}.");
            return UpdateCheckOutcome.Unavailable;
        }

        var manifest = await resp.Content.ReadFromJsonAsync<UpdateManifest>(JsonIn, ct);
        if (!UpdateManifestVerifier.Verify(manifest, _o.PublicKeyPem(), _platform.Os, _o.CurrentVersion, out var reason))
        {
            _o.Log($"Ignoring an update offer: {reason}");
            return UpdateCheckOutcome.Rejected;
        }

        if (!_platform.CanSelfUpdate(out reason))
        {
            LogOnce($"Version {manifest!.Version} is available, but this agent cannot update itself: {reason}");
            return UpdateCheckOutcome.NotSupported;
        }

        if (IsApplyInFlight())
        {
            LogOnce("An update is already being applied.");
            return UpdateCheckOutcome.Deferred;
        }

        var state = ReadAttempts();
        if (!manual && !UpdatePolicy.CanAttempt(state, manifest!.Version, DateTimeOffset.UtcNow, out reason))
        {
            LogOnce($"Not updating now: {reason}");
            return UpdateCheckOutcome.Deferred;
        }

        return await ApplyAsync(manifest!, state, ct);
    }

    private async Task<UpdateCheckOutcome> ApplyAsync(UpdateManifest m, UpdateAttempts? state, CancellationToken ct)
    {
        _o.Log($"Downloading agent update {m.Version}.");
        Directory.CreateDirectory(_platform.StateDir);
        RemoveLeftovers();
        Directory.CreateDirectory(StagingDir);

        if (!HasRoomFor(m.SizeBytes))
        {
            // Not counted as an attempt: this clears up by itself and says nothing about the release.
            _o.Log("Not updating now: not enough free disk space.");
            RemoveLeftovers();
            return UpdateCheckOutcome.Deferred;
        }

        var package = Path.Combine(StagingDir, "package.bin");
        try
        {
            // A network error is not the release's fault, so it only waits for the next check.
            await DownloadAsync(m, package, ct);
        }
        catch (Exception ex) when ((ex is HttpRequestException or IOException or TaskCanceledException) && !ct.IsCancellationRequested)
        {
            _o.Log($"Could not download the update: {ex.Message}");
            RemoveLeftovers();
            return UpdateCheckOutcome.Failed;
        }

        // From here on a failure is a fault in the release, so it counts against this version.
        WriteAttempts(UpdatePolicy.Record(state, m.Version, DateTimeOffset.UtcNow));

        try
        {
            var actual = await HashFileAsync(package, ct);
            if (!string.Equals(actual, m.Sha256, StringComparison.Ordinal))
                throw new InvalidDataException($"Hash mismatch: expected {m.Sha256}, got {actual}.");

            var newDir = Path.Combine(StagingDir, "new");
            Directory.CreateDirectory(newDir);
            await _platform.ExtractAsync(package, newDir, ct);
            TryDelete(package);

            var exe = Path.Combine(newDir, _platform.ExecutableName);
            if (!File.Exists(exe)) throw new InvalidDataException($"The package has no {_platform.ExecutableName}.");

            // Running the new build before anything is stopped catches a package that cannot start
            // here, or one that is not the version it claims, which would otherwise repeat forever.
            var reported = await ReportedVersionAsync(exe, ct);
            if (!AgentVersion.AreEqual(reported, m.Version))
                throw new InvalidDataException($"The package reports version '{reported}', not {m.Version}.");

            TryDelete(OkPath);
            TryDelete(StartedPath);
            AtomicWrite(PendingPath, m.Version);

            _o.Log($"Applying agent update {m.Version}.");
            _platform.LaunchApply(m.Version);
            return UpdateCheckOutcome.Launched;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            _o.Log($"Update {m.Version} failed before anything was changed: {ex.Message}");
            WriteResult(new UpdateResult
            {
                Version = m.Version,
                Outcome = "failed",
                Detail = "The package failed verification.",
                AtUtc = DateTimeOffset.UtcNow.ToString("o"),
            });
            TryDelete(PendingPath);
            RemoveLeftovers();
            return UpdateCheckOutcome.Failed;
        }
    }

    private async Task DownloadAsync(UpdateManifest m, string target, CancellationToken ct)
    {
        using var overall = CancellationTokenSource.CreateLinkedTokenSource(ct);
        overall.CancelAfter(TimeSpan.FromMinutes(30));

        using var req = new HttpRequestMessage(HttpMethod.Get, _o.ApiBaseUrl().TrimEnd('/') + m.Url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _o.Token());

        // Reading headers only means the client's short timeout does not cover the body.
        using var resp = await _o.Http().SendAsync(req, HttpCompletionOption.ResponseHeadersRead, overall.Token);
        if (!resp.IsSuccessStatusCode) throw new HttpRequestException($"The server returned {(int)resp.StatusCode}.");

        await using var source = await resp.Content.ReadAsStreamAsync(overall.Token);
        await using var file = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None);

        var buffer = new byte[81920];
        long total = 0;
        int n;
        while ((n = await source.ReadAsync(buffer, overall.Token)) > 0)
        {
            total += n;
            if (total > MaxPackageBytes) throw new IOException("The package is larger than any agent should be.");
            await file.WriteAsync(buffer.AsMemory(0, n), overall.Token);
        }
    }

    private static async Task<string> HashFileAsync(string path, CancellationToken ct)
    {
        await using var f = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(f, ct)).ToLowerInvariant();
    }

    private static async Task<string> ReportedVersionAsync(string exe, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(exe)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(exe)!,
        };
        psi.ArgumentList.Add("--version");

        using var p = Process.Start(psi) ?? throw new InvalidOperationException("The new agent did not start.");
        var stdout = p.StandardOutput.ReadToEndAsync(ct);
        var stderr = p.StandardError.ReadToEndAsync(ct);

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(90));
        try
        {
            await p.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            try { p.Kill(entireProcessTree: true); } catch { /* already gone */ }
            throw new InvalidDataException("The new agent did not answer --version in time.");
        }

        await stderr;
        return p.ExitCode == 0 ? (await stdout).Trim() : "";
    }

    private bool HasRoomFor(long sizeBytes)
    {
        try
        {
            // Room for the package and for what it unpacks to, with some to spare.
            var root = Path.GetPathRoot(_platform.InstallDir);
            if (string.IsNullOrEmpty(root)) return true;
            var need = Math.Max(sizeBytes, 200L * 1024 * 1024) * 4;
            return new DriveInfo(root).AvailableFreeSpace > need;
        }
        catch
        {
            return true;
        }
    }

    private bool IsApplyInFlight()
    {
        try
        {
            return File.Exists(StartedPath) &&
                   DateTime.UtcNow - File.GetLastWriteTimeUtc(StartedPath) < TimeSpan.FromMinutes(30);
        }
        catch
        {
            return false;
        }
    }

    private void RemoveLeftovers()
    {
        foreach (var dir in new[] { StagingDir, PreviousDir, FailedDir })
        {
            try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
            catch (Exception ex) { _o.Log($"Could not remove {dir}: {ex.Message}"); }
        }
    }

    private UpdateAttempts? ReadAttempts()
    {
        try
        {
            return File.Exists(StatePath)
                ? JsonSerializer.Deserialize<UpdateAttempts>(File.ReadAllText(StatePath), JsonIn)
                : null;
        }
        catch
        {
            return null;
        }
    }

    private void WriteAttempts(UpdateAttempts state) => AtomicWrite(StatePath, JsonSerializer.Serialize(state));

    private void WriteResult(UpdateResult result) =>
        AtomicWrite(Path.Combine(_platform.StateDir, "result.json"), JsonSerializer.Serialize(result));

    /// <summary>
    /// What is added to the update check when the last update did not finish, so the server can say why (the console only knows the agent accepted it).
    /// Nothing is added when the last update worked, or when this agent already runs that version or newer.
    /// </summary>
    public static string FailureQuery(UpdateResult? last, string currentVersion)
    {
        if (last is not { IsFailure: true } || !AgentVersion.IsNewer(last.Version, currentVersion)) return "";
        var detail = Regex.Replace(last.Detail ?? "", @"\s+", " ").Trim();
        if (detail.Length > 300) detail = detail[..300];
        return $"&failedVersion={Uri.EscapeDataString(last.Version)}&failedOutcome={Uri.EscapeDataString(last.Outcome)}&failedDetail={Uri.EscapeDataString(detail)}";
    }

    /// <summary>The outcome of the last update, written by the apply script or by this agent.</summary>
    public static UpdateResult? ReadLastResult(string stateDir)
    {
        try
        {
            var path = Path.Combine(stateDir, "result.json");
            return File.Exists(path) ? JsonSerializer.Deserialize<UpdateResult>(File.ReadAllText(path), JsonIn) : null;
        }
        catch
        {
            return null;
        }
    }

    private void LogOnce(string message)
    {
        if (message == _lastDeferral) return;
        _lastDeferral = message;
        _o.Log(message);
    }

    private static void AtomicWrite(string path, string text)
    {
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, text, new UTF8Encoding(false));
        File.Move(tmp, path, overwrite: true);
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch { /* best effort */ }
    }
}
