// A test lab for the remote video over a bad network.
//
// The agent's real remote console peer is connected to a real Chromium browser (Edge, headless)
// that does what the technician's browser does: it asks for the video, sends the feedback a browser sends (NACK, picture loss, bandwidth reports)
// and keeps statistics. Between them every media packet goes through a UDP proxy that can lose packets, add delay and cap the rate, in both
// directions, so a change to the video path can be measured under the same conditions as before (a Pion based engine was compared this way and
// removed: it was level with this one on loss and capped links and won nowhere; see the roadmap, 1.24).
//
//   cd agents/tests/LossLab && dotnet run -c Release -- [--seconds 25] [--only clean,loss3]
//
// It captures this computer's screen (to the proxy on this computer only) and a moving picture is needed for the test to mean anything:
// agents/.../motion.ps1 style animation is started by the lab itself.
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using RemoteIQ.Agent.Services;

[DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
timeBeginPeriod(1);

var seconds = int.TryParse(args.SkipWhile(a => a != "--seconds").Skip(1).FirstOrDefault(), out var sec) ? sec : 25;
var only = (args.SkipWhile(a => a != "--only").Skip(1).FirstOrDefault() ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries);
var engines = new[] { "builtin" };

Environment.SetEnvironmentVariable("REMOTE_CONSOLE_VIDEO_MAX_DIM", "1280");
Environment.SetEnvironmentVariable("REMOTE_CONSOLE_VIDEO_CODEC", "vp8");
Environment.SetEnvironmentVariable("REMOTE_CONSOLE_STUN", "stun:127.0.0.1:9");

var edge = new[] { @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", @"C:\Program Files\Google\Chrome\Application\chrome.exe" }.FirstOrDefault(File.Exists);
if (edge == null) { Console.WriteLine("no Edge or Chrome found"); return 1; }
var lan = Dns.GetHostEntry(Dns.GetHostName()).AddressList.First(a => a.AddressFamily == AddressFamily.InterNetwork && a.ToString().StartsWith("192.168."));

// the impairments: name, loss (0..1), one-way delay ms, downlink rate cap in kbit/s (0 = none)
var scenarios = new (string Name, double Loss, int DelayMs, int CapKbps)[]
{
    ("clean", 0, 0, 0),
    ("loss1", 0.01, 20, 0),
    ("loss3", 0.03, 20, 0),
    ("loss6", 0.06, 40, 0),
    ("cap3000", 0, 30, 3000),
    ("cap1200", 0.005, 30, 1200),
}.Where(s => only.Length == 0 || only.Contains(s.Name)).ToArray();

using var loggerFactory = LoggerFactory.Create(b => b.AddSimpleConsole(o => o.SingleLine = true).SetMinimumLevel(LogLevel.Error));

const string Page = """
<!doctype html><meta charset=utf-8><body><video id=v autoplay muted playsinline></video><script>
(async () => {
  const post = (u, o) => fetch(u, { method: 'POST', body: JSON.stringify(o) });
  window.onerror = (m) => post('/log', { error: String(m) }); window.onunhandledrejection = (e) => post('/log', { error: String(e.reason) });
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTransceiver('video', { direction: 'recvonly' });
  const dc = pc.createDataChannel('rc.control');
  pc.ontrack = e => { document.getElementById('v').srcObject = new MediaStream([e.track]); };
  pc.onicecandidate = e => { if (e.candidate) post('/browser-cand', e.candidate.toJSON()); };
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  await post('/offer', { type: 'offer', sdp: offer.sdp });
  let answered = false; const pending = [];
  setInterval(async () => {
    const msgs = await (await fetch('/poll')).json();
    for (const m of msgs) {
      if (m.type === 'answer') { try { await pc.setRemoteDescription(m); } catch (e) { post('/log', { setRemote: String(e) }); } answered = true; for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {}); }
      else if (m.candidate) { if (answered) await pc.addIceCandidate(m).catch(e => post('/log', { addIce: String(e) })); else pending.push(m); }
    }
  }, 100);
  setInterval(async () => {
    const st = await pc.getStats(); let inb = null, pair = null;
    st.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r; if (r.type === 'candidate-pair' && r.nominated) pair = r; });
    if (inb) post('/stats', { t: Date.now(), state: pc.connectionState, frames: inb.framesDecoded, bytes: inb.bytesReceived, jb: inb.jitterBufferDelay, jbn: inb.jitterBufferEmittedCount,
      lost: inb.packetsLost, rcv: inb.packetsReceived, nack: inb.nackCount, pli: inb.pliCount, fir: inb.firCount, fz: inb.freezeCount, fzd: inb.totalFreezesDuration, w: inb.frameWidth, h: inb.frameHeight, rtt: pair?.currentRoundTripTime, dropped: inb.framesDropped });
  }, 1000);
})();
</script>
""";

// ---------------------------------------------------------------- one scenario with one engine
async Task<string> RunAsync(string engine, (string Name, double Loss, int DelayMs, int CapKbps) sc)
{
        var peer = new SipsorceryWebRtcConsolePeer($"lab-{engine}-{sc.Name}", loggerFactory.CreateLogger("peer"), null);
    var toPage = new ConcurrentQueue<object>();
    var stats = new List<JsonElement>();
    var rnd = new Random(12345);

    // ----- the proxy: A faces the browser (its address stands in for the agent), B faces the agent (its address stands in for the browser)
    var a = new UdpClient(new IPEndPoint(IPAddress.Any, 0));
    var b = new UdpClient(new IPEndPoint(IPAddress.Any, 0));
    var candIp = lan.ToString();
    var aPort = ((IPEndPoint)a.Client.LocalEndPoint!).Port; var bPort = ((IPEndPoint)b.Client.LocalEndPoint!).Port;
    IPEndPoint? browserEp = null, agentEp = null;
    long downLastDepart = 0, upLastDepart = 0; var clock = Stopwatch.StartNew();
    long dropped = 0, forwarded = 0;
    var downLine = new BlockingCollection<(double Due, UdpClient Via, IPEndPoint To, byte[] Data)>();
    var upLine = new BlockingCollection<(double Due, UdpClient Via, IPEndPoint To, byte[] Data)>();
    foreach (var line in new[] { downLine, upLine })
    {
        var l = line;
        new Thread(() =>
        {
            foreach (var item in l.GetConsumingEnumerable())
            {
                for (var now = clock.Elapsed.TotalMilliseconds; item.Due - now > 0; now = clock.Elapsed.TotalMilliseconds)
                    if (item.Due - now > 2) Thread.Sleep(1); else Thread.SpinWait(200);
                try { item.Via.Send(item.Data, item.Data.Length, item.To); } catch { }
            }
        }) { IsBackground = true, Priority = ThreadPriority.AboveNormal }.Start();
    }
    var cts = new CancellationTokenSource();
    var lockDown = new object();
    void Forward(UdpClient via, IPEndPoint to, byte[] data, bool downlink)
    {
        // loss (the first STUN/DTLS packets are spared so the connection can be made in the first seconds)
        if (clock.ElapsedMilliseconds > 4000 && sc.Loss > 0 && rnd.NextDouble() < sc.Loss) { Interlocked.Increment(ref dropped); return; }
        double wait = sc.DelayMs;
        if (downlink && sc.CapKbps > 0 && clock.ElapsedMilliseconds > 4000)
        {
            lock (lockDown)
            {
                var now = clock.Elapsed.TotalMilliseconds;
                var depart = Math.Max(now, downLastDepart) + data.Length * 8.0 / sc.CapKbps; // ms
                if (depart - now > 150) { Interlocked.Increment(ref dropped); return; }        // a queue of 150 ms is full: tail drop
                downLastDepart = (long)depart; wait += depart - now;
            }
        }
        Interlocked.Increment(ref forwarded);
        // Delivered in order: one queue per direction, released at the due time. (Scheduling each packet with its own timer lets packets sent a
        // few microseconds apart overtake each other, which punishes a sender that sends in bursts and would not happen on a real link.)
        var line = downlink ? downLine : upLine;
        line.Add((clock.Elapsed.TotalMilliseconds + wait, via, to, data));
    }
    _ = Task.Run(async () => { while (!cts.IsCancellationRequested) { try { var r = await a.ReceiveAsync(cts.Token); browserEp = r.RemoteEndPoint; if (agentEp != null) Forward(b, agentEp, r.Buffer, false); } catch { } } });
    _ = Task.Run(async () => { while (!cts.IsCancellationRequested) { try { var r = await b.ReceiveAsync(cts.Token); agentEp = r.RemoteEndPoint; if (browserEp != null) Forward(a, browserEp, r.Buffer, true); } catch { } } });

    // ----- signalling between the page and the agent, with the addresses replaced by the proxy's
    var debug = Environment.GetEnvironmentVariable("LAB_DEBUG") == "1";
    void Trace(string m) { if (debug) Console.WriteLine("  [lab] " + m); }
    string? agentCandidate = null;
    string RewriteCandidate(string cand, int port)
    {
        var t = cand.Split(' ');
        if (t.Length < 8) return cand;
        t[4] = candIp; t[5] = port.ToString();
        return string.Join(' ', t);
    }
    bool IsHostUdp4(string c) { var t = c.Split(' '); return t.Length > 7 && t[2].Equals("udp", StringComparison.OrdinalIgnoreCase) && t[7] == "host" && IPAddress.TryParse(t[4], out var ip) && ip.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ip); }
    void AgentCandidate(string raw)
    {
        if (!IsHostUdp4(raw.Replace("a=", "")) || agentCandidate != null) return;
        var t = raw.Replace("a=", "").Split(' ');
        agentCandidate = raw.Replace("a=", "");
        candIp = t[4];
        agentEp ??= new IPEndPoint(IPAddress.Parse(t[4]), int.Parse(t[5]));
        toPage.Enqueue(new { candidate = RewriteCandidate(agentCandidate, aPort), sdpMid = "0", sdpMLineIndex = 0 });
        Trace("agent candidate " + agentCandidate + " -> proxy port " + aPort);
    }
    peer.OnSignalToSend += o =>
    {
        var j = JsonSerializer.SerializeToElement(o);
        if (j.TryGetProperty("type", out var t) && t.GetString() == "answer")
        {
            var sdp = j.GetProperty("sdp").GetString()!;
            foreach (var line in sdp.Split('\n')) if (line.StartsWith("a=candidate:")) AgentCandidate(line.Trim());
            sdp = string.Join("\r\n", sdp.Replace("\r", "").Split('\n').Where(l => !l.StartsWith("a=candidate:") && !l.StartsWith("a=end-of-candidates")));
            Trace("ANSWER " + string.Join(" | ", sdp.Replace("\r", "").Split('\n').Where(l => Regex.IsMatch(l, "^a=(rtpmap|rtcp-fb|fmtp|ssrc|extmap|sendrecv|sendonly|recvonly|inactive|mid)|^m=")).Select(l => l.Trim())));
            toPage.Enqueue(new { type = "answer", sdp });
        }
        else if (j.TryGetProperty("candidate", out var c) && !string.IsNullOrEmpty(c.GetString())) AgentCandidate(c.GetString()!);
    };

    var http = new HttpListener(); var httpPort = Random.Shared.Next(20000, 40000); http.Prefixes.Add($"http://127.0.0.1:{httpPort}/"); http.Start();
    _ = Task.Run(async () =>
    {
        while (http.IsListening)
        {
            HttpListenerContext ctx; try { ctx = await http.GetContextAsync(); } catch { break; }
            _ = Task.Run(async () =>
            {
                try
                {
                    var path = ctx.Request.Url!.AbsolutePath; string body = "";
                    if (ctx.Request.HasEntityBody) { using var rd = new StreamReader(ctx.Request.InputStream); body = await rd.ReadToEndAsync(); }
                    string reply = "";
                    Trace($"{ctx.Request.HttpMethod} {path} {(body.Length > 90 ? body[..90] : body)}");
                    if (path == "/") { ctx.Response.ContentType = "text/html"; reply = Page; }
                    else if (path == "/offer") { await peer.HandleSignalAsync(JsonDocument.Parse(body).RootElement.Clone(), CancellationToken.None); }
                    else if (path == "/browser-cand")
                    {
                        var j = JsonDocument.Parse(body).RootElement.Clone(); var cand = j.GetProperty("candidate").GetString() ?? "";
                        if (IsHostUdp4(cand)) await peer.HandleSignalAsync(JsonSerializer.SerializeToElement(new { candidate = RewriteCandidate(cand, bPort), sdpMid = "0", sdpMLineIndex = 0 }), CancellationToken.None);
                    }
                    else if (path == "/poll") { var list = new List<object>(); while (toPage.TryDequeue(out var m)) list.Add(m); ctx.Response.ContentType = "application/json"; reply = JsonSerializer.Serialize(list); }
                    else if (path == "/log") { Trace("PAGE ERROR " + body); }
                    else if (path == "/stats") { lock (stats) stats.Add(JsonDocument.Parse(body).RootElement.Clone()); }
                    var bytes = Encoding.UTF8.GetBytes(reply); ctx.Response.OutputStream.Write(bytes); ctx.Response.Close();
                }
                catch { try { ctx.Response.Abort(); } catch { } }
            });
        }
    });

    var profile = Path.Combine(Path.GetTempPath(), "riq-lab-" + Guid.NewGuid().ToString("N"));
    var browser = Process.Start(new ProcessStartInfo(edge, $"--headless=new --user-data-dir=\"{profile}\" --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required --disable-features=WebRtcHideLocalIpsWithMdns --disable-background-timer-throttling http://127.0.0.1:{httpPort}/") { UseShellExecute = false, CreateNoWindow = true })!;

    string result;
    try
    {
        // wait for the connection, then settle, then measure
        for (var i = 0; i < 60; i++) { await Task.Delay(500); lock (stats) if (stats.Count > 0 && stats[^1].GetProperty("state").GetString() == "connected" && stats[^1].GetProperty("frames").GetInt64() > 5) break; }
        var tStart = DateTimeOffset.UtcNow;
        await Task.Delay(6000);
        JsonElement first; lock (stats) { if (stats.Count == 0) return $"RESULT engine={engine} scenario={sc.Name} FAILED to connect"; first = stats[^1]; }
        await Task.Delay(seconds * 1000);
        JsonElement last; lock (stats) last = stats[^1];
        double dt = (last.GetProperty("t").GetDouble() - first.GetProperty("t").GetDouble()) / 1000.0;
        double D(string n) => last.GetProperty(n).GetDouble() - first.GetProperty(n).GetDouble();
        double Raw(JsonElement e, string n) => e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : 0;
        var jbn = D("jbn"); var jb = jbn > 0 ? 1000 * D("jb") / jbn : 0;
        result = $"RESULT engine={engine,-7} {sc.Name,-8} fps={D("frames") / dt,5:F1} kbps={D("bytes") * 8 / dt / 1000,5:F0} delayBufferMs={jb,4:F0} freezes={D("fz"),2:F0} frozenSec={D("fzd"),4:F1} nacks={D("nack"),4:F0} plis={D("pli") + D("fir"),3:F0} lostPkts={D("lost"),4:F0} of {D("rcv"),5:F0} size={last.GetProperty("w").GetInt32()}x{last.GetProperty("h").GetInt32()} proxyDropped={Interlocked.Read(ref dropped)}";
    }
    finally
    {
        try { browser.Kill(true); } catch { }
        cts.Cancel(); downLine.CompleteAdding(); upLine.CompleteAdding(); http.Stop(); a.Dispose(); b.Dispose();
        await peer.CloseAsync("lab over", CancellationToken.None);
        await Task.Delay(1500);
        try { Directory.Delete(profile, true); } catch { }
    }
    return result;
}

// a moving picture on this computer's screen for the whole run (the agent captures it)
var motion = Path.Combine(AppContext.BaseDirectory, "motion.ps1");
File.WriteAllText(motion, """
param([int]$Seconds = 900)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.WindowState = 'Maximized'; $f.TopMost = $true; $f.BackColor = 'Black'; $f.ShowInTaskbar = $false
$f.GetType().GetProperty('DoubleBuffered', [Reflection.BindingFlags]'Instance,NonPublic').SetValue($f, $true, $null)
$script:x = 0; $script:t0 = Get-Date
$f.Add_Paint({ param($s, $e)
  $g = $e.Graphics; $w = $f.ClientSize.Width; $h = $f.ClientSize.Height
  for ($i = 0; $i -lt 24; $i++) {
    $c = [System.Drawing.Color]::FromArgb(255, (($i * 53 + $script:x) % 255), (($i * 97 + $script:x * 2) % 255), (($i * 29 + $script:x * 3) % 255))
    $b = New-Object System.Drawing.SolidBrush $c
    $g.FillRectangle($b, (($i * 80 + $script:x * 7) % $w), ($i * ($h / 24)), 220, ($h / 24)); $b.Dispose()
  } })
$t = New-Object System.Windows.Forms.Timer; $t.Interval = 16
$t.Add_Tick({ $script:x++; $f.Invalidate(); if (((Get-Date) - $script:t0).TotalSeconds -gt $Seconds) { $f.Close() } }); $t.Start()
[void]$f.ShowDialog()
""");
var total = engines.Length * scenarios.Length * (seconds + 22) + 30;
var anim = Process.Start(new ProcessStartInfo("pwsh", $"-NoProfile -WindowStyle Hidden -File \"{motion}\" -Seconds {total}") { UseShellExecute = false, CreateNoWindow = true });
await Task.Delay(3000);
var failed = 0;
try
{
    foreach (var sc in scenarios)
        foreach (var engine in engines)
        {
            var line = await RunAsync(engine, sc);
            Console.WriteLine(line);
            if (line.Contains("FAILED")) failed++;
        }
}
finally { try { anim?.Kill(true); } catch { } }
return failed == 0 ? 0 : 1;
