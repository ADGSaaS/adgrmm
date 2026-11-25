// agents/windows/RemoteIQ.Agent/Services/RemoteConsoleWorker.cs

using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace RemoteIQ.Agent.Services;

public sealed class RemoteConsoleWorker : BackgroundService
{
    private readonly ConcurrentDictionary<string, IReadOnlyList<ConsoleIceServer>?> _sessionIce = new();

    private readonly ConfigService _cfg;
    private readonly IWebRtcConsolePeerFactory _peerFactory;
    private readonly CryptoService _crypto;
    private readonly ILogger<RemoteConsoleWorker> _log;

    private readonly ConcurrentDictionary<string, IWebRtcConsolePeer> _peers = new();

    // Sessions whose start is signed but not yet allowed by the person at the device.
    private readonly ConcurrentDictionary<string, ConsentGate> _awaitingConsent = new();
    private const int ConsentSeconds = 30;
    private const int NoticeSeconds = 20;

    // How long the user's own helper gets to start before Windows' plain prompt is used instead.
    private const int HelperStartMs = 12_000;
    private const int MaxHeldSignals = 200;

    private readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public RemoteConsoleWorker(
        ConfigService cfg,
        IWebRtcConsolePeerFactory peerFactory,
        CryptoService crypto,
        ILogger<RemoteConsoleWorker> log)
    {
        _cfg = cfg;
        _peerFactory = peerFactory;
        _crypto = crypto;
        _log = log;
    }

    /// <summary>
    /// Windows checks a program the first time it runs, which took 24 seconds on a test machine for the
    /// capture helper. Running it once now means that wait does not fall on the first session. With no
    /// arguments the helper exits straight away, without touching the screen.
    /// </summary>
    private void PreloadCaptureHelper(CancellationToken ct)
    {
        try
        {
            var installDir = Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;
            var helper = Path.Combine(installDir, "tools", "capture-helper", "RemoteIQ.CaptureHelper.exe");
            if (!File.Exists(helper)) return;

            var started = Environment.TickCount64;
            using var process = Process.Start(new ProcessStartInfo(helper) { UseShellExecute = false, CreateNoWindow = true });
            if (process is null) return;

            while (!process.WaitForExit(1000))
            {
                if (ct.IsCancellationRequested || Environment.TickCount64 - started > 180_000)
                {
                    process.Kill();
                    return;
                }
            }
            _log.LogInformation("RemoteConsole capture helper preloaded in {Ms} ms", Environment.TickCount64 - started);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "RemoteConsole could not preload the capture helper");
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _ = Task.Run(() => PreloadCaptureHelper(stoppingToken), stoppingToken);
        _ = Task.Run(() => CheckH264Async(stoppingToken), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            if (string.IsNullOrWhiteSpace(_cfg.Current.AgentId) ||
                string.IsNullOrWhiteSpace(_cfg.Current.AgentKey) ||
                string.IsNullOrWhiteSpace(_cfg.Current.ApiBaseUrl))
            {
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
                continue;
            }

            var wsUri = BuildWsUri(_cfg.Current.ApiBaseUrl, "/ws/remote-console");
            if (wsUri is null)
            {
                _log.LogError("RemoteConsole invalid ApiBaseUrl for WS: {ApiBaseUrl}", _cfg.Current.ApiBaseUrl);
                await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
                continue;
            }

            using var ws = new ClientWebSocket();
            ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);

            try
            {
                await ws.ConnectAsync(wsUri, stoppingToken);
                _log.LogInformation("RemoteConsole WS connected: {Uri}", wsUri);

                // hello as agent (matches backend RemoteConsoleService)
                await SendJsonAsync(ws, new
                {
                    type = "hello",
                    kind = "agent",
                    agentUuid = _cfg.Current.AgentId.Trim(),
                    agentToken = _cfg.Current.AgentKey.Trim(),
                }, stoppingToken);

                await ReceiveLoop(ws, stoppingToken);

                // A clean close from the server or a proxy also ends every session on this socket.
                // Without this, capture helpers kept running and the agent reconnected in a tight loop.
                await CleanupAllPeers("ws_closed");
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (WebSocketException wse)
            {
                _log.LogWarning(wse, "RemoteConsole WS error; reconnecting in 5s");
                await CleanupAllPeers("ws_error");
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "RemoteConsole WS error; reconnecting in 5s");
                await CleanupAllPeers("ws_error");
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }

        await CleanupAllPeers("service_stop");
    }

    private async Task ReceiveLoop(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];

        while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
        {
            using var ms = new System.IO.MemoryStream();
            WebSocketReceiveResult? res;

            do
            {
                res = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);

                if (res.MessageType == WebSocketMessageType.Close)
                {
                    try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "closing", CancellationToken.None); }
                    catch { }
                    return;
                }

                if (res.Count > 0)
                    ms.Write(buffer, 0, res.Count);

            } while (!res.EndOfMessage);

            if (ms.Length == 0) continue;
            if (res.MessageType != WebSocketMessageType.Text) continue;

            var text = Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
            if (string.IsNullOrWhiteSpace(text)) continue;

            await HandleServerMessage(ws, text, ct);
        }
    }

    private async Task HandleServerMessage(ClientWebSocket ws, string text, CancellationToken ct)
    {
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;

            if (!root.TryGetProperty("type", out var typeEl)) return;
            var type = typeEl.GetString() ?? "";

            if (type == "ping")
            {
                var ts = root.TryGetProperty("ts", out var tsEl) && tsEl.ValueKind == JsonValueKind.Number
                    ? tsEl.GetInt64()
                    : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                await SendJsonAsync(ws, new { type = "pong", ts }, ct);
                return;
            }

            if (type == "hello.ok" || type == "hello.error")
            {
                _log.LogInformation("RemoteConsole hello response: {Text}", text);
                return;
            }

            if (type == "session.ready")
            {
                var sessionId = ReadString(root, "sessionId");
                if (string.IsNullOrWhiteSpace(sessionId)) return;

                var opened = _crypto.OpenSessionStart(root, "console", sessionId, out var refusal);
                if (opened is null)
                {
                    _log.LogWarning("RemoteConsole refused session {SessionId}: {Reason}", sessionId, refusal);
                    await SendJsonAsync(ws, new { type = "session.refused", sessionId, reason = refusal }, ct);
                    return;
                }

                _sessionIce[sessionId] = ReadIceServers(root);

                // Read from the signed part, so it cannot be changed on the way. A start without it, from an
                // older server, behaves as before. Nobody signed in means nobody to ask, so unattended access
                // keeps working.
                var consent = ReadString(opened.Value, "consent") ?? "";

                // From the signed part, like the consent mode. A start without it (an older server) means Auto.
                ConsoleVideoPolicy.SetForSession(sessionId, ConsoleVideoPolicy.Parse(ReadString(opened.Value, "videoCodec")));
                var technician = ReadString(opened.Value, "technician");

                if (consent == "consent" && ConsoleSessions.SomeoneSignedIn())
                {
                    _awaitingConsent[sessionId] = new ConsentGate();
                    _log.LogInformation("RemoteConsole session {SessionId} is waiting for the person at the device", sessionId);
                    await SendJsonAsync(ws, new { type = "session.waiting", sessionId, message = "Waiting for the person at the device to allow the connection…" }, ct);
                    _ = Task.Run(() => AskThenStartAsync(ws, sessionId, technician, ct), CancellationToken.None);
                    return;
                }

                if (consent == "notice")
                {
                    _ = Task.Run(() => ShowNoticeAsync(sessionId, technician), CancellationToken.None);
                    RegisterIndicator(ws, sessionId, technician, ct);
                }

                EnsurePeer(sessionId, ws, ct);
                _log.LogInformation("RemoteConsole session ready: {SessionId}", sessionId);
                return;
            }

            if (type == "session.closed")
            {
                var sessionId = ReadString(root, "sessionId");
                var reason = ReadString(root, "reason") ?? "closed";
                if (!string.IsNullOrWhiteSpace(sessionId))
                {
                    _awaitingConsent.TryRemove(sessionId, out _);
                    _sessionIce.TryRemove(sessionId, out _);
                    await RemovePeer(sessionId, $"server_closed:{reason}", ct);
                }
                return;
            }

            if (type == "signal")
            {
                var sessionId = ReadString(root, "sessionId");
                if (string.IsNullOrWhiteSpace(sessionId)) return;

                if (!root.TryGetProperty("data", out var dataEl)) return;

                // ✅ IMPORTANT: Clone the JsonElement so it survives beyond this JsonDocument's lifetime.
                // This prevents subtle signaling failures if the peer processes the payload asynchronously.
                if (dataEl.ValueKind == JsonValueKind.Undefined || dataEl.ValueKind == JsonValueKind.Null) return;
                var cloned = dataEl.Clone();

                // While the person at the device is deciding, the technician's offer and candidates are held,
                // and replayed in order if they allow it.
                if (_awaitingConsent.TryGetValue(sessionId, out var gate))
                {
                    lock (gate.Lock)
                    {
                        if (!gate.Open)
                        {
                            if (gate.Held.Count < MaxHeldSignals) gate.Held.Add(cloned);
                            return;
                        }
                    }
                }

                // A peer only exists once its session start has been verified, so signaling cannot start one.
                if (!_peers.TryGetValue(sessionId, out var peer))
                {
                    _log.LogDebug("RemoteConsole ignored a signal for session {SessionId}, which has not started", sessionId);
                    return;
                }
                await peer.HandleSignalAsync((object)cloned, ct);
                return;
            }
        }
        catch (JsonException)
        {
            // ignore
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "RemoteConsole HandleServerMessage error");
        }
    }

    /// <summary>
    /// Asks the person at the device, and starts the session only if they allow it. Declining, or not
    /// answering in time, refuses it, and the technician is told which.
    /// </summary>
    private async Task AskThenStartAsync(ClientWebSocket ws, string sessionId, string? technician, CancellationToken ct)
    {
        try
        {
            var answer = await AskThePersonAsync(sessionId, technician);

            // Closed while the question was on screen.
            if (!_awaitingConsent.TryGetValue(sessionId, out var gate)) return;

            if (answer == ConsoleSessions.ConsentAnswer.Allowed)
            {
                _log.LogInformation("RemoteConsole session {SessionId} was allowed by the person at the device", sessionId);
                RegisterIndicator(ws, sessionId, technician, ct);
                var peer = EnsurePeer(sessionId, ws, ct);

                // Signals can still arrive while the held ones are replayed, so it only opens once none are left.
                while (true)
                {
                    JsonElement[] batch;
                    lock (gate.Lock)
                    {
                        if (gate.Held.Count == 0)
                        {
                            gate.Open = true;
                            break;
                        }
                        batch = gate.Held.ToArray();
                        gate.Held.Clear();
                    }
                    foreach (var signal in batch) await peer.HandleSignalAsync((object)signal, ct);
                }

                _awaitingConsent.TryRemove(sessionId, out _);
                return;
            }

            _awaitingConsent.TryRemove(sessionId, out _);
            _sessionIce.TryRemove(sessionId, out _);

            // The session will not start, so the helper that asked is not needed any more.
            SipsorceryWebRtcConsolePeer.ReleaseUserHelper(sessionId);

            var reason = answer switch
            {
                ConsoleSessions.ConsentAnswer.Declined => "The person at the device declined the request.",
                ConsoleSessions.ConsentAnswer.NoAnswer => "Nobody at the device answered the request, so it was refused.",
                _ => "The request could not be shown on the device, so it was refused.",
            };
            _log.LogWarning("RemoteConsole refused session {SessionId}: {Reason}", sessionId, reason);
            await SendJsonAsync(ws, new { type = "session.refused", sessionId, reason }, ct);
        }
        catch (Exception ex)
        {
            // Failing closed: a question that could not be settled must not become a session.
            _awaitingConsent.TryRemove(sessionId, out _);
            _log.LogWarning(ex, "RemoteConsole could not ask about session {SessionId}", sessionId);
            try { await SendJsonAsync(ws, new { type = "session.refused", sessionId, reason = "The request could not be put to the person at the device, so it was refused." }, ct); } catch { /* the connection is gone */ }
        }
    }

    /// <summary>
    /// Puts the question in the styled window of the helper that belongs to the signed-in user. If that helper
    /// cannot be started in time, Windows' own prompt asks instead, so a question is never dropped, and an
    /// answer that cannot be read counts as no.
    /// </summary>
    private async Task<ConsoleSessions.ConsentAnswer> AskThePersonAsync(string sessionId, string? technician)
    {
        string? styled = null;
        try
        {
            styled = await SipsorceryWebRtcConsolePeer.AskConsentThroughHelperAsync(sessionId, _log, technician, ConsentSeconds, HelperStartMs)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "RemoteConsole could not ask in the styled window session={SessionId}", sessionId);
        }

        if (styled is null)
        {
            _log.LogWarning("RemoteConsole asking with Windows' own prompt instead, because the helper did not start in time session={SessionId}", sessionId);
            return await Task.Run(() => ConsoleSessions.AskToAllow(technician, ConsentSeconds)).ConfigureAwait(false);
        }

        return styled switch
        {
            "allow" => ConsoleSessions.ConsentAnswer.Allowed,
            "deny" => ConsoleSessions.ConsentAnswer.Declined,
            _ => ConsoleSessions.ConsentAnswer.NoAnswer,
        };
    }

    /// <summary>Tells the person who connected, in the styled window, or in Windows' own message if that cannot be shown in time.</summary>
    private async Task ShowNoticeAsync(string sessionId, string? technician)
    {
        var shown = false;
        try
        {
            shown = await SipsorceryWebRtcConsolePeer.ShowNoticeThroughHelperAsync(sessionId, _log, technician, NoticeSeconds, HelperStartMs).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "RemoteConsole could not show the notice in the styled window session={SessionId}", sessionId);
        }

        if (!shown) ConsoleSessions.TellSomeoneConnected(technician, NoticeSeconds);
    }

    /// <summary>Has the live-session indicator shown on the person's screen, with a button that ends the session.</summary>
    private void RegisterIndicator(ClientWebSocket ws, string sessionId, string? technician, CancellationToken ct)
        => SessionIndicator.Register(sessionId, technician, () => _ = Task.Run(() => EndFromDeviceAsync(ws, sessionId, ct), CancellationToken.None));

    /// <summary>The person at the device pressed End session. The technician is told, and the session is closed here and at the server.</summary>
    private async Task EndFromDeviceAsync(ClientWebSocket ws, string sessionId, CancellationToken ct)
    {
        _log.LogInformation("RemoteConsole session {SessionId} was ended by the person at the device", sessionId);
        try { await SendJsonAsync(ws, new { type = "session.end", sessionId, reason = "ended_at_device" }, ct); }
        catch { /* the connection to the server is gone, and the session with it */ }

        SessionIndicator.Forget(sessionId);
        await RemovePeer(sessionId, "ended_at_device", ct);
    }

    private sealed class ConsentGate
    {
        public readonly object Lock = new();
        public readonly List<JsonElement> Held = new();
        public bool Open;
    }

    // One STUN and the plain relays, on whatever port the relay uses. Each URL is its own entry, and TLS adds nothing here.
    private static IReadOnlyList<ConsoleIceServer>? ReadIceServers(JsonElement root)
    {
        if (!root.TryGetProperty("iceServers", out var servers) || servers.ValueKind != JsonValueKind.Array) return null;

        var result = new List<ConsoleIceServer>();
        foreach (var server in servers.EnumerateArray())
        {
            var username = ReadString(server, "username");
            var credential = ReadString(server, "credential");
            if (!server.TryGetProperty("urls", out var urls)) continue;

            var list = urls.ValueKind == JsonValueKind.Array
                ? urls.EnumerateArray().Select(u => u.GetString() ?? "")
                : new[] { urls.GetString() ?? "" };

            foreach (var url in list)
            {
                if (url.StartsWith("stun:", StringComparison.OrdinalIgnoreCase))
                {
                    if (!result.Any(r => r.Url.StartsWith("stun:", StringComparison.OrdinalIgnoreCase)))
                        result.Add(new ConsoleIceServer(url, null, null));
                }
                else if (url.StartsWith("turn:", StringComparison.OrdinalIgnoreCase))
                {
                    result.Add(new ConsoleIceServer(url, username, credential));
                }
            }
        }
        if (result.Count == 0) return null;

        // The ICE agent settles on one server, so a relay has to come ahead of plain STUN to be used.
        // A relay also reports the public address, so nothing is lost by this order.
        return result
            .OrderBy(r => r.Url.Contains("transport=udp", StringComparison.OrdinalIgnoreCase) ? 0
                : r.Url.StartsWith("turn:", StringComparison.OrdinalIgnoreCase) ? 1
                : 2)
            .ToList();
    }

    /// <summary>
    /// The H.264 start-up check, run once shortly after the agent starts, in a separate process. Until it has finished, and
    /// whenever it finds nothing usable, every session is VP8. A device switched to VP8 (REMOTE_CONSOLE_VIDEO_CODEC=vp8) never runs it.
    /// </summary>
    private async Task CheckH264Async(CancellationToken ct)
    {
        try
        {
            if (ConsoleVideoPolicy.Parse(Environment.GetEnvironmentVariable("REMOTE_CONSOLE_VIDEO_CODEC")) == ConsoleVideoCodecSetting.Vp8 &&
                !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("REMOTE_CONSOLE_VIDEO_CODEC")))
                return;

            await Task.Delay(TimeSpan.FromSeconds(15), ct).ConfigureAwait(false);
            var result = await H264Support.ProbeAsync(() => H264SelfTest.RunInChildAsync(Environment.ProcessPath, TimeSpan.FromSeconds(60))).ConfigureAwait(false);
            _log.LogInformation("RemoteConsole H.264 start-up check: available={Available} hardware={Hardware} encoder={Name} detail={Detail}",
                result.Available, result.Hardware, result.Name, result.Detail);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "RemoteConsole H.264 start-up check could not run");
        }
    }

    private IWebRtcConsolePeer EnsurePeer(string sessionId, ClientWebSocket ws, CancellationToken ct)
    {
        return _peers.GetOrAdd(sessionId, sid =>
        {
            _sessionIce.TryRemove(sid, out var ice);
            var p = _peerFactory.Create(sid, ice);

            // ✅ CRITICAL: register peer so RemoteConsoleTunnelWorker can attach PowerShell
            RemoteConsoleTunnelWorker.ActivePeers[sid] = p;

            // The peer tells us what signaling messages to send back to the backend WS.
            p.OnSignalToSend += (signalObj) =>
            {
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await SendJsonAsync(ws, new
                        {
                            type = "signal",
                            sessionId = sid,
                            data = signalObj
                        }, ct);
                    }
                    catch
                    {
                        // ignore
                    }
                }, CancellationToken.None);
            };

            return p;
        });
    }

    private async Task RemovePeer(string sessionId, string reason, CancellationToken ct)
    {
        SessionIndicator.Forget(sessionId);
        SipsorceryWebRtcConsolePeer.ReleaseUserHelper(sessionId);
        if (_peers.TryRemove(sessionId, out var peer))
        {
            // ✅ unregister tunnel peer
            try { RemoteConsoleTunnelWorker.ActivePeers.TryRemove(sessionId, out _); } catch { }

            try { await peer.CloseAsync(reason, ct); } catch { }
            try { await peer.DisposeAsync(); } catch { }
        }
        else
        {
            // still ensure registry is clean
            try { RemoteConsoleTunnelWorker.ActivePeers.TryRemove(sessionId, out _); } catch { }
        }
    }

    private async Task CleanupAllPeers(string reason)
    {
        foreach (var kv in _peers)
        {
            var sid = kv.Key;
            var peer = kv.Value;

            // ✅ unregister tunnel peer
            try { RemoteConsoleTunnelWorker.ActivePeers.TryRemove(sid, out _); } catch { }

            try { await peer.CloseAsync(reason, CancellationToken.None); } catch { }
            try { await peer.DisposeAsync(); } catch { }
        }
        _peers.Clear();
        _awaitingConsent.Clear();

        // ✅ hard clear registry too (safety)
        try { RemoteConsoleTunnelWorker.ActivePeers.Clear(); } catch { }
    }

    private static Uri? BuildWsUri(string apiBaseUrl, string wsPath)
    {
        if (string.IsNullOrWhiteSpace(apiBaseUrl)) return null;
        if (!Uri.TryCreate(apiBaseUrl, UriKind.Absolute, out var u)) return null;

        var scheme = u.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws";

        var b = new UriBuilder(u)
        {
            Scheme = scheme,
            Path = wsPath,
            Query = ""
        };

        return b.Uri;
    }

    private async Task SendJsonAsync(ClientWebSocket ws, object payload, CancellationToken ct)
    {
        if (ws.State != WebSocketState.Open) return;

        var json = JsonSerializer.Serialize(payload, _json);
        var bytes = Encoding.UTF8.GetBytes(json);

        await ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, cancellationToken: ct);
    }

    private static string? ReadString(JsonElement obj, string prop)
    {
        if (!obj.TryGetProperty(prop, out var el)) return null;
        return el.ValueKind == JsonValueKind.String ? el.GetString() : el.ToString();
    }
}
