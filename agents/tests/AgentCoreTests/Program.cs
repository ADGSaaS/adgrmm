// Tests the logic shared by both agents, against a live protocol server when one is given.
//
//   dotnet run --project agents/tests/AgentCoreTests                        pure logic only
//   dotnet run --project agents/tests/AgentCoreTests -- <baseUrl> <pemFile> <exeName> <agentId> <deviceId> <packageVersion>
//
// The second form is driven by backend/test/agent-update-protocol.cjs.

using System.Security.Cryptography;
using System.Text;
using AdgRmm.Agent.Linux;
using AdgRmm.Agent.Services;
using AdgRmm.Agent.Shared;

var failures = 0;
void Check(string name, bool ok)
{
    Console.WriteLine($"{(ok ? "pass" : "FAIL")}  {name}");
    if (!ok) failures++;
}

// ── Versions ───────────────────────────────────────────────────────────────
Check("1.10.0 is newer than 1.9.0", AgentVersion.IsNewer("1.10.0", "1.9.0"));
Check("1.9.0 is not newer than 1.10.0", !AgentVersion.IsNewer("1.9.0", "1.10.0"));
Check("equal is not newer", !AgentVersion.IsNewer("1.2.2", "1.2.2"));
Check("1.2 equals 1.2.0", AgentVersion.AreEqual("1.2", "1.2.0"));
Check("1.2.0.1 is newer than 1.2.0", AgentVersion.IsNewer("1.2.0.1", "1.2.0"));
Check("garbage is never newer", !AgentVersion.IsNewer("2.0.0-beta", "1.0.0"));
Check("garbage current is never upgraded from", !AgentVersion.IsNewer("2.0.0", "dev"));
Check("empty is rejected", !AgentVersion.TryParse("", out _));
Check("negative is rejected", !AgentVersion.TryParse("1.-2.0", out _));
Check("five parts are rejected", !AgentVersion.TryParse("1.2.3.4.5", out _));

// ── Manifest verification ──────────────────────────────────────────────────
using var key = RSA.Create(3072);
using var otherKey = RSA.Create(3072);
var pem = key.ExportSubjectPublicKeyInfoPem();
var sha = new string('a', 64);

UpdateManifest Signed(string version, string os, RSA? signer = null, string? url = null, string? shaOverride = null)
{
    var u = url ?? UpdateManifestVerifier.DownloadPath(os);
    var h = shaOverride ?? sha;
    var sig = (signer ?? key).SignData(Encoding.UTF8.GetBytes(UpdateManifestVerifier.Canonical(version, h, u)),
        HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
    return new UpdateManifest { Version = version, Sha256 = h, Url = u, Signature = Convert.ToBase64String(sig) };
}

Check("a signed newer manifest passes", UpdateManifestVerifier.Verify(Signed("1.3.0", "windows"), pem, "windows", "1.2.2", out _));
Check("no downgrade", !UpdateManifestVerifier.Verify(Signed("1.2.1", "windows"), pem, "windows", "1.2.2", out _));
Check("no same version", !UpdateManifestVerifier.Verify(Signed("1.2.2", "windows"), pem, "windows", "1.2.2", out _));
Check("wrong key fails", !UpdateManifestVerifier.Verify(Signed("1.3.0", "windows", otherKey), pem, "windows", "1.2.2", out _));
Check("no pinned key fails", !UpdateManifestVerifier.Verify(Signed("1.3.0", "windows"), "", "windows", "1.2.2", out _));
Check("another OS's manifest fails", !UpdateManifestVerifier.Verify(Signed("1.3.0", "linux"), pem, "windows", "1.2.2", out _));
Check("a signed foreign URL still fails", !UpdateManifestVerifier.Verify(Signed("1.3.0", "windows", url: "https://evil.example/x"), pem, "windows", "1.2.2", out _));
Check("uppercase hash fails", !UpdateManifestVerifier.Verify(Signed("1.3.0", "windows", shaOverride: new string('A', 64)), pem, "windows", "1.2.2", out _));

var tamperedVersion = Signed("1.3.0", "windows"); tamperedVersion.Version = "9.9.9";
Check("tampered version fails", !UpdateManifestVerifier.Verify(tamperedVersion, pem, "windows", "1.2.2", out _));
var tamperedHash = Signed("1.3.0", "windows"); tamperedHash.Sha256 = new string('b', 64);
Check("tampered hash fails", !UpdateManifestVerifier.Verify(tamperedHash, pem, "windows", "1.2.2", out _));
var unsigned = Signed("1.3.0", "windows"); unsigned.Signature = "";
Check("unsigned fails", !UpdateManifestVerifier.Verify(unsigned, pem, "windows", "1.2.2", out _));
var badBase64 = Signed("1.3.0", "windows"); badBase64.Signature = "not base64!";
Check("malformed signature fails", !UpdateManifestVerifier.Verify(badBase64, pem, "windows", "1.2.2", out _));

// ── Retry policy ───────────────────────────────────────────────────────────
var now = DateTimeOffset.UtcNow;
Check("first attempt is allowed", UpdatePolicy.CanAttempt(null, "1.3.0", now, out _));
var one = UpdatePolicy.Record(null, "1.3.0", now);
Check("one attempt recorded", one.Attempts == 1);
Check("no retry straight after a failure", !UpdatePolicy.CanAttempt(one, "1.3.0", now.AddMinutes(1), out _));
Check("no retry before the backoff", !UpdatePolicy.CanAttempt(one, "1.3.0", now.AddMinutes(59), out _));
Check("retry after the backoff", UpdatePolicy.CanAttempt(one, "1.3.0", now.AddMinutes(61), out _));
var two = UpdatePolicy.Record(one, "1.3.0", now);
Check("second failure waits six hours", !UpdatePolicy.CanAttempt(two, "1.3.0", now.AddHours(5), out _) && UpdatePolicy.CanAttempt(two, "1.3.0", now.AddHours(7), out _));
var three = UpdatePolicy.Record(two, "1.3.0", now);
Check("three failures give up on that version", !UpdatePolicy.CanAttempt(three, "1.3.0", now.AddDays(365), out _));
Check("a newer version is allowed after giving up", UpdatePolicy.CanAttempt(three, "1.3.1", now.AddHours(1), out _));
Check("a server flipping versions cannot cause a loop", !UpdatePolicy.CanAttempt(three, "1.3.1", now.AddMinutes(5), out _));
Check("a new version restarts the count", UpdatePolicy.Record(three, "1.3.1", now).Attempts == 1);

// ── Jitter ─────────────────────────────────────────────────────────────────
var interval = TimeSpan.FromMinutes(30);
Check("jitter never shortens the interval", AgentUpdater.JitteredInterval(interval, 0) == interval);
Check("jitter stretches by at most half", AgentUpdater.JitteredInterval(interval, 1) == TimeSpan.FromMinutes(45));
Check("a tiny interval cannot make a tight loop", AgentUpdater.JitteredInterval(TimeSpan.Zero, 0) == TimeSpan.FromMinutes(1));

// ── Check evaluation ───────────────────────────────────────────────────────
Check("disk ok", CheckEvaluation.LowerIsWorse(50, 10, 5) == "OK");
Check("disk warn", CheckEvaluation.LowerIsWorse(10, 10, 5) == "WARN");
Check("disk crit", CheckEvaluation.LowerIsWorse(4, 10, 5) == "CRIT");
Check("cpu ok", CheckEvaluation.HigherIsWorse(50, 90, 98) == "OK");
Check("cpu warn", CheckEvaluation.HigherIsWorse(90, 90, 98) == "WARN");
Check("cpu crit", CheckEvaluation.HigherIsWorse(99, 90, 98) == "CRIT");
Check("cpu percent", Math.Abs(CheckEvaluation.CpuBusyPercent(new CpuTimes(0, 0), new CpuTimes(25, 100)) - 75) < 0.01);
Check("cpu with no elapsed time", CheckEvaluation.CpuBusyPercent(new CpuTimes(5, 100), new CpuTimes(5, 100)) == 0);
Check("cpu counters going backwards stay in range", CheckEvaluation.CpuBusyPercent(new CpuTimes(90, 100), new CpuTimes(10, 200)) <= 100);
Check("service name rejects an option", !CheckEvaluation.IsSafeServiceName("--help"));
Check("service name rejects shell text", !CheckEvaluation.IsSafeServiceName("a;rm -rf /"));
Check("service name allows a template unit", CheckEvaluation.IsSafeServiceName("getty@tty1.service"));
Check("host rejects an option", !CheckEvaluation.IsSafeHost("-f"));

var stat = LinuxCheckProbes.ParseProcStat("cpu  100 0 100 700 100 0 0 0 0 0");
Check("/proc/stat parses", stat is { Idle: 800, Total: 1000 });
Check("/proc/stat rejects junk", LinuxCheckProbes.ParseProcStat("cpu  a b c d") is null);
var mem = LinuxCheckProbes.ParseMemInfo(new[] { "MemTotal:       1000 kB", "MemFree:         100 kB", "MemAvailable:    400 kB" });
Check("/proc/meminfo parses", mem is { TotalBytes: 1024000, AvailableBytes: 409600 });
Check("/proc/meminfo without MemAvailable is unknown", LinuxCheckProbes.ParseMemInfo(new[] { "MemTotal: 1000 kB" }) is null);

// ── Running checks now ─────────────────────────────────────────────────────
{
    var posted = new List<string>();
    var handler = new FakeHandler(req =>
    {
        // The plan cannot be fetched here, so the runner keeps its built-in checks, which is what the test wants to run.
        if (req.Method == HttpMethod.Get) return new HttpResponseMessage(System.Net.HttpStatusCode.InternalServerError);
        posted.Add(req.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
        return new HttpResponseMessage(System.Net.HttpStatusCode.Created);
    });
    var runner = new CheckRunner(new FakeProbes(), new CheckRunnerOptions
    {
        ApiBaseUrl = () => "http://server.test",
        Token = () => "token",
        AgentId = () => "agent-1",
        DeviceId = () => "device-1",
        PublicKeyPem = () => "",
        Http = () => new HttpClient(handler),
        Log = _ => { },
        CurrentVersion = "1.3.31",
        UpdateStateDir = Path.GetTempPath(),
    });

    var ranCount = runner.RunNowAsync(new[] { "builtin:cpu", "builtin:memory" }, CancellationToken.None).GetAwaiter().GetResult();
    Check("run now runs only the checks it was asked for", ranCount == 2);
    Check("and sends their results at once", posted.Count == 1 && posted[0].Contains("builtin:cpu") && posted[0].Contains("builtin:memory") && !posted[0].Contains("builtin:disk"));
    Check("nothing is left waiting to be sent", runner.Buffered.Count == 0);

    posted.Clear();
    var diskCount = runner.RunNowAsync(new[] { "builtin:disk:c:" }, CancellationToken.None).GetAwaiter().GetResult();
    Check("a result key such as builtin:disk:c: finds the builtin:disk check", diskCount == 1 && posted.Count == 1);

    posted.Clear();
    var none = runner.RunNowAsync(new[] { "no-such-check" }, CancellationToken.None).GetAwaiter().GetResult();
    Check("an unknown check runs nothing and sends nothing", none == 0 && posted.Count == 0);

    var unenrolled = new CheckRunner(new FakeProbes(), new CheckRunnerOptions
    {
        ApiBaseUrl = () => "http://server.test", Token = () => "", AgentId = () => "", DeviceId = () => "", PublicKeyPem = () => "",
        Http = () => new HttpClient(handler), Log = _ => { }, CurrentVersion = "1.3.31", UpdateStateDir = Path.GetTempPath(),
    });
    var refused = false;
    try { unenrolled.RunNowAsync(Array.Empty<string>(), CancellationToken.None).GetAwaiter().GetResult(); } catch (InvalidOperationException) { refused = true; }
    Check("an agent that is not enrolled refuses", refused);
}

// ── Plan envelopes ─────────────────────────────────────────────────────────
(string Payload, string Sig) Seal(string json, RSA signer)
{
    var bytes = Encoding.UTF8.GetBytes(json);
    return (Convert.ToBase64String(bytes), Convert.ToBase64String(signer.SignData(bytes, HashAlgorithmName.SHA256, RSASignaturePadding.Pss)));
}
var iat = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
var good = Seal($$"""{"agentId":"a1","iat":{{iat}},"mode":"custom","checks":[{"key":"k","type":"CPU","name":"n"}]}""", key);
Check("a signed plan opens", CheckEvaluation.TryOpenPlan(good.Payload, good.Sig, pem, "a1", DateTimeOffset.UtcNow, out var opened, out _) && opened!.Checks.Count == 1);
Check("a plan for another agent fails", !CheckEvaluation.TryOpenPlan(good.Payload, good.Sig, pem, "a2", DateTimeOffset.UtcNow, out _, out _));
Check("an old plan fails", !CheckEvaluation.TryOpenPlan(good.Payload, good.Sig, pem, "a1", DateTimeOffset.UtcNow.AddHours(1), out _, out _));
var forged = Seal($$"""{"agentId":"a1","iat":{{iat}},"mode":"custom","checks":[]}""", otherKey);
Check("a forged plan fails", !CheckEvaluation.TryOpenPlan(forged.Payload, forged.Sig, pem, "a1", DateTimeOffset.UtcNow, out _, out _));

// ── Real Windows probes: these only read ───────────────────────────────────
var probes = new WindowsCheckProbes();
var workDir = Path.Combine(Path.GetTempPath(), "adg-agentcore-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(workDir);

var windowsRunner = new CheckRunner(probes, new CheckRunnerOptions
{
    ApiBaseUrl = () => "http://127.0.0.1:9",
    Token = () => "t",
    AgentId = () => "a",
    DeviceId = () => "d",
    PublicKeyPem = () => pem,
    Http = () => new HttpClient(),
    Log = Console.WriteLine,
    CurrentVersion = "1.2.2",
    UpdateStateDir = workDir,
});

var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));
var seen = new List<CheckRun>();
foreach (var definition in CheckEvaluation.Defaults(probes))
    seen.AddRange(await windowsRunner.ExecuteAsync(definition, cts.Token));
foreach (var run in seen) Console.WriteLine($"      {run.Status,-7} {run.CheckName}: {run.Output}");

// Network traffic and disk activity need two samples for a rate, so the first run of each sends nothing (see PerfTests).
Check("every default produced a result", seen.Count >= CheckEvaluation.Defaults(probes).Count(d => !CheckEvaluation.IsInformational(d.Type)));
Check("every result has a dedupe key and times", seen.All(r => !string.IsNullOrEmpty(r.DedupeKey) && r.StartedAt is not null && r.FinishedAt is not null));
Check("disk, memory and cpu really measured", new[] { "DISK", "MEMORY", "CPU" }.All(t => seen.Any(r => r.CheckType == t && r.Status != "UNKNOWN")));
Check("service states were read", seen.Where(r => r.CheckType == "SERVICE").All(r => r.Status == "OK"));
Check("a missing service warns", (await windowsRunner.ExecuteAsync(new CheckDefinition { Key = "k", Type = "SERVICE", Name = "n", Service = "AdgRmmNoSuchService" }, cts.Token))[0].Status == "WARN");
Check("an unknown type is unknown, not a crash", (await windowsRunner.ExecuteAsync(new CheckDefinition { Key = "k", Type = "NOPE", Name = "n" }, cts.Token))[0].Status == "UNKNOWN");
Check("an unreachable server warns", seen.Single(r => r.CheckType == "PORT").Status == "WARN");

File.WriteAllText(Path.Combine(workDir, "result.json"), """{"version":"1.3.0","outcome":"rolled_back","detail":"The new version did not come up.","atUtc":"2026-11-05T00:00:00Z"}""");
var rolledBack = (await windowsRunner.ExecuteAsync(new CheckDefinition { Key = "k", Type = "AGENT", Name = "n" }, cts.Token))[0];
Check("a rollback shows up as a failing check", rolledBack.Status == "CRIT" && rolledBack.Output!.Contains("1.3.0"));
File.WriteAllText(Path.Combine(workDir, "result.json"), """{"version":"1.2.2","outcome":"rolled_back","detail":"","atUtc":"2026-11-05T00:00:00Z"}""");
Check("a failure of an older version is forgotten", (await windowsRunner.ExecuteAsync(new CheckDefinition { Key = "k", Type = "AGENT", Name = "n" }, cts.Token))[0].Status == "OK");

Directory.Delete(workDir, recursive: true);

// ── Update task definition: parsed by Task Scheduler, never registered ─────
try
{
    dynamic scheduler = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service")!)!;
    scheduler.Connect();
    dynamic definition = scheduler.NewTask(0);
    definition.XmlText = WindowsUpdatePlatform.TaskXml(@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe", "-File \"C:\\ProgramData\\AdgRmm\\update\\apply & <test>.ps1\"");
    Check("Task Scheduler accepts the task XML", definition.Settings.DisallowStartIfOnBatteries == false && definition.Settings.StopIfGoingOnBatteries == false);
}
catch (Exception ex)
{
    Check($"Task Scheduler accepts the task XML: {ex.Message}", false);
}

// ── Software installs and installed-software inventory ─────────────────────
await SoftwareTests.Run(Check);
await LinuxPatchTests.Run(Check);
await UpdatesTests.Run(Check);
await PerfTests.Run(Check);

// ── The real Linux package format, when one is given ───────────────────────
var linuxPackage = Environment.GetEnvironmentVariable("ADG_LINUX_PACKAGE");
if (!string.IsNullOrEmpty(linuxPackage))
{
    var extractTo = Path.Combine(Path.GetTempPath(), "adg-tar-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(extractTo);
    await using (var file = File.OpenRead(linuxPackage))
    await using (var gz = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Decompress))
        await System.Formats.Tar.TarFile.ExtractToDirectoryAsync(gz, extractTo, overwriteFiles: true);
    Check("the managed tar reader unpacks the real Linux package", File.Exists(Path.Combine(extractTo, "adgrmm-agent")) && File.Exists(Path.Combine(extractTo, "uninstall.sh")));
    Directory.Delete(extractTo, recursive: true);
}

// ── Against a live server, when driven by the protocol test ────────────────
if (args.Length >= 6)
{
    var baseUrl = args[0];
    var serverPem = File.ReadAllText(args[1]);
    var exeName = args[2];
    var packageVersion = args[5];
    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };

    var root = Path.Combine(Path.GetTempPath(), "adg-e2e-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);
    var install = Path.Combine(root, "Agent");
    Directory.CreateDirectory(install);

    AgentUpdater Updater(FakePlatform platform, string version, string token = "agent-token") => new(platform, new AgentUpdaterOptions
    {
        CurrentVersion = version,
        ApiBaseUrl = () => baseUrl,
        Token = () => token,
        PublicKeyPem = () => serverPem,
        Http = () => http,
        Interval = () => TimeSpan.FromMinutes(30),
        Log = m => Console.WriteLine("      " + m),
    });

    var platform = new FakePlatform(install, Path.Combine(root, "state"), exeName);
    Directory.CreateDirectory(platform.StateDir);

    var up = await Updater(platform, packageVersion).CheckOnceAsync(CancellationToken.None);
    Check($"the package's own version is up to date (got {up})", up == UpdateCheckOutcome.UpToDate);

    var bad = await Updater(platform, "1.0.0", "wrong").CheckOnceAsync(CancellationToken.None);
    Check($"a bad token gets no update (got {bad})", bad == UpdateCheckOutcome.Unavailable);

    var launched = await Updater(platform, "1.0.0").CheckOnceAsync(CancellationToken.None);
    Check($"an old agent downloads, verifies and launches (got {launched})", launched == UpdateCheckOutcome.Launched && platform.Launched == packageVersion);
    Check("the new build sits in the staging folder", File.Exists(Path.Combine(install + ".update", "new", platform.ExecutableName)));
    Check("the pending marker names the target", File.ReadAllText(Path.Combine(platform.StateDir, "pending.txt")).Trim() == packageVersion);
    Check("the current install was not touched", Directory.Exists(install));

    File.Delete(Path.Combine(platform.StateDir, "apply.started"));
    var again = await Updater(platform, "1.0.0").CheckOnceAsync(CancellationToken.None);
    Check($"no immediate second attempt (got {again})", again == UpdateCheckOutcome.Deferred);

    await Updater(platform, packageVersion).ConfirmPendingAsync(CancellationToken.None);
    Check("the new version confirms itself", File.ReadAllText(Path.Combine(platform.StateDir, "ok.txt")).Trim() == packageVersion && !File.Exists(Path.Combine(platform.StateDir, "pending.txt")));

    Directory.Delete(root, recursive: true);

    // The real check runner against the real ingest routes.
    var runner = new CheckRunner(probes, new CheckRunnerOptions
    {
        ApiBaseUrl = () => baseUrl,
        Token = () => "agent-token",
        AgentId = () => args[3],
        DeviceId = () => args[4],
        PublicKeyPem = () => serverPem,
        Http = () => http,
        Log = m => Console.WriteLine("      " + m),
        CurrentVersion = "1.2.2",
        UpdateStateDir = Path.GetTempPath(),
    });
    await runner.RefreshPlanAsync(CancellationToken.None);
    Check("the signed plan was accepted and says to use the defaults", runner.CurrentChecks.Any(c => c.Key == "builtin:disk"));
    await runner.RunDueAsync(CancellationToken.None);
    var count = runner.Buffered.Count;
    await runner.FlushAsync(CancellationToken.None);
    Check($"{count} results were accepted by the server", count >= 5 && runner.Buffered.Count == 0);
}

Console.WriteLine(failures == 0 ? "ALL PASSED" : $"{failures} FAILED");
return failures == 0 ? 0 : 1;

/// <summary>Everything real except the last step, which would stop a service.</summary>
sealed class FakePlatform : IUpdatePlatform
{
    public FakePlatform(string installDir, string stateDir, string exeName)
    {
        InstallDir = installDir;
        StateDir = stateDir;
        ExecutableName = exeName;
    }

    public string Os => "windows";
    public string Arch => "x64";
    public string InstallDir { get; }
    public string StateDir { get; }
    public string ExecutableName { get; }
    public string? Launched { get; private set; }

    public bool CanSelfUpdate(out string reason) { reason = ""; return true; }

    public Task ExtractAsync(string packagePath, string targetDir, CancellationToken ct)
    {
        System.IO.Compression.ZipFile.ExtractToDirectory(packagePath, targetDir, overwriteFiles: true);
        return Task.CompletedTask;
    }

    public void LaunchApply(string targetVersion) => Launched = targetVersion;
}

sealed class FakeHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, HttpResponseMessage> _respond;
    public FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) { _respond = respond; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(_respond(request));
}

sealed class FakeProbes : ICheckProbes
{
    public CpuTimes? ReadCpuTimes() => new CpuTimes(10, 100);
    public MemorySample? ReadMemory() => new MemorySample(1000, 900);
    public IReadOnlyList<DiskSample> ReadDisks() => new[] { new DiskSample("C:", 1000, 900) };
    public ServiceSample ReadService(string name) => new ServiceSample(true, true, "Running");
    public IReadOnlyList<string>? ReadFailedServices() => null;
    public IReadOnlyList<CheckDefinition> PlatformDefaults() => Array.Empty<CheckDefinition>();
}
