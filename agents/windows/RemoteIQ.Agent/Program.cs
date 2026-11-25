// RemoteIQ.Agent/Program.cs

using System;
using System.IO;
using System.Linq;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using RemoteIQ.Agent.Services;
using Serilog;
using Serilog.Events;

// The updater runs a new build this way before stopping anything, to prove it can start here.
if (args.Any(a => string.Equals(a, "--version", StringComparison.OrdinalIgnoreCase)))
{
    Console.WriteLine(UpdateService.CurrentVersion);
    return;
}

// The H.264 start-up check of the remote console runs here, in its own short-lived process (see H264SelfTest).
if (args.Any(a => string.Equals(a, H264SelfTest.Argument, StringComparison.OrdinalIgnoreCase)))
{
    Environment.ExitCode = H264SelfTest.RunChild();
    return;
}

// The tray app (a small icon for the person using the computer) runs from this same executable, as that person, in their session.
// It never reads the agent's settings or token: it asks the agent service over a local pipe (see Tray/TrayBridgeService).
if (args.Any(a => string.Equals(a, "--tray", StringComparison.OrdinalIgnoreCase)))
{
    var pipeArg = args.SkipWhile(a => !string.Equals(a, "--tray-pipe", StringComparison.OrdinalIgnoreCase)).Skip(1).FirstOrDefault();
    Environment.ExitCode = RemoteIQ.Agent.Tray.TrayApp.Run(pipeArg);
    return;
}

// Only the tray's pipe and its call to the server, for trying them on their own: --tray-bridge-test <baseUrl> <agentToken> <pipeName>
if (args.Any(a => string.Equals(a, "--tray-bridge-test", StringComparison.OrdinalIgnoreCase)))
{
    var rest = args.SkipWhile(a => !string.Equals(a, "--tray-bridge-test", StringComparison.OrdinalIgnoreCase)).Skip(1).ToArray();
    if (rest.Length < 3) { Console.Error.WriteLine("usage: --tray-bridge-test <baseUrl> <agentToken> <pipeName>"); Environment.ExitCode = 2; return; }
    using var testHttp = new System.Net.Http.HttpClient();
    var forwarder = new RemoteIQ.Agent.Tray.TrayForwarder(() => (rest[0], rest[1]), () => testHttp);
    Console.WriteLine("ready");
    await new RemoteIQ.Agent.Tray.TrayPipeServer(rest[2], forwarder.ForwardAsync).RunAsync(CancellationToken.None);
    return;
}

// Draws the tray app's windows with made-up data into pictures: --tray-selftest <folder>
if (args.Any(a => string.Equals(a, "--tray-selftest", StringComparison.OrdinalIgnoreCase)))
{
    var dir = args.SkipWhile(a => !string.Equals(a, "--tray-selftest", StringComparison.OrdinalIgnoreCase)).Skip(1).FirstOrDefault() ?? "tray-selftest";
    Environment.ExitCode = RemoteIQ.Agent.Tray.TrayApp.SelfTest(dir);
    return;
}

var builder = Host.CreateApplicationBuilder(args);

// Optional: native DLL smoke test (run explicitly)
// Usage: RemoteIQ.Agent.exe --native-smoke [--native-smoke-cbs]
// RemoteIQ.Agent/Program.cs (only the smoke test block needs to match this)

if (args.Any(a => string.Equals(a, "--native-smoke", StringComparison.OrdinalIgnoreCase)))
{
    var code = NativeWebRtcSmokeTest.Run(args);
    Environment.ExitCode = code;
    return;
}


// Use ProgramData for logs (LocalService can write)
var baseData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
var logsDir = Path.Combine(baseData, "RemoteIQ", "Logs");
Directory.CreateDirectory(logsDir);

var loggerConfig = new LoggerConfiguration()
    .MinimumLevel.Information()
    .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
    .WriteTo.File(
        Path.Combine(logsDir, "agent-.log"),
        rollingInterval: RollingInterval.Day,
        retainedFileCountLimit: 14
    );

try
{
    loggerConfig = loggerConfig.WriteTo.EventLog(
        "RemoteIQ Agent",
        manageEventSource: false,
        restrictedToMinimumLevel: LogEventLevel.Warning
    );
}
catch { }

Log.Logger = loggerConfig.CreateLogger();

builder.Logging.ClearProviders();
builder.Logging.AddSerilog(Log.Logger, dispose: true);

builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "RemoteIQ Agent";
});

// One failing worker must not take down the whole agent.
builder.Services.Configure<HostOptions>(o =>
    o.BackgroundServiceExceptionBehavior = BackgroundServiceExceptionBehavior.Ignore);

// Core services
builder.Services.AddSingleton<ConfigService>();
builder.Services.AddSingleton<CryptoService>();
builder.Services.AddSingleton<PinnedHttpClientFactory>();
builder.Services.AddSingleton<SystemInfoCollector>();
builder.Services.AddSingleton<ScriptExecutor>();

// Hosted services
builder.Services.AddHostedService<EnrollmentService>();
builder.Services.AddHostedService<HeartbeatService>();
builder.Services.AddSingleton<InventoryService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<InventoryService>());
builder.Services.AddSingleton<SoftwareInstallService>();

builder.Services.AddHostedService<TaskWorker>();
builder.Services.AddHostedService<RemoteShellWorker>();
builder.Services.AddHostedService<RemoteDesktopTunnelWorker>();

// Standard packages use the managed WebRTC peer. The native one needs a separately built DLL.
// (AppContext.BaseDirectory is the temporary extraction folder in a single-file app.)
var installDir = Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;
if (File.Exists(Path.Combine(installDir, "RemoteIQ.NativeWebRtc.dll")))
    builder.Services.AddSingleton<IWebRtcConsolePeerFactory, NativeWebRtcConsolePeerFactory>();
else
    builder.Services.AddSingleton<IWebRtcConsolePeerFactory, SipsorceryWebRtcConsolePeerFactory>();
builder.Services.AddHostedService<RemoteConsoleWorker>();
builder.Services.AddHostedService<RemoteConsoleTunnelWorker>();

builder.Services.AddHostedService<UpdateService>();

// The tray app on the device: its pipe to the agent, and starting it for people who are signed in when support has it switched on.
builder.Services.AddHostedService<RemoteIQ.Agent.Tray.TrayBridgeService>();

builder.Services.AddSingleton<PatchService>();

// The check runner reads disk, CPU, memory, services and the like on a schedule and reports them. It existed but was never started
// on Windows. It is a singleton so the task worker can also ask it to run checks now.
builder.Services.AddSingleton<CheckRunnerService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<CheckRunnerService>());

builder.Services.AddHostedService<AgentTaskWorkerService>();

var host = builder.Build();
await host.RunAsync();
