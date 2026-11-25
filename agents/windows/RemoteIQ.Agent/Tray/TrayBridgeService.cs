// RemoteIQ.Agent/Tray/TrayBridgeService.cs
//
// The agent's half of the tray app on a device:
//   - a named pipe that the tray (running as the signed-in user) asks four things through, passed on to the server with the device's token
//   - every minute, if the server says the tray is on, a tray for every signed-in user who has none (started AS THAT USER, never as SYSTEM:
//     nothing a person can type into runs with more rights than theirs)
// When the server says it is off, nothing is started, and a tray that is running closes itself when it hears so.
// The pipe and the call to the server are separate classes so they can be tried on their own (see tests/AgentCoreTests/TrayTests.cs).
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using RemoteIQ.Agent.Services;

namespace RemoteIQ.Agent.Tray;

/// <summary>Passes a checked request on to the server with the device's token and returns the answer as it came.</summary>
internal sealed class TrayForwarder
{
    private readonly Func<(string BaseUrl, string Key)> _credentials;
    private readonly Func<HttpClient> _http;

    public TrayForwarder(Func<(string BaseUrl, string Key)> credentials, Func<HttpClient> http) { _credentials = credentials; _http = http; }

    public async Task<TrayProtocol.Response> ForwardAsync(TrayProtocol.Request r, CancellationToken ct)
    {
        var (baseAddress, key) = _credentials();
        if (string.IsNullOrEmpty(key) || string.IsNullOrEmpty(baseAddress)) return new(false, 0, null, "This computer is not set up with support yet.");
        var baseUrl = baseAddress.TrimEnd('/') + "/api/agent/tray";
        try
        {
            using var req = r.Op switch
            {
                TrayProtocol.OpStatus => new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}/status"),
                TrayProtocol.OpChatGet => new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}/chat" + (string.IsNullOrEmpty(r.After) ? "" : $"?after={Uri.EscapeDataString(r.After)}")),
                TrayProtocol.OpTicketGet => new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}/tickets/{r.Number}"),
                TrayProtocol.OpContact => Post($"{baseUrl}/contact", new { user = r.User, name = r.Name, email = r.Email, phone = r.Phone }),
                TrayProtocol.OpChatEnd => Post($"{baseUrl}/chat/end", new { user = r.User, name = r.Name }),
                TrayProtocol.OpTicketResolve => Post($"{baseUrl}/tickets/{r.Number}/resolve", new { reason = r.Message, user = r.User, name = r.Name }),
                TrayProtocol.OpTicketReply => Post($"{baseUrl}/tickets/{r.Number}/reply", new { message = r.Message, user = r.User, name = r.Name }),
                TrayProtocol.OpHelp => Post($"{baseUrl}/help", new { message = r.Message, user = r.User, urgent = r.Urgent, subject = r.Subject, email = r.Email, name = r.Name, phone = r.Phone, category = r.Category, appName = r.AppName, appPublisher = r.AppPublisher, appVersion = r.AppVersion }),
                _ => Post($"{baseUrl}/chat", new { message = r.Message, user = r.User, name = r.Name, email = r.Email, phone = r.Phone }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", key);
            using var res = await _http().SendAsync(req, ct).ConfigureAwait(false);
            var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            JsonElement? body = null;
            try { body = JsonDocument.Parse(text).RootElement.Clone(); } catch { /* not JSON */ }
            return res.IsSuccessStatusCode ? new(true, (int)res.StatusCode, body, null) : new(false, (int)res.StatusCode, body, TrayProtocol.ErrorText(body, (int)res.StatusCode));
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception e) { return new(false, 0, null, $"Support could not be reached ({e.GetType().Name})."); }
    }

    private static HttpRequestMessage Post(string url, object body) =>
        new(HttpMethod.Post, url) { Content = new StringContent(JsonSerializer.Serialize(body, TrayProtocol.Json), Encoding.UTF8, "application/json") };
}

/// <summary>The local pipe: one request line in, one answer line out, many at a time, each limited in size and time.</summary>
internal sealed class TrayPipeServer
{
    private readonly string _name;
    private readonly Func<TrayProtocol.Request, CancellationToken, Task<TrayProtocol.Response>> _handler;
    private readonly ILogger? _log;
    private readonly SemaphoreSlim _busy = new(8);

    public TrayPipeServer(string name, Func<TrayProtocol.Request, CancellationToken, Task<TrayProtocol.Response>> handler, ILogger? log = null)
    {
        _name = name; _handler = handler; _log = log;
    }

    public static PipeSecurity Security()
    {
        var s = new PipeSecurity();
        // people signed in to this computer may use it; the network may not, and SYSTEM and administrators have full control
        s.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        s.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        s.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        s.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        // the account that runs it (a test, or the agent when it is not SYSTEM) must be able to make further instances of the pipe
        var self = WindowsIdentity.GetCurrent().User;
        if (self is not null) s.AddAccessRule(new PipeAccessRule(self, PipeAccessRights.FullControl, AccessControlType.Allow));
        return s;
    }

    private NamedPipeServerStream CreateInstance(bool first) =>
        NamedPipeServerStreamAcl.Create(_name, PipeDirection.InOut, 16, PipeTransmissionMode.Byte,
            first ? PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance : PipeOptions.Asynchronous, 0, 0, Security());

    public async Task RunAsync(CancellationToken stop)
    {
        // The name must never be free while the agent runs, or a local user could create the pipe first and pose as the agent.
        // So the first instance is made with FirstPipeInstance (it fails when someone else holds the name), and every later one
        // is made while one of ours still exists: the next listener is created before the connected one is handed off.
        NamedPipeServerStream? next = null;
        try
        {
            while (!stop.IsCancellationRequested)
            {
                NamedPipeServerStream? server = null;
                try
                {
                    server = next ?? CreateInstance(first: true);
                    next = null;
                    await server.WaitForConnectionAsync(stop).ConfigureAwait(false);
                    try { next = CreateInstance(first: false); }
                    catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                    {
                        // the next round starts over with FirstPipeInstance once the open connections are done
                        _log?.LogWarning(e, "Tray pipe: could not make the next listener; starting over shortly.");
                    }
                    var s = server;
                    server = null;
                    _ = Task.Run(() => HandleAsync(s, stop), stop);
                }
                catch (OperationCanceledException) { server?.Dispose(); break; }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    // Either our own connections still hold the name (they end within 30 seconds), or another process has taken it.
                    _log?.LogWarning(e, "Tray pipe: the pipe name {Name} is in use (by an open tray request or by another process); not listening, trying again shortly.", _name);
                    server?.Dispose();
                    try { await Task.Delay(TimeSpan.FromSeconds(5), stop).ConfigureAwait(false); } catch (OperationCanceledException) { break; }
                }
                catch (Exception e)
                {
                    _log?.LogWarning(e, "Tray pipe: could not listen; trying again shortly.");
                    server?.Dispose();
                    try { await Task.Delay(TimeSpan.FromSeconds(5), stop).ConfigureAwait(false); } catch (OperationCanceledException) { break; }
                }
            }
        }
        finally
        {
            next?.Dispose();
        }
    }

    private async Task HandleAsync(NamedPipeServerStream pipe, CancellationToken stop)
    {
        if (!await _busy.WaitAsync(0).ConfigureAwait(false)) { pipe.Dispose(); return; }
        try
        {
            using (pipe)
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(stop);
                cts.CancelAfter(TimeSpan.FromSeconds(30));
                var request = await ReadLineAsync(pipe, TrayProtocol.MaxRequestBytes, cts.Token).ConfigureAwait(false);
                TrayProtocol.Response answer;
                if (request is null) answer = new(false, 400, null, "That request is too large or empty.");
                else
                {
                    TrayProtocol.Request? req = null;
                    try { req = JsonSerializer.Deserialize<TrayProtocol.Request>(request, TrayProtocol.Json); } catch { /* answered below */ }
                    var bad = TrayProtocol.Validate(req);
                    answer = bad is not null ? new(false, 400, null, bad) : await _handler(req!, cts.Token).ConfigureAwait(false);
                }
                var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(answer, TrayProtocol.Json) + "\n");
                await pipe.WriteAsync(bytes, cts.Token).ConfigureAwait(false);
                await pipe.FlushAsync(cts.Token).ConfigureAwait(false);
                try { pipe.WaitForPipeDrain(); } catch { /* the other side already left */ }
            }
        }
        catch (Exception e) when (e is OperationCanceledException or IOException) { /* the tray went away; nothing to answer */ }
        catch (Exception e) { _log?.LogDebug(e, "Tray pipe request failed."); }
        finally { _busy.Release(); }
    }

    /// <summary>One line, no longer than <paramref name="max"/> bytes, or null when it is longer or there is none.</summary>
    internal static async Task<string?> ReadLineAsync(Stream s, int max, CancellationToken ct)
    {
        var buf = new byte[max + 1];
        var n = 0;
        while (n < buf.Length)
        {
            var read = await s.ReadAsync(buf.AsMemory(n, buf.Length - n), ct).ConfigureAwait(false);
            if (read == 0) break;
            n += read;
            if (Array.IndexOf(buf, (byte)'\n', 0, n) >= 0) break;
        }
        if (n == 0 || n > max) return null;
        var text = Encoding.UTF8.GetString(buf, 0, n);
        var nl = text.IndexOf('\n');
        return (nl >= 0 ? text[..nl] : text).Trim();
    }
}

internal sealed class TrayBridgeService : BackgroundService
{
    private readonly ConfigService _cfg;
    private readonly ILogger<TrayBridgeService> _log;
    private readonly TrayForwarder _forward;
    private readonly TrayPipeServer _pipe;
    private readonly Dictionary<int, int> _launched = new();   // session id -> process id

    public TrayBridgeService(ConfigService cfg, PinnedHttpClientFactory http, ILogger<TrayBridgeService> log)
    {
        _cfg = cfg; _log = log;
        _forward = new TrayForwarder(() => (_cfg.Current.ApiBaseUrl, _cfg.Current.AgentKey), () => http.Create());
        // a different pipe name is for tests only, and is read from the environment of the service
        var custom = Environment.GetEnvironmentVariable("REMOTEIQ_TRAY_PIPE");
        _pipe = new TrayPipeServer(string.IsNullOrWhiteSpace(custom) ? TrayProtocol.PipeName : custom, HandleAsync, log);
    }

    private DateTime _lastRestart = DateTime.MinValue;

    /// <summary>What a person at the device may ask: the four things for the server, and a restart of this agent. Nothing here can stop it.</summary>
    private Task<TrayProtocol.Response> HandleAsync(TrayProtocol.Request r, CancellationToken ct)
    {
        if (r.Op != TrayProtocol.OpRestart) return _forward.ForwardAsync(r, ct);
        if (DateTime.UtcNow - _lastRestart < TimeSpan.FromSeconds(60))
            return Task.FromResult(new TrayProtocol.Response(false, 429, null, "The agent was just restarted. Please wait a minute."));
        _lastRestart = DateTime.UtcNow;
        try
        {
            // A separate process does the stop and start, because this one is what is being stopped. It keeps running when the service ends.
            var psi = new System.Diagnostics.ProcessStartInfo("cmd.exe", "/c ping -n 4 127.0.0.1 >nul & net stop RemoteIQAgent & net start RemoteIQAgent") { UseShellExecute = false, CreateNoWindow = true };
            using var _ = System.Diagnostics.Process.Start(psi);
            _log.LogInformation("The agent was asked to restart from the tray.");
            return Task.FromResult(new TrayProtocol.Response(true, 200, null, null));
        }
        catch (Exception e)
        {
            _log.LogWarning(e, "Could not restart the agent from the tray.");
            return Task.FromResult(new TrayProtocol.Response(false, 500, null, "The agent could not be restarted."));
        }
    }

    /// <summary>The service's permissions, set again at every start: the system and administrators control it, ordinary users may only look at it.</summary>
    private void HardenService()
    {
        try
        {
            // SY: everything usual. BA: everything. IU and SU (signed-in and service users): read, query and interrogate only, no stop, pause or start.
            const string sddl = "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)";
            var psi = new System.Diagnostics.ProcessStartInfo("sc.exe", $"sdset RemoteIQAgent {sddl}") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            using var p = System.Diagnostics.Process.Start(psi);
            p?.WaitForExit(10_000);
        }
        catch (Exception e) { _log.LogDebug(e, "Could not set the service permissions."); }
    }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("REMOTEIQ_TRAY_PIPE"))) HardenService();
        var listen = Task.Run(() => _pipe.RunAsync(stop), stop);
        var launch = Task.Run(() => LaunchLoopAsync(stop), stop);
        await Task.WhenAll(listen, launch).ConfigureAwait(false);
    }

    private async Task LaunchLoopAsync(CancellationToken stop)
    {
        // a moment after start-up, so the agent is enrolled and settled, then every minute
        try { await Task.Delay(TimeSpan.FromSeconds(20), stop).ConfigureAwait(false); } catch (OperationCanceledException) { return; }
        while (!stop.IsCancellationRequested)
        {
            try { await EnsureTraysAsync(stop).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
            catch (Exception e) { _log.LogDebug(e, "Tray launch check failed."); }
            try { await Task.Delay(TimeSpan.FromSeconds(60), stop).ConfigureAwait(false); } catch (OperationCanceledException) { break; }
        }
    }

    private async Task EnsureTraysAsync(CancellationToken stop)
    {
        var status = await _forward.ForwardAsync(new(TrayProtocol.OpStatus, null, null, false, null), stop).ConfigureAwait(false);
        var on = status.Ok && status.Body is { ValueKind: JsonValueKind.Object } b && b.TryGetProperty("enabled", out var e) && e.ValueKind == JsonValueKind.True;
        if (!on) return;
        var exe = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exe)) return;
        foreach (var s in UserSessions.ActiveSessions())
        {
            if (_launched.TryGetValue(s.Id, out var pid) && Alive(pid, s.Id)) continue;
            try
            {
                var started = UserSessions.Launch(s.Id, exe, "--tray");
                _launched[s.Id] = started;
                _log.LogInformation("Tray app started for {Account} (session {Session}).", s.Account, s.Id);
            }
            catch (Exception ex) { _log.LogWarning(ex, "Could not start the tray app for {Account}.", s.Account); }
        }
    }

    private static bool Alive(int pid, int session)
    {
        try { using var p = System.Diagnostics.Process.GetProcessById(pid); return !p.HasExited && p.SessionId == session; }
        catch { return false; }
    }
}
