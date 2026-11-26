// ADG RMM Linux agent: enrolls, reports facts and software, and runs jobs sent by the server.
// It speaks the same protocol as the Windows agent. Remote console and Remote Desktop are Windows-only.

using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Collections.Concurrent;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

const string ConfigDir = "/etc/adgrmm";
var configPath = Path.Combine(ConfigDir, "agent.json");
var enrollmentPath = Path.Combine(ConfigDir, "enrollment.json");

var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.0.0";

// The updater runs a new build this way before stopping anything, to prove it can start here.
if (args.Contains("--version")) { Console.WriteLine(version); return; }

// Support check: lists the updates this machine's package manager offers, as the server would see them. Changes nothing.
if (args.Contains("--patch-scan"))
{
    try
    {
        var scan = await new AdgRmm.Agent.Shared.LinuxPatchEngine(new AdgRmm.Agent.Linux.LinuxPatchHost()).ScanAsync(args.Contains("--include-optional"), CancellationToken.None);
        Console.WriteLine(AdgRmm.Agent.Shared.LinuxPatchReport.ScanStdout(scan));
        Console.WriteLine(JsonSerializer.Serialize(AdgRmm.Agent.Shared.LinuxPatchReport.ScanArtifacts(scan), new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
        return;
    }
    catch (AdgRmm.Agent.Shared.LinuxPatchException ex)
    {
        Console.Error.WriteLine(ex.Message);
        Environment.Exit(1);
    }
}

// Support check: prints the facts this agent would report about the machine (operating system, firewall, encryption and so on). Changes nothing.
if (args.Contains("--facts"))
{
    var shown = new Dictionary<string, object?>(AdgRmm.Agent.Linux.LinuxDeviceFacts.Collect())
    {
        ["lastBootAt"] = AdgRmm.Agent.Linux.LinuxDeviceFacts.ReadLastBoot(),
        ["hardwareExtras"] = AdgRmm.Agent.Linux.LinuxDeviceFacts.ReadHardwareExtras(),
    };
    Console.WriteLine(JsonSerializer.Serialize(shown, new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
    return;
}

var arch = RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "arm64" : "x64";
var heartbeat = TimeSpan.FromSeconds(30);
var inventoryEvery = TimeSpan.FromMinutes(30);

var jsonOut = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
};
var jsonIn = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
var seenJobs = new ConcurrentDictionary<string, DateTimeOffset>();
var sessionStarts = new AdgRmm.Agent.Shared.SessionStartVerifier();

using var stopping = new CancellationTokenSource();
using var onTerm = PosixSignalRegistration.Create(PosixSignal.SIGTERM, ctx => { ctx.Cancel = true; stopping.Cancel(); });
using var onInt = PosixSignalRegistration.Create(PosixSignal.SIGINT, ctx => { ctx.Cancel = true; stopping.Cancel(); });
var stop = stopping.Token;

using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };

try
{
    var cfg = LoadConfig();
    await EnrollIfNeeded(cfg);
    if (stop.IsCancellationRequested) return;

    AdgRmm.Agent.Linux.LinuxBackground.Start(cfg, version, arch, http, Log, stop);
    await Task.WhenAll(HeartbeatLoop(cfg), InventoryLoop(cfg), JobLoop(cfg), ShellLoop(cfg));
}
catch (OperationCanceledException) when (stop.IsCancellationRequested)
{
    // normal shutdown
}

Log("Stopped.");

void Log(string message) => Console.WriteLine($"[{DateTime.UtcNow:O}] {message}");

async Task Pause(TimeSpan delay)
{
    try { await Task.Delay(delay, stop); }
    catch (OperationCanceledException) { }
}

// ─── Config ─────────────────────────────────────────────────────────────────

AgentConfig LoadConfig()
{
    Directory.CreateDirectory(ConfigDir);

    var cfg = new AgentConfig();
    if (File.Exists(configPath))
    {
        try { cfg = JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(configPath), jsonIn) ?? cfg; }
        catch (Exception ex) { Log($"agent.json is unreadable, starting fresh: {ex.Message}"); }
    }

    // Written by the installer, applied once, then deleted because it holds the key in clear text.
    if (File.Exists(enrollmentPath))
    {
        try
        {
            var file = JsonSerializer.Deserialize<EnrollmentFile>(File.ReadAllText(enrollmentPath), jsonIn);
            if (string.IsNullOrWhiteSpace(file?.BaseUrl) || string.IsNullOrWhiteSpace(file.DeviceId) || string.IsNullOrWhiteSpace(file.EnrollmentKey))
            {
                Log("enrollment.json is missing baseUrl, deviceId or enrollmentKey; ignoring it.");
            }
            else
            {
                cfg.ApiBaseUrl = file.BaseUrl.Trim().TrimEnd('/');
                cfg.DeviceId = file.DeviceId.Trim();
                cfg.EnrollmentKey = file.EnrollmentKey.Trim();

                // Running the installer means enroll again, so the old token is dropped.
                cfg.AgentId = "";
                cfg.AgentKey = "";

                SaveConfig(cfg);
                File.Delete(enrollmentPath);
                Log("Applied enrollment settings from the installer.");
            }
        }
        catch (Exception ex)
        {
            Log($"Failed to apply enrollment.json: {ex.Message}");
        }
    }

    return cfg;
}

void SaveConfig(AgentConfig cfg)
{
    var tmp = configPath + ".tmp";

    // The file holds the agent's token, so it is created private before anything is written.
    using (var f = new FileStream(tmp, new FileStreamOptions
    {
        Mode = FileMode.Create,
        Access = FileAccess.Write,
        UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
    }))
    using (var w = new StreamWriter(f, new UTF8Encoding(false)))
    {
        w.Write(JsonSerializer.Serialize(cfg, new JsonSerializerOptions { WriteIndented = true }));
    }

    File.Move(tmp, configPath, overwrite: true);
}

// ─── Enrollment ─────────────────────────────────────────────────────────────

async Task EnrollIfNeeded(AgentConfig cfg)
{
    var retrySeconds = 15;

    while (!stop.IsCancellationRequested)
    {
        if (!string.IsNullOrEmpty(cfg.AgentId) && !string.IsNullOrEmpty(cfg.AgentKey)) return;

        if (string.IsNullOrWhiteSpace(cfg.ApiBaseUrl) || string.IsNullOrWhiteSpace(cfg.DeviceId) || string.IsNullOrWhiteSpace(cfg.EnrollmentKey))
        {
            Log("Not enrolled and no enrollment settings found. Run the installer again.");
            await Pause(TimeSpan.FromMinutes(2));
            continue;
        }

        try
        {
            var resp = await http.PostAsJsonAsync($"{cfg.ApiBaseUrl}/api/agent/enroll", new
            {
                enrollmentKey = cfg.EnrollmentKey,
                deviceId = cfg.DeviceId,
                hostname = Environment.MachineName,
                os = "linux",
                arch,
                version,
            }, stop);

            if (!resp.IsSuccessStatusCode)
            {
                var detail = await resp.Content.ReadAsStringAsync(stop);
                throw new HttpRequestException($"Server returned {(int)resp.StatusCode}: {Shorten(detail, 500)}");
            }

            var enrolled = await resp.Content.ReadFromJsonAsync<EnrollmentResponse>(jsonIn, stop);
            if (string.IsNullOrWhiteSpace(enrolled?.AgentId) || string.IsNullOrWhiteSpace(enrolled.AgentToken))
                throw new InvalidOperationException("Enrollment response is missing agentId or agentToken.");

            cfg.AgentId = enrolled.AgentId;
            cfg.AgentKey = enrolled.AgentToken;
            if (!string.IsNullOrWhiteSpace(enrolled.JobSigningPublicKey)) cfg.JobSigningPublicKey = enrolled.JobSigningPublicKey;
            if (!string.IsNullOrWhiteSpace(enrolled.DeviceId)) cfg.DeviceId = enrolled.DeviceId;
            cfg.EnrollmentKey = "";
            SaveConfig(cfg);

            Log($"Enrollment successful: {cfg.AgentId}");
            return;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !stop.IsCancellationRequested)
        {
            Log($"Enrollment failed; retrying in {retrySeconds}s: {ex.Message}");
            await Pause(TimeSpan.FromSeconds(retrySeconds));
            retrySeconds = Math.Min(retrySeconds * 2, 300);
        }
    }
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────

async Task HeartbeatLoop(AgentConfig cfg)
{
    Dictionary<string, object?>? facts = null;
    var factsAt = DateTime.MinValue;
    var lastError = "";

    while (!stop.IsCancellationRequested)
    {
        try
        {
            if (facts is null || DateTime.UtcNow - factsAt > TimeSpan.FromHours(1))
            {
                facts = CollectFacts();
                factsAt = DateTime.UtcNow;
            }

            // Cheap to read, and it must be current: it clears the moment the machine restarts.
            var (rebootPending, rebootWhy) = AdgRmm.Agent.Linux.LinuxPendingReboot.Read("/etc/adgrmm/update");
            facts["boot"] = new { lastBootAt = AdgRmm.Agent.Linux.LinuxDeviceFacts.ReadLastBoot(), pendingReboot = rebootPending, pendingRebootReasons = rebootWhy is null ? Array.Empty<string>() : new[] { rebootWhy } };

            using var req = new HttpRequestMessage(HttpMethod.Post, $"{cfg.ApiBaseUrl}/api/agent/ping");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.AgentKey);
            req.Content = JsonContent.Create(new
            {
                hostname = Environment.MachineName,
                os = "linux",
                arch,
                version,
                primaryIp = PrimaryIp(),
                user = LoggedInUser(),
                facts,
            }, options: jsonOut);

            using var resp = await http.SendAsync(req, stop);
            resp.EnsureSuccessStatusCode();
            lastError = "";
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !stop.IsCancellationRequested)
        {
            if (ex.Message != lastError) Log($"Heartbeat failed: {ex.Message}");
            lastError = ex.Message;
        }

        await Pause(heartbeat);
    }
}

string? PrimaryIp()
{
    try
    {
        foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            foreach (var ua in ni.GetIPProperties().UnicastAddresses)
            {
                if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                var ip = ua.Address.ToString();
                if (!ip.StartsWith("169.254.")) return ip;
            }
        }
    }
    catch { /* report no address */ }
    return null;
}

string LoggedInUser()
{
    var (code, stdout, _) = Run("who", Array.Empty<string>());
    if (code != 0) return "";
    return stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Split(' ', 2)[0] ?? "";
}

Dictionary<string, object?> CollectFacts()
{
    long? ramBytes = null;
    string? cpu = null;

    try
    {
        var kb = File.ReadLines("/proc/meminfo").FirstOrDefault(l => l.StartsWith("MemTotal:"))
            ?.Split(' ', StringSplitOptions.RemoveEmptyEntries)[1];
        if (long.TryParse(kb, out var parsed)) ramBytes = parsed * 1024;
    }
    catch { /* optional */ }

    try
    {
        cpu = File.ReadLines("/proc/cpuinfo").FirstOrDefault(l => l.StartsWith("model name"))?.Split(':', 2)[1].Trim();
    }
    catch { /* optional */ }

    var (serial, gpu) = AdgRmm.Agent.Linux.LinuxDeviceFacts.ReadHardwareExtras();
    var facts = new Dictionary<string, object?>
    {
        // which build runs (glibc or musl) and what starts services (systemd or OpenRC): support needs to know
        ["libc"] = AdgRmm.Agent.Linux.LinuxInit.Libc,
        ["init"] = AdgRmm.Agent.Linux.LinuxInit.Init,
        ["hardware"] = new
        {
            model = AdgRmm.Agent.Linux.LinuxDeviceFacts.ReadModel() ?? ReadFirstLine("/sys/class/dmi/id/product_name"),
            cpu = AdgRmm.Agent.Linux.LinuxDeviceFacts.ReadCpu() ?? cpu,
            ramBytes,
            ram = ramBytes is { } r ? $"{r / (1024.0 * 1024 * 1024):0.#} GB" : null,
            gpu,
            serial,
        },
        ["disks"] = CollectDisks(),
    };

    // Operating system, firmware, network, firewall, disk encryption, TPM, Secure Boot and antivirus, in the shape the Windows agent sends.
    foreach (var kv in AdgRmm.Agent.Linux.LinuxDeviceFacts.Collect()) facts[kv.Key] = kv.Value;
    return facts;
}

string? ReadFirstLine(string path)
{
    try { return File.ReadLines(path).FirstOrDefault()?.Trim(); }
    catch { return null; }
}

List<object> CollectDisks()
{
    var pseudo = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "tmpfs", "devtmpfs", "overlay", "squashfs", "proc", "sysfs", "cgroup", "cgroup2", "devpts", "autofs", "nsfs", "tracefs", "efivarfs",
    };
    var disks = new List<object>();

    foreach (var d in DriveInfo.GetDrives())
    {
        try
        {
            if (!d.IsReady || pseudo.Contains(d.DriveFormat) || d.TotalSize <= 0) continue;
            var used = d.TotalSize - d.TotalFreeSpace;
            disks.Add(new
            {
                mount = d.Name,
                fs = d.DriveFormat,
                totalBytes = d.TotalSize,
                freeBytes = d.AvailableFreeSpace,
                usedBytes = used,
                usedPercent = Math.Round(used * 100.0 / d.TotalSize, 1),
            });
        }
        catch { /* skip unreadable mounts */ }
    }

    return disks;
}

// ─── Software inventory ─────────────────────────────────────────────────────

async Task InventoryLoop(AgentConfig cfg)
{
    while (!stop.IsCancellationRequested)
    {
        try
        {
            var items = CollectSoftware();
            if (items.Count > 0)
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, $"{cfg.ApiBaseUrl}/api/agent/software");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.AgentKey);
                req.Content = JsonContent.Create(new { items }, options: jsonOut);

                using var resp = await http.SendAsync(req, stop);
                resp.EnsureSuccessStatusCode();
                Log($"Software inventory sent: {items.Count}");
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !stop.IsCancellationRequested)
        {
            Log($"Software inventory failed: {ex.Message}");
        }

        await Pause(inventoryEvery);
    }
}

List<SoftwareItem> CollectSoftware()
{
    var (code, stdout, _) = Run("dpkg-query", new[] { "-W", "-f=${Package}\t${Version}\t${Maintainer}\n" });
    if (code != 0) (code, stdout, _) = Run("rpm", new[] { "-qa", "--qf", "%{NAME}\t%{VERSION}\t%{VENDOR}\n" });
    if (code != 0)
    {
        // Alpine: "apk list --installed" prints "name-1.2.3-r0 x86_64 {origin} (licence) [installed]". The name is everything before
        // the last two dash-separated parts (the version and the release).
        var (apkCode, apkOut, _) = Run("apk", new[] { "list", "--installed" });
        if (apkCode == 0) return AdgRmm.Agent.Linux.LinuxDeviceFacts.ParseApkList(apkOut).Select(a => new SoftwareItem(Clip(a.Name, 256)!, Clip(a.Version, 128), null)).ToList();
        // Arch: "pacman -Q" prints "name version".
        var (pacCode, pacOut, _) = Run("pacman", new[] { "-Q" });
        if (pacCode == 0)
        {
            return pacOut.Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .Select(l => l.Split(' ', 2))
                .Where(p => p.Length == 2 && p[0].Length > 0)
                .Select(p => new SoftwareItem(Clip(p[0], 256)!, Clip(p[1].Trim(), 128), null)).ToList();
        }
        return new();
    }

    var items = new List<SoftwareItem>();
    foreach (var line in stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries))
    {
        var p = line.Split('\t');
        if (p.Length == 0 || string.IsNullOrWhiteSpace(p[0])) continue;
        items.Add(new SoftwareItem(Clip(p[0], 256)!, p.Length > 1 ? Clip(p[1], 128) : null, p.Length > 2 ? Clip(p[2], 256) : null));
    }
    return items;
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

async Task JobLoop(AgentConfig cfg)
{
    var wsBase = WsBase(cfg);

    while (!stop.IsCancellationRequested)
    {
        using var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Authorization", $"Bearer {cfg.AgentKey}");

        try
        {
            await ws.ConnectAsync(new Uri($"{wsBase}/ws/agent"), stop);
            Log("Connected to the server for jobs.");

            await SendJson(ws, new
            {
                t = "agent_hello",
                agentId = cfg.AgentId,
                deviceId = cfg.DeviceId,
                hostname = Environment.MachineName,
                os = "linux",
                arch,
                version,
            });

            await ReceiveJobs(ws, cfg);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !stop.IsCancellationRequested)
        {
            Log($"Job connection lost; reconnecting in 5s: {ex.Message}");
        }

        await Pause(TimeSpan.FromSeconds(5));
    }
}

async Task ReceiveJobs(ClientWebSocket ws, AgentConfig cfg)
{
    var buffer = new byte[64 * 1024];
    var sendLock = new SemaphoreSlim(1, 1);
    async Task SendResult(string jobId, JobResult result)
    {
        await sendLock.WaitAsync(stop);
        try
        {
            await SendJson(ws, new
            {
                t = "job_result",
                jobId,
                exitCode = result.ExitCode,
                stdout = result.Stdout,
                stderr = result.Stderr,
                durationMs = result.DurationMs,
                status = result.Status,
            });
        }
        catch (Exception ex)
        {
            Log($"Could not send the result of job {jobId}: {ex.Message}");
        }
        finally
        {
            sendLock.Release();
        }
    }

    while (ws.State == WebSocketState.Open && !stop.IsCancellationRequested)
    {
        using var message = new MemoryStream();
        WebSocketReceiveResult received;
        do
        {
            received = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), stop);
            if (received.MessageType == WebSocketMessageType.Close) return;
            message.Write(buffer, 0, received.Count);
        }
        while (!received.EndOfMessage);

        JsonDocument doc;
        try { doc = JsonDocument.Parse(message.ToArray()); }
        catch (JsonException) { continue; }

        using (doc)
        {
            var root = doc.RootElement;
            var frameType = Str(root, "t");

            if (frameType == "job_run_script" || frameType == "job_file_op")
            {
                var unsignedId = Str(root, "jobId");
                if (!string.IsNullOrWhiteSpace(unsignedId))
                    await SendResult(unsignedId, new JobResult(-1, "", "This agent only runs signed jobs.", 0, "failed"));
                continue;
            }
            if (frameType != "signed_job") continue;

            var opened = OpenSignedJob(root, cfg, out var reason);
            if (opened is null)
            {
                Log($"Rejected a job: {reason}");
                var rejectedId = Str(root, "jobId");
                if (!string.IsNullOrWhiteSpace(rejectedId))
                    await SendResult(rejectedId, new JobResult(-1, "", reason, 0, "failed"));
                continue;
            }

            var job = opened.Value;
            var jobId = Str(job, "jobId")!;
            var type = Str(job, "t");

            // Jobs run in the background, so a long script does not block other jobs.
            _ = Task.Run(async () =>
            {
                var result = type == "job_run_script" ? await RunScriptJob(job)
                    : type == "job_file_op" ? RunFileOp(job)
                    : type == "job_update_agent" ? RequestUpdateCheck()
                    : new JobResult(-1, "", $"Unknown job type: {type}", 0, "failed");
                await SendResult(jobId, result);
            }, stop);
        }
    }
}

JobResult RequestUpdateCheck()
{
    AdgRmm.Agent.Shared.AgentUpdater.RequestCheckNow();
    Log("Update check requested from the console.");
    return new JobResult(0, "Update check started.", "", 0, "succeeded");
}

JsonElement? OpenSignedJob(JsonElement frame, AgentConfig cfg, out string reason)
{
    if (string.IsNullOrWhiteSpace(cfg.JobSigningPublicKey))
    {
        reason = "This agent has no job signing key. Run the installer again.";
        return null;
    }

    try
    {
        var bytes = Convert.FromBase64String(Str(frame, "payload") ?? "");
        var sig = Convert.FromBase64String(Str(frame, "sig") ?? "");

        using var rsa = RSA.Create();
        rsa.ImportFromPem(cfg.JobSigningPublicKey);
        if (!rsa.VerifyData(bytes, sig, HashAlgorithmName.SHA256, RSASignaturePadding.Pss))
        {
            reason = "The job's signature is invalid.";
            return null;
        }

        // Only the bytes that were signed are ever parsed.
        using var doc = JsonDocument.Parse(bytes);
        var root = doc.RootElement;

        if (!string.Equals(Str(root, "agentId"), cfg.AgentId, StringComparison.OrdinalIgnoreCase))
        {
            reason = "The job was signed for a different agent.";
            return null;
        }

        var now = DateTimeOffset.UtcNow;
        var issued = root.TryGetProperty("iat", out var i) && i.TryGetInt64(out var ms)
            ? DateTimeOffset.FromUnixTimeMilliseconds(ms)
            : DateTimeOffset.MinValue;
        if ((now - issued).Duration() > TimeSpan.FromMinutes(15))
        {
            reason = "The job's signature has expired. Check this device's clock.";
            return null;
        }

        var id = Str(root, "jobId");
        if (string.IsNullOrEmpty(id) || !seenJobs.TryAdd(id, now))
        {
            reason = "The job was already delivered.";
            return null;
        }
        foreach (var kv in seenJobs)
            if (now - kv.Value > TimeSpan.FromMinutes(30)) seenJobs.TryRemove(kv.Key, out _);

        reason = "";
        return root.Clone();
    }
    catch (Exception ex)
    {
        reason = "The job could not be read: " + ex.Message;
        return null;
    }
}

async Task<JobResult> RunScriptJob(JsonElement job)
{
    var sw = Stopwatch.StartNew();
    var language = Str(job, "language") ?? "";
    if (!string.Equals(language, "bash", StringComparison.OrdinalIgnoreCase))
        return new JobResult(-1, "", $"Unsupported language on the Linux agent: {language}", 0, "failed");

    var timeoutSec = job.TryGetProperty("timeoutSec", out var t) && t.TryGetInt32(out var parsed) ? parsed : 120;
    var scriptPath = Path.Combine(Path.GetTempPath(), $"adgrmm-job-{Guid.NewGuid():N}.sh");

    try
    {
        await using (var f = new FileStream(scriptPath, new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
        }))
        await using (var w = new StreamWriter(f, new UTF8Encoding(false)))
        {
            await w.WriteAsync(Str(job, "scriptText") ?? "");
        }

        var psi = new ProcessStartInfo("/bin/bash")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(scriptPath);
        if (job.TryGetProperty("args", out var args) && args.ValueKind == JsonValueKind.Array)
            foreach (var a in args.EnumerateArray()) psi.ArgumentList.Add(a.GetString() ?? "");
        if (job.TryGetProperty("env", out var env) && env.ValueKind == JsonValueKind.Object)
            foreach (var p in env.EnumerateObject()) psi.Environment[p.Name] = p.Value.GetString() ?? "";

        using var proc = Process.Start(psi)!;
        var stdoutTask = proc.StandardOutput.ReadToEndAsync();
        var stderrTask = proc.StandardError.ReadToEndAsync();

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stop);
        timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(timeoutSec, 1, 3600)));
        try
        {
            await proc.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            try { proc.Kill(entireProcessTree: true); } catch { /* already gone */ }
            return new JobResult(-1, Shorten(await stdoutTask, 200_000), Shorten(await stderrTask, 200_000) + "\nTIMEOUT", sw.ElapsedMilliseconds, "timeout");
        }

        return new JobResult(proc.ExitCode, Shorten(await stdoutTask, 200_000), Shorten(await stderrTask, 200_000), sw.ElapsedMilliseconds, proc.ExitCode == 0 ? "succeeded" : "failed");
    }
    catch (Exception ex)
    {
        return new JobResult(-1, "", ex.Message, sw.ElapsedMilliseconds, "failed");
    }
    finally
    {
        try { File.Delete(scriptPath); } catch { /* ignore */ }
    }
}

JobResult RunFileOp(JsonElement job)
{
    var sw = Stopwatch.StartNew();
    var payload = job.TryGetProperty("payload", out var nested) && nested.ValueKind == JsonValueKind.Object ? nested : job;
    var op = (Str(payload, "op") ?? "").ToLowerInvariant();
    var path = Str(payload, "path") ?? "";

    try
    {
        object result;
        if (op == "roots" || (op == "list" && (path == "" || path == "__roots__" || path == "__drives__")))
        {
            result = new
            {
                ok = true,
                op = "roots",
                items = new[] { new { name = "/", fullPath = "/", isDir = true, isRoot = true, driveType = "Fixed", isReady = true } },
            };
        }
        else
        {
            var full = Path.GetFullPath(path);
            var recursive = payload.TryGetProperty("recursive", out var r) && r.ValueKind == JsonValueKind.True;
            switch (op)
            {
                case "list":
                    {
                        // One entry that disappears or cannot be read must not lose the whole folder.
                        var items = new DirectoryInfo(full).EnumerateFileSystemInfos().Take(2000).Select(e =>
                        {
                            try
                            {
                                return new
                                {
                                    name = e.Name,
                                    fullPath = e.FullName,
                                    isDir = e is DirectoryInfo,
                                    sizeBytes = e is FileInfo f ? f.Length : (long?)null,
                                    modifiedUtc = e.LastWriteTimeUtc.ToString("o"),
                                };
                            }
                            catch (Exception) when (e is not null)
                            {
                                return null;
                            }
                        }).Where(e => e is not null).ToArray();
                        result = new { ok = true, op = "list", path = full, items };
                        break;
                    }
                case "read":
                    {
                        var maxBytes = payload.TryGetProperty("maxBytes", out var mb) && mb.TryGetInt32(out var parsedMax)
                            ? Math.Clamp(parsedMax, 1, 50 * 1024 * 1024)
                            : 2 * 1024 * 1024;
                        using var fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                        var size = fs.Length;
                        var buf = new byte[(int)Math.Min(size, maxBytes)];
                        fs.ReadExactly(buf);
                        result = new { ok = true, op = "read", path = full, sizeBytes = size, maxBytes, truncated = size > maxBytes, contentBase64 = Convert.ToBase64String(buf) };
                        break;
                    }
                case "write":
                    {
                        var bytes = Convert.FromBase64String(Str(payload, "contentBase64") ?? "");
                        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                        File.WriteAllBytes(full, bytes);
                        result = new { ok = true, op = "write", path = full, sizeBytes = bytes.Length };
                        break;
                    }
                case "mkdir":
                    Directory.CreateDirectory(full);
                    result = new { ok = true, op = "mkdir", path = full };
                    break;
                case "delete":
                    {
                        var deleted = true;
                        if (Directory.Exists(full)) Directory.Delete(full, recursive);
                        else if (File.Exists(full)) File.Delete(full);
                        else deleted = false;
                        result = new { ok = true, op = "delete", path = full, deleted };
                        break;
                    }
                case "move":
                case "copy":
                    {
                        var dest = Path.GetFullPath(Str(payload, "path2") ?? throw new InvalidOperationException("path2 is required."));
                        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                        if (op == "copy") CopyPath(full, dest);
                        else if (Directory.Exists(full)) Directory.Move(full, dest);
                        else File.Move(full, dest, overwrite: false);
                        result = new { ok = true, op, path = full, path2 = dest };
                        break;
                    }
                default:
                    throw new InvalidOperationException($"Unknown file op: {op}");
            }
        }

        return new JobResult(0, JsonSerializer.Serialize(result), "", sw.ElapsedMilliseconds, "succeeded");
    }
    catch (Exception ex)
    {
        return new JobResult(-1, "", ex.Message, sw.ElapsedMilliseconds, "failed");
    }
}

static void CopyPath(string from, string to)
{
    if (File.Exists(from))
    {
        File.Copy(from, to, overwrite: false);
        return;
    }
    Directory.CreateDirectory(to);
    foreach (var file in Directory.EnumerateFiles(from)) File.Copy(file, Path.Combine(to, Path.GetFileName(file)), overwrite: false);
    foreach (var dir in Directory.EnumerateDirectories(from)) CopyPath(dir, Path.Combine(to, Path.GetFileName(dir)));
}

// ─── Remote shell ───────────────────────────────────────────────────────────

string WsBase(AgentConfig cfg) => cfg.ApiBaseUrl.StartsWith("https", StringComparison.OrdinalIgnoreCase)
    ? "wss" + cfg.ApiBaseUrl[5..]
    : "ws" + cfg.ApiBaseUrl[4..];

async Task ShellLoop(AgentConfig cfg)
{
    while (!stop.IsCancellationRequested)
    {
        using var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Authorization", $"Bearer {cfg.AgentKey}");
        var sessions = new ConcurrentDictionary<string, Process>();
        var sendLock = new SemaphoreSlim(1, 1);

        async Task Send(object value)
        {
            await sendLock.WaitAsync(stop);
            try { await SendJson(ws, value); }
            finally { sendLock.Release(); }
        }

        try
        {
            await ws.ConnectAsync(new Uri($"{WsBase(cfg)}/ws/shell?role=agent&agentUuid={Uri.EscapeDataString(cfg.AgentId)}"), stop);
            await Send(new { type = "hello", agentUuid = cfg.AgentId });

            var buffer = new byte[64 * 1024];
            while (ws.State == WebSocketState.Open && !stop.IsCancellationRequested)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult received;
                do
                {
                    received = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), stop);
                    if (received.MessageType == WebSocketMessageType.Close) break;
                    message.Write(buffer, 0, received.Count);
                }
                while (!received.EndOfMessage);
                if (received.MessageType == WebSocketMessageType.Close) break;

                JsonDocument doc;
                try { doc = JsonDocument.Parse(message.ToArray()); }
                catch (JsonException) { continue; }

                using (doc)
                {
                    var root = doc.RootElement;
                    var type = Str(root, "type");
                    var sessionId = Str(root, "sessionId");
                    if (string.IsNullOrWhiteSpace(sessionId)) continue;

                    switch (type)
                    {
                        case "shell.open":
                            {
                                var signed = sessionStarts.Open(root, cfg.JobSigningPublicKey, cfg.AgentId, "shell", sessionId, out var refusal);
                                if (signed is null)
                                {
                                    Log($"Refused a shell session: {refusal}");
                                    await Send(new { type = "shell.error", sessionId, message = refusal });
                                    break;
                                }

                                var cols = root.TryGetProperty("cols", out var c) && c.TryGetInt32(out var pc) ? pc : 120;
                                var rows = root.TryGetProperty("rows", out var w) && w.TryGetInt32(out var pr) ? pr : 30;
                                var runAs = Str(signed.Value, "runAs");
                                try
                                {
                                    var proc = StartShell(cols, rows, runAs);
                                    sessions[sessionId] = proc;
                                    await Send(new { type = "shell.ready", sessionId });
                                    _ = PumpShell(proc, sessionId, Send, sessions);
                                }
                                catch (Exception ex)
                                {
                                    await Send(new { type = "shell.error", sessionId, message = ex.Message });
                                }
                                break;
                            }
                        case "shell.input":
                            if (sessions.TryGetValue(sessionId, out var input))
                                await WriteToShell(input, Str(root, "data") ?? "");
                            break;
                        case "shell.signal":
                            // The terminal turns this into the signal for whatever is in the foreground.
                            if (sessions.TryGetValue(sessionId, out var sig))
                                await WriteToShell(sig, Str(root, "signal") == "SIGINT" ? "\u0003" : "\u001c");
                            break;
                        case "shell.resize":
                            if (sessions.TryGetValue(sessionId, out var resized))
                            {
                                var newCols = root.TryGetProperty("cols", out var rc) && rc.TryGetInt32(out var nc) ? nc : 120;
                                var newRows = root.TryGetProperty("rows", out var rr) && rr.TryGetInt32(out var nr) ? nr : 30;
                                _ = Task.Run(() => ResizeShell(resized, newCols, newRows));
                            }
                            break;
                        case "shell.close":
                            if (sessions.TryRemove(sessionId, out var closing))
                            {
                                try { closing.Kill(entireProcessTree: true); } catch { /* already gone */ }
                            }
                            break;
                    }
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !stop.IsCancellationRequested)
        {
            Log($"Shell connection lost; reconnecting in 5s: {ex.Message}");
        }

        foreach (var kv in sessions)
        {
            try { kv.Value.Kill(entireProcessTree: true); } catch { /* already gone */ }
        }

        await Pause(TimeSpan.FromSeconds(5));
    }
}

// A shell that has just exited must not take every other session down with a failed write.
async Task WriteToShell(Process proc, string text)
{
    try
    {
        await proc.StandardInput.WriteAsync(text);
        await proc.StandardInput.FlushAsync();
    }
    catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException)
    {
        Log($"Shell input was not delivered: {ex.Message}");
    }
}

// "script" keeps the terminal to itself, but the shell it started has the terminal as its stdin.
// Setting the size on that device also tells whatever is running in the foreground.
void ResizeShell(Process proc, int cols, int rows)
{
    try
    {
        var child = File.ReadAllText($"/proc/{proc.Id}/task/{proc.Id}/children").Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        if (child is null) return;

        var tty = new FileInfo($"/proc/{child}/fd/0").LinkTarget;
        if (tty is null || !tty.StartsWith("/dev/pts/")) return;

        Run("stty", new[] { "-F", tty, "cols", Math.Clamp(cols, 20, 500).ToString(), "rows", Math.Clamp(rows, 5, 200).ToString() });
    }
    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
    {
        Log($"Could not resize a shell: {ex.Message}");
    }
}

Process StartShell(int cols, int rows, string? runAs)
{
    var login = "exec /bin/bash -l";
    if (runAs == "user")
    {
        var user = LoggedInUser();
        if (string.IsNullOrEmpty(user))
            throw new InvalidOperationException("Nobody is logged in on this device. Turn off \"Run as logged-in user\" to use root.");

        // The name goes into a shell command, so it must be nothing but a plain account name.
        if (!System.Text.RegularExpressions.Regex.IsMatch(user, "^[a-zA-Z_][a-zA-Z0-9_.-]*$"))
            throw new InvalidOperationException("The logged-in account has a name this tool cannot use.");

        login = $"exec su - {user}";
    }

    // util-linux "script" supplies a real terminal, so prompts, colours and Ctrl+C work.
    var inner = $"stty cols {Math.Clamp(cols, 20, 500)} rows {Math.Clamp(rows, 5, 200)} 2>/dev/null; {login}";
    var usePty = File.Exists("/usr/bin/script") || File.Exists("/bin/script");

    var psi = new ProcessStartInfo(usePty ? "script" : "/bin/bash")
    {
        RedirectStandardInput = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false,
        WorkingDirectory = "/root",
    };
    if (!Directory.Exists(psi.WorkingDirectory)) psi.WorkingDirectory = "/";
    if (usePty)
    {
        psi.ArgumentList.Add("-qfec");
        psi.ArgumentList.Add(inner);
        psi.ArgumentList.Add("/dev/null");
    }
    else if (runAs == "user")
    {
        psi.ArgumentList.Add("-c");
        psi.ArgumentList.Add(login);
    }
    psi.Environment["TERM"] = "xterm-256color";
    psi.Environment["HOME"] = psi.WorkingDirectory;

    return Process.Start(psi) ?? throw new InvalidOperationException("Could not start a shell.");
}

async Task PumpShell(Process proc, string sessionId, Func<object, Task> send, ConcurrentDictionary<string, Process> sessions)
{
    async Task Pump(StreamReader reader)
    {
        var chars = new char[4096];
        int n;
        while ((n = await reader.ReadAsync(chars, stop)) > 0)
            await send(new { type = "shell.data", sessionId, data = new string(chars, 0, n) });
    }

    try
    {
        await Task.WhenAll(Pump(proc.StandardOutput), Pump(proc.StandardError));
        await proc.WaitForExitAsync(stop);
        await send(new { type = "shell.exit", sessionId, code = proc.ExitCode });
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        Log($"Shell session ended: {ex.Message}");
    }
    finally
    {
        sessions.TryRemove(sessionId, out _);
        proc.Dispose();
    }
}

async Task SendJson(ClientWebSocket ws, object value)
{
    var bytes = JsonSerializer.SerializeToUtf8Bytes(value, jsonOut);
    await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, stop);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

static string? Str(JsonElement obj, string name) =>
    obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

// The server rejects empty or over-long values, and one bad package must not lose the whole inventory.
static string? Clip(string? s, int max)
{
    s = s?.Trim();
    if (string.IsNullOrEmpty(s)) return null;
    return s.Length <= max ? s : s[..max];
}

static string Shorten(string s, int max) => s.Length <= max ? s : s[..max] + "\n<TRUNCATED>";

static (int Code, string Stdout, string Stderr) Run(string file, string[] args)
{
    try
    {
        var psi = new ProcessStartInfo(file)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var p = Process.Start(psi)!;
        var stderr = p.StandardError.ReadToEndAsync();
        var stdout = p.StandardOutput.ReadToEnd();
        p.WaitForExit();
        return (p.ExitCode, stdout, stderr.GetAwaiter().GetResult());
    }
    catch (Exception ex)
    {
        return (-1, "", ex.Message);
    }
}

sealed class AgentConfig
{
    public string ApiBaseUrl { get; set; } = "";
    public string AgentId { get; set; } = "";
    public string AgentKey { get; set; } = "";
    public string DeviceId { get; set; } = "";
    public string EnrollmentKey { get; set; } = "";
    public string JobSigningPublicKey { get; set; } = "";
}

sealed class EnrollmentFile
{
    public string? DeviceId { get; set; }
    public string? EnrollmentKey { get; set; }
    public string? BaseUrl { get; set; }
}

sealed class EnrollmentResponse
{
    public string? AgentId { get; set; }
    public string? AgentToken { get; set; }
    public string? DeviceId { get; set; }
    public string? JobSigningPublicKey { get; set; }
}

sealed record SoftwareItem(string Name, string? Version, string? Publisher);

sealed record JobResult(int ExitCode, string Stdout, string Stderr, long DurationMs, string Status);
