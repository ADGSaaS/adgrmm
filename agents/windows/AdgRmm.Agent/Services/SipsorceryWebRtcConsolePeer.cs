// agents/windows/AdgRmm.Agent/Services/SipsorceryWebRtcConsolePeer.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Linq;
using System.Management;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using SIPSorcery.Net;
using SIPSorceryMedia.Abstractions;
using SIPSorceryMedia.Encoders;

namespace AdgRmm.Agent.Services;

public sealed class SipsorceryWebRtcConsolePeer : IWebRtcConsolePeer
{
    private readonly ILogger _log;

    private RTCPeerConnection? _pc;

    private RTCDataChannel? _inputDc;   // rc.input
    private RTCDataChannel? _controlDc; // rc.control

    private volatile bool _closed;

    // Video pipeline
    private IVideoSource? _videoSource;
    private IVideoEncoder? _videoEncoder;
    private MediaStreamTrack? _videoTrack;
    private bool _videoAttached;
    private bool _videoStarted;

    // Encoder / bandwidth tuning
    private int _targetKbps;
    private int _maxKbps;
    private int _keyframeSeconds;
    // Starts modest and climbs 25 percent a second (about 4 seconds to 4000): a big first keyframe sent at 4000 kbps
    // into a receiver still setting up lost packets and took ~8 s to show the first picture on the VM.
    private const int StartKbps = 1500;
    private const int MinKbps = 800;
    private Timer? _keyframeTimer;

    // Desktop mapping (primary monitor in virtual screen coords)
    private DesktopGeometry _desktopGeom = DesktopGeometry.Unknown;

    // Input injection
    private readonly RemoteInputInjector _input = new();
    private HelperPipeDesktopVideoSource? _helperSource;
    private RTCDataChannel? _clipboardDc; // rc.clipboard
    private RTCDataChannel? _chatDc;      // rc.chat

    // The helper and the agent can report before the technician's channels exist, so the latest
    // message of each type is kept and sent when rc.control opens.
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> _latestControl = new();

    // PowerShell prints its first prompt before rc.input is open.
    private const int PendingTerminalLimitChars = 64 * 1024;
    private readonly object _terminalLock = new();
    private readonly StringBuilder _pendingTerminal = new();

    private static volatile bool _dcMembersDumped;

    public string SessionId { get; }
    public bool IsConnected { get; private set; }

    public event Action<string>? OnTextFromTech;
    public event Action<JsonElement>? OnControlFromTech;
    public event Action<object>? OnSignalToSend;

    private readonly IReadOnlyList<ConsoleIceServer>? _issuedIceServers;

    public SipsorceryWebRtcConsolePeer(string sessionId, ILogger log, IReadOnlyList<ConsoleIceServer>? iceServers = null)
    {
        SessionId = sessionId;
        _log = log;
        _issuedIceServers = iceServers;
        EnsurePeerCreated();
    }

    private ConsoleVideoSender? _videoSender;
    private ConsoleVideoEncoder? _consoleEncoder;
    private ConsoleVideoCodecSetting _codecSetting = ConsoleVideoCodecSetting.Auto;
    private bool _h264Allowed;
    private int _videoFps = 30;
    private ConsoleCodecDecision? _codecDecision;
    private int _unusableInARow;
    private long _encodedAtLastCheck;
    private ConsoleVideoFeedback? _videoFeedback;
    private bool _feedbackAttached;
    private int _sendErrorsLogged;

    // Measured from the browser's reports, because the time a packet spends queued shows up here first.
    private void OnVideoReport(RTCPCompoundPacket report)
    {
        var samples = report.ReceiverReport?.ReceptionReports ?? report.SenderReport?.ReceptionReports;
        if (samples is not { Count: > 0 } || samples[0].LastSenderReportTimestamp == 0) return;

        var sample = samples[0];
        var now = RTCPSession.DateTimeToNtpTimestamp32(DateTime.Now);
        var units = unchecked(now - sample.LastSenderReportTimestamp - sample.DelaySinceLastSenderReport);
        _videoFeedback?.OnRoundTrip(units * 1000.0 / 65536.0);
    }

    // The library's answer leaves these out, and browsers only send what the answer says is understood.
    private static string AddRtcpFeedback(string sdp)
    {
        var match = System.Text.RegularExpressions.Regex.Match(sdp, @"a=rtpmap:(\d+) VP8/90000\r?\n");
        if (!match.Success) return sdp;

        var pt = match.Groups[1].Value;
        if (sdp.Contains($"a=rtcp-fb:{pt} nack\r\n", StringComparison.Ordinal)) return sdp;

        // Plain "nack" is what makes the browser ask for lost packets instead of a whole new picture.
        return sdp.Insert(match.Index + match.Length, $"a=rtcp-fb:{pt} nack\r\na=rtcp-fb:{pt} nack pli\r\na=rtcp-fb:{pt} ccm fir\r\n");
    }

    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, int> _localCandidates = new();
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, int> _remoteCandidates = new();

    private static void CountCandidate(System.Collections.Concurrent.ConcurrentDictionary<string, int> counts, string? candidate)
    {
        var type = System.Text.RegularExpressions.Regex.Match(candidate ?? "", @"\btyp\s+(\w+)").Groups[1].Value;
        var proto = System.Text.RegularExpressions.Regex.Match(candidate ?? "", @"\b(udp|tcp)\b", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Value.ToLowerInvariant();
        if (type.Length > 0) counts.AddOrUpdate($"{type}/{proto}", 1, (_, n) => n + 1);
    }

    private static string DescribeCandidates(System.Collections.Concurrent.ConcurrentDictionary<string, int> counts)
        => counts.IsEmpty ? "none" : string.Join(", ", counts.Select(kv => $"{kv.Key}:{kv.Value}"));

    private void EnsurePeerCreated()
    {
        if (_pc != null) return;

        // Best-effort: make sure our process uses real pixel coordinates on modern Windows.
        DpiUtil.TryEnablePerMonitorV2();

        var stunRaw = (Environment.GetEnvironmentVariable("REMOTE_CONSOLE_STUN") ?? "").Trim();

        var iceServers = new List<RTCIceServer>();
        if (_issuedIceServers is { Count: > 0 })
        {
            foreach (var s in _issuedIceServers)
            {
                iceServers.Add(new RTCIceServer { urls = s.Url, username = s.Username, credential = s.Credential });
            }
            _log.LogInformation("RemoteConsole using {Count} issued ICE server(s), relay={Relay} session={SessionId}",
                iceServers.Count, _issuedIceServers.Any(s => s.Url.StartsWith("turn:", StringComparison.OrdinalIgnoreCase)), SessionId);
        }
        else if (!string.IsNullOrWhiteSpace(stunRaw))
        {
            foreach (var s in stunRaw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                iceServers.Add(new RTCIceServer { urls = s });
            }
        }
        else
        {
            iceServers.Add(new RTCIceServer { urls = "stun:stun.l.google.com:19302" });
        }

        _pc = new RTCPeerConnection(new RTCConfiguration { iceServers = iceServers });

        _pc.onicecandidate += (cand) =>
        {
            if (_closed) return;
            if (cand == null) return;

            try
            {
                CountCandidate(_localCandidates, cand.candidate);

                OnSignalToSend?.Invoke(new
                {
                    candidate = cand.candidate,
                    sdpMid = cand.sdpMid,
                    sdpMLineIndex = cand.sdpMLineIndex
                });
            }
            catch { }
        };

        _pc.onconnectionstatechange += async (state) =>
        {
            IsConnected = state == RTCPeerConnectionState.connected;
            _log.LogInformation("RemoteConsole WebRTC state session={SessionId} state={State}", SessionId, state);

            try
            {
                if (state == RTCPeerConnectionState.connected)
                {
                    // The keys exist from here on. A reconnection keeps them, so this only happens once.
                    if (!_feedbackAttached && _videoFeedback is { } feedback && _pc is { } connectedPc)
                    {
                        _feedbackAttached = feedback.AttachTo(connectedPc);
                        if (!_feedbackAttached)
                            _log.LogWarning("RemoteConsole cannot read the browser's video reports session={SessionId}", SessionId);
                    }

                    await StartVideoIfReadyAsync().ConfigureAwait(false);
                    StartKeyframeTimer();

                    // Frames made before this point went nowhere, so the browser needs a full one.
                    try { _videoEncoder?.ForceKeyFrame(); } catch { }

                    if (!_reportsStarted)
                    {
                        _reportsStarted = true;
                        _ = ReportIfNoVideoAsync();
                        _ = ReportStatsAsync();
                    }
                }
                else if (state == RTCPeerConnectionState.failed || state == RTCPeerConnectionState.closed)
                {
                    StopKeyframeTimer();
                    await StopVideoBestEffortAsync().ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "RemoteConsole video start/stop hook error session={SessionId}", SessionId);
            }
        };

        _pc.oniceconnectionstatechange += (state) =>
        {
            // Types only, never addresses. A warning, so it reaches the Windows event log.
            if (state == RTCIceConnectionState.failed || state == RTCIceConnectionState.disconnected)
            {
                _log.LogWarning("RemoteConsole ICE {State} session={SessionId} local=[{Local}] remote=[{Remote}]",
                    state, SessionId, DescribeCandidates(_localCandidates), DescribeCandidates(_remoteCandidates));
            }

            _log.LogInformation("RemoteConsole ICE state session={SessionId} state={State}", SessionId, state);
        };

        _pc.ondatachannel += (dc) =>
        {
            if (_closed) return;
            if (dc == null) return;

            var label = (dc.label ?? "").Trim();
            _log.LogInformation("RemoteConsole datachannel received session={SessionId} label={Label}", SessionId, label);

            HookDataChannelDynamic(dc);

            if (string.Equals(label, "rc.control", StringComparison.OrdinalIgnoreCase))
            {
                _controlDc = dc;
                HookControlChannel(dc);
                return;
            }

            if (string.Equals(label, "rc.move", StringComparison.OrdinalIgnoreCase))
            {
                HookControlChannel(dc);
                return;
            }

            if (string.Equals(label, "rc.clipboard", StringComparison.OrdinalIgnoreCase))
            {
                _clipboardDc = dc;
                HookClipboardChannel(dc);
                return;
            }

            if (string.Equals(label, "rc.chat", StringComparison.OrdinalIgnoreCase))
            {
                _chatDc = dc;
                HookChatChannel(dc);
                return;
            }

            if (string.Equals(label, "rc.input", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(label, "console", StringComparison.OrdinalIgnoreCase))
            {
                _inputDc = dc;
                HookInputChannel(dc);
                return;
            }

            if (_inputDc == null)
            {
                _inputDc = dc;
                HookInputChannel(dc);
            }
        };

        try
        {
            EnableDesktopVideoPipeline(_pc);

            // Starting the helper takes longer than connecting, so it starts now rather than afterwards.
            _ = StartVideoIfReadyAsync();
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "RemoteConsole video pipeline enable failed session={SessionId}", SessionId);
        }
    }

    // ---------------------------------------------------------------------
    // Desktop pipeline: helper in interactive session (Task Scheduler COM + Pipe)
    // ---------------------------------------------------------------------

    private void EnableDesktopVideoPipeline(RTCPeerConnection pc)
    {
        if (_videoSource != null || _videoAttached) return;

        var proc = Process.GetCurrentProcess();
        var isSession0 = proc.SessionId == 0;

        _log.LogInformation(
            "RemoteConsole runtime pid={Pid} sessionId={Sess} user={User} isSession0={IsSession0} os={OS} session={SessionId}",
            proc.Id,
            proc.SessionId,
            Environment.UserName,
            isSession0,
            Environment.OSVersion.VersionString,
            SessionId
        );

        var sourcePref = (Environment.GetEnvironmentVariable("REMOTE_CONSOLE_VIDEO_SOURCE") ?? "screen").Trim().ToLowerInvariant();
        var allowWebcam = (Environment.GetEnvironmentVariable("REMOTE_CONSOLE_ALLOW_WEBCAM") ?? "").Trim() == "1";

        if ((sourcePref == "camera" || sourcePref == "webcam") && !allowWebcam)
        {
            throw new InvalidOperationException("Webcam is disabled. Set REMOTE_CONSOLE_ALLOW_WEBCAM=1 to allow.");
        }

        _desktopGeom = DesktopGeometry.ReadCurrent(isSession0);

        var nativeW = Math.Max(1, _desktopGeom.Primary.Width);
        var nativeH = Math.Max(1, _desktopGeom.Primary.Height);

        int envW = (int)ReadUIntEnv("REMOTE_CONSOLE_VIDEO_WIDTH", 0);
        int envH = (int)ReadUIntEnv("REMOTE_CONSOLE_VIDEO_HEIGHT", 0);
        int envFps = (int)ReadUIntEnv("REMOTE_CONSOLE_VIDEO_FPS", 30);

        int envMaxDim = (int)ReadUIntEnv("REMOTE_CONSOLE_VIDEO_MAX_DIM", 3840);
        envMaxDim = Math.Clamp(envMaxDim, 0, 8192);

        int w = envW <= 0 ? nativeW : envW;
        int h = envH <= 0 ? nativeH : envH;
        int fps = Math.Clamp(envFps, 1, 60);

        if (envW <= 0 && envH <= 0 && envMaxDim > 0)
        {
            (w, h) = ScaleToMaxDimPreserveAspect(w, h, envMaxDim);
        }

        if (w % 2 != 0) w--;
        if (h % 2 != 0) h--;

        w = Math.Clamp(w, 64, 7680);
        h = Math.Clamp(h, 64, 4320);
        fps = Math.Clamp(fps, 1, 30);

        int AutoKbps(int ww, int hh, int ff, double bitsPerPixel)
        {
            var bps = bitsPerPixel * ff * (double)ww * (double)hh;
            return (int)Math.Round(bps / 1000.0);
        }

        int envStart = (int)ReadUIntEnv("REMOTE_CONSOLE_VIDEO_START_KBPS", 0);
        int envMax = (int)ReadUIntEnv("REMOTE_CONSOLE_VIDEO_MAX_KBPS", 0);

        _keyframeSeconds = (int)ReadUIntEnv("REMOTE_CONSOLE_VIDEO_KEYFRAME_SECONDS", 60);

        // It starts low and climbs to what the network turns out to carry, so a slow uplink is never
        // flooded in the first seconds, which is when the first keyframe has to get through.
        // At least enough for 1080p, because the size seen from the service's session can be far too small.
        _maxKbps = envMax <= 0 ? Math.Max(StartKbps, AutoKbps(Math.Max(w, 1920), Math.Max(h, 1080), fps, 0.12)) : envMax;
        _maxKbps = Math.Clamp(_maxKbps, 800, 25_000);
        _targetKbps = Math.Clamp(envStart <= 0 ? StartKbps : envStart, 800, _maxKbps);

        // The browser asks for a keyframe when it needs one. This is only a safety net, because each
        // one is a large burst that a congested link can least afford.
        _keyframeSeconds = Math.Clamp(_keyframeSeconds, 5, 300);

        _desktopGeom = DesktopGeometry.ReadCurrent(isSession0);

        _log.LogInformation(
            "RemoteConsole quality params session={SessionId} native={NativeW}x{NativeH} capture={W}x{H} fps={Fps} startKbps={StartKbps} maxKbps={MaxKbps} keyframeSec={KeyframeSec} maxDim={MaxDim} forcedWH={ForcedWH}",
            SessionId, nativeW, nativeH, w, h, fps, _targetKbps, _maxKbps, _keyframeSeconds, envMaxDim, (envW > 0 || envH > 0)
        );

        // VP8 unless the server's codec setting, the start-up check and the browser's offer all allow H.264 (see the offer handler).
        // H.264 can only be negotiated if the check had already passed when this session began, so a device whose check is
        // unfinished, failed or absent behaves exactly as before.
        _videoFps = fps;
        _codecSetting = ConsoleVideoPolicy.Effective(ConsoleVideoPolicy.TakeForSession(SessionId), Environment.GetEnvironmentVariable("REMOTE_CONSOLE_VIDEO_CODEC"));
        var capability = H264Support.Cached;
        _h264Allowed = _codecSetting != ConsoleVideoCodecSetting.Vp8 && capability is { Available: true } &&
                       (_codecSetting == ConsoleVideoCodecSetting.H264 || capability.Hardware);
        _consoleEncoder = new ConsoleVideoEncoder(new ScreenVp8Encoder(_targetKbps, fps), _targetKbps, fps, OnH264EncoderFailed);
        _videoEncoder = _consoleEncoder;
        _log.LogInformation("RemoteConsole video codec setting={Setting} h264Possible={Possible} check={Check} session={SessionId}",
            _codecSetting, _h264Allowed, capability is null ? "not finished" : capability.Available ? $"passed ({(capability.Hardware ? "hardware" : "software")} {capability.Name})" : "no usable encoder", SessionId);
        _log.LogInformation("RemoteConsole selected encoder={Encoder} session={SessionId}", _videoEncoder.GetType().FullName, SessionId);


        if (sourcePref == "camera" || sourcePref == "webcam")
        {
            throw new InvalidOperationException("Webcam requested but webcam pipeline is intentionally disabled in this build.");
        }

        // Session 0 cannot read the real display layout, and WMI reports the largest monitor rather
        // than the primary one. So the helper sends each monitor at its true size, up to this limit.
        int capW = envW > 0 ? envW : (envMaxDim > 0 ? envMaxDim : 7680);
        int capH = envH > 0 ? envH : (envMaxDim > 0 ? envMaxDim : 4320);

        _videoSource = isSession0
            ? new HelperPipeDesktopVideoSource(capW, capH, fps, _videoEncoder, _log, SessionId)
            : new DirectGdiDesktopVideoSource(w, h, fps, _videoEncoder, _log, SessionId);

        // A service in Session 0 cannot touch the user's desktop, so input goes through the helper.
        if (_videoSource is HelperPipeDesktopVideoSource helper)
        {
            var warnedNotConnected = false;
            _input.Sink = (op, a, b) =>
            {
                if (helper.TrySendCommand(op, a, b, null) || warnedNotConnected) return;
                warnedNotConnected = true;
                _log.LogWarning("RemoteConsole input arrived but the capture helper is not connected session={SessionId}", SessionId);
            };
            helper.OnClipboardText += SendClipboardToTech;
            helper.OnControlText += SendControlToTech;
            helper.OnChatText += SendChatToTech;
            _helperSource = helper;
        }

        if (isSession0)
        {
            _log.LogInformation(
                "RemoteConsole is running in Session 0 (service isolation). Using capture helper in interactive user session. session={SessionId}",
                SessionId
            );
        }

        // VP8 only. VpxVideoEncoder always produces VP8 whatever codec it is asked for, so offering
        // VP9 would label VP8 frames as VP9, and the browser cannot decode them.
        _videoSource.RestrictFormats(f => f.Codec == VideoCodecsEnum.VP8);

        var trackFormats = _videoSource.GetVideoSourceFormats().ToList();
        if (_h264Allowed) trackFormats.Add(new VideoFormat(VideoCodecsEnum.H264, 102, 90000, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"));
        _videoTrack = new MediaStreamTrack(trackFormats, MediaStreamStatusEnum.SendOnly);
        pc.addTrack(_videoTrack);

        int? payloadType = null;
        var encoder = _consoleEncoder!;
        var rate = new ConsoleRateController(_targetKbps, MinKbps, _maxKbps);
        var sender = new ConsoleVideoSender(
            (payload, timestamp, marker, sequence, codec) =>
            {
                var stream = pc.VideoStream;
                if (stream == null || pc.connectionState != RTCPeerConnectionState.connected) return;

                // H.264 goes out under the payload type the browser offered it with. VP8 keeps what it always used.
                if (codec == ConsoleVideoCodec.H264 && _codecDecision?.H264 is { } h264Entry)
                {
                    stream.SendRtpRaw(payload, timestamp, marker, h264Entry.PayloadType, sequence);
                    return;
                }
                payloadType ??= _codecDecision?.Vp8PayloadType ?? stream.GetSendingFormat().ID;
                stream.SendRtpRaw(payload, timestamp, marker, payloadType.Value, sequence);
            },
            _targetKbps,
            ex =>
            {
                if (Interlocked.Increment(ref _sendErrorsLogged) <= 3)
                    _log.LogWarning(ex, "RemoteConsole could not send video session={SessionId}", SessionId);
            });
        _videoSender = sender;
        sender.OnUnusableFrame += () =>
        {
            // An H.264 keyframe that cannot be started from. Asking again once is fair, three in a row is a broken encoder.
            if (Interlocked.Increment(ref _unusableInARow) >= 3) FallBackFromH264("the encoder's keyframes carry no parameter sets");
            else encoder.ForceKeyFrame();
        };
        _videoFeedback = new ConsoleVideoFeedback(sender, rate, encoder.ForceKeyFrame, kbps =>
        {
            encoder.SetTargetKbps(kbps);
            _log.LogInformation("RemoteConsole video now {Kbps} kbps session={SessionId}", kbps, SessionId);
        },
        detail => _log.LogInformation("RemoteConsole video {Detail} session={SessionId}", detail, SessionId));
        _videoSource.OnVideoSourceEncodedSample += sender.Send;
        _videoSource.OnVideoSourceEncodedSample += (_, _) => Interlocked.Increment(ref _encodedFrames);
        _videoSource.OnVideoSourceRawSample += (_, _, _, _, _) => Interlocked.Increment(ref _capturedFrames);
        pc.OnReceiveReport += (_, media, report) =>
        {
            if (media == SDPMediaTypesEnum.video) OnVideoReport(report);
        };
        _videoSource.OnVideoSourceError += (err) =>
        {
            _log.LogError("RemoteConsole desktop capture error session={SessionId} err={Err}", SessionId, err);
            SendControlToTech(JsonSerializer.Serialize(new { type = "agent.notice", message = err }));
        };

        _videoAttached = true;

        _log.LogInformation(
            "RemoteConsole desktop video enabled session={SessionId} sourceType={SourceType} size={W}x{H} fps={Fps} startKbps={StartKbps} maxKbps={MaxKbps} keyframeSec={KeyframeSec}",
            SessionId,
            _videoSource.GetType().FullName,
            w, h, fps,
            _targetKbps, _maxKbps, _keyframeSeconds
        );
    }

    private static (int w, int h) ScaleToMaxDimPreserveAspect(int w, int h, int maxDim)
    {
        if (maxDim <= 0) return (w, h);
        if (w <= maxDim && h <= maxDim) return (w, h);

        double scale = (w >= h) ? ((double)maxDim / w) : ((double)maxDim / h);
        int nw = Math.Max(64, (int)Math.Round(w * scale));
        int nh = Math.Max(64, (int)Math.Round(h * scale));
        return (nw, nh);
    }

    private bool StartH264(ConsoleCodecDecision decision, out string? problem)
    {
        problem = null;
        var capability = H264Support.Cached;
        if (_consoleEncoder is null || _videoSender is null || capability is not { Available: true })
        {
            problem = "no approved encoder";
            return false;
        }

        var ok = _consoleEncoder.TryEnableH264(capability, () =>
        {
            var list = MfH264Encoder.Enumerate();
            var index = capability.CandidateIndex;
            if (index < 0 || index >= list.Count || list[index].Name != capability.Name) return null;
            return new MfH264Encoder(list[index], _targetKbps, _videoFps)
            {
                Trace = m => _log.LogInformation("RemoteConsole H.264 encoder: {Message} session={SessionId}", m, SessionId),
            };
        }, out problem);
        if (!ok) return false;

        _videoSender.SwitchCodec(ConsoleVideoCodec.H264);
        _unusableInARow = 0;
        _encodedAtLastCheck = Interlocked.Read(ref _encodedFrames);
        return true;
    }

    /// <summary>H.264 failed or could not be shown: back to VP8 for the rest of this session, and no H.264 for the rest of this run of the agent.</summary>
    private void FallBackFromH264(string reason)
    {
        if (_consoleEncoder is null || _consoleEncoder.Active != ConsoleVideoCodec.H264) return;
        _consoleEncoder.FallBackToVp8();
        OnH264EncoderFailed(reason);
    }

    private void OnH264EncoderFailed(string reason)
    {
        H264Support.MarkFailed(reason);
        _videoSender?.SwitchCodec(ConsoleVideoCodec.Vp8);
        _log.LogWarning("RemoteConsole H.264 failed, continuing with VP8: {Reason} session={SessionId}", reason, SessionId);
        AnnounceCodec();
    }

    private void AnnounceCodec()
    {
        var h264 = _consoleEncoder?.Active == ConsoleVideoCodec.H264;
        SendControlToTech(JsonSerializer.Serialize(new
        {
            type = "agent.codec",
            codec = h264 ? "h264" : "vp8",
            hardware = h264 && _consoleEncoder!.H264Hardware,
            encoder = h264 ? _consoleEncoder!.H264Name : null,
            fellBack = H264Support.FailureLater is not null,
        }));
    }

    private void StartKeyframeTimer()
    {
        if (_closed) return;
        if (_videoEncoder == null) return;

        StopKeyframeTimer();

        _keyframeTimer = new Timer(_ =>
        {
            try { _videoEncoder?.ForceKeyFrame(); } catch { }
        }, null, TimeSpan.FromSeconds(_keyframeSeconds), TimeSpan.FromSeconds(_keyframeSeconds));
    }

    /** Where the time goes on the device, so delay can be measured rather than guessed at. */
    private async Task ReportStatsAsync()
    {
        try
        {
            while (!_closed && IsConnected)
            {
                await Task.Delay(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
                if (_closed || !IsConnected) return;

                var (encodeMs, frames) = _consoleEncoder?.TakeEncodeStats() ?? (0, 0);
                var queuedMs = _videoSender?.QueuedMs() ?? 0;
                var h264 = _consoleEncoder?.Active == ConsoleVideoCodec.H264;
                SendControlToTech(JsonSerializer.Serialize(new
                {
                    type = "agent.stats", encodeMs = Math.Round(encodeMs, 1), frames, queuedMs,
                    codec = h264 ? "h264" : "vp8", hardware = h264 && _consoleEncoder!.H264Hardware,
                }));

                // H.264 that stops producing pictures while the screen is being captured is as bad as one that throws.
                // An unchanged screen still yields a picture every second, so five silent seconds are not "nothing to show".
                if (h264)
                {
                    var encodedNow = Interlocked.Read(ref _encodedFrames);
                    var captured = Interlocked.Read(ref _capturedFrames);
                    if (encodedNow == _encodedAtLastCheck && captured > 0) FallBackFromH264("the encoder stopped producing pictures");
                    _encodedAtLastCheck = encodedNow;
                }
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "RemoteConsole could not report video timing session={SessionId}", SessionId);
        }
    }

    /** A connected session with no picture says why, instead of leaving a black screen and no explanation. */
    private async Task ReportIfNoVideoAsync()
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(NoVideoAfterSeconds)).ConfigureAwait(false);
            var told = false;
            while (!_closed && IsConnected)
            {
                var captured = Interlocked.Read(ref _capturedFrames);
                var encoded = Interlocked.Read(ref _encodedFrames);
                _log.LogInformation("RemoteConsole video so far session={SessionId} captured={Captured} encoded={Encoded}", SessionId, captured, encoded);

                if (encoded == 0 && !told)
                {
                    told = true;
                    var message = captured == 0
                        ? $"No screen images have arrived from this device after {NoVideoAfterSeconds} seconds. Windows may be refusing the screen capture. It keeps trying."
                        : $"This device captured {captured} screen images but could not encode any of them, so no video was sent.";
                    _log.LogWarning("RemoteConsole no video session={SessionId}: {Message}", SessionId, message);
                    SendControlToTech(JsonSerializer.Serialize(new { type = "agent.notice", message }));
                }
                await Task.Delay(TimeSpan.FromSeconds(VideoLogEverySeconds)).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "RemoteConsole video check failed session={SessionId}", SessionId);
        }
    }

    private void StopKeyframeTimer()
    {
        try { _keyframeTimer?.Dispose(); } catch { }
        _keyframeTimer = null;
    }

    private const int NoVideoAfterSeconds = 30;
    private bool _reportsStarted;
    private const int VideoLogEverySeconds = 60;
    private long _capturedFrames;
    private long _encodedFrames;

    private void StopVideoSender()
    {
        try { _videoFeedback?.Dispose(); } catch { }
        try { _videoSender?.Dispose(); } catch { }
        _videoFeedback = null;
        _videoSender = null;
    }

    private async Task StartVideoIfReadyAsync()
    {
        if (_closed) return;
        if (_videoSource == null) return;
        if (_videoStarted) return;

        try
        {
            await _videoSource.StartVideo().ConfigureAwait(false);
            _videoStarted = true;
            _log.LogInformation("RemoteConsole desktop video started session={SessionId}", SessionId);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "RemoteConsole failed to start desktop video session={SessionId}", SessionId);
        }
    }

    private async Task StopVideoBestEffortAsync()
    {
        if (_videoSource == null) return;
        if (!_videoStarted) return;

        try { await _videoSource.CloseVideo().ConfigureAwait(false); } catch { }
        _videoStarted = false;
    }

    // ---------------------------------------------------------------------
    // Video sources
    // ---------------------------------------------------------------------

    private sealed class DirectGdiDesktopVideoSource : IVideoSource, IDisposable
    {
        private const int VIDEO_SAMPLING_RATE = 90000;

        // Common dynamic PTs
        private const int VP8_PT = 96;

        // ✅ VP9 first, VP8 second
        private static readonly List<VideoFormat> Formats =
        [
            new VideoFormat(VideoCodecsEnum.VP8, VP8_PT, VIDEO_SAMPLING_RATE),
        ];

        private readonly int _w;
        private readonly int _h;
        private readonly int _fps;
        private readonly IVideoEncoder _encoder;
        private readonly ILogger _log;
        private readonly string _sessionId;
        private readonly MediaFormatManager<VideoFormat> _fmtMgr;

        private Timer? _timer;
        private volatile bool _started;
        private volatile bool _closed;

        public DirectGdiDesktopVideoSource(int w, int h, int fps, IVideoEncoder encoder, ILogger log, string sessionId)
        {
            _w = w;
            _h = h;
            _fps = Math.Clamp(fps, 1, 30);
            _encoder = encoder;
            _log = log;
            _sessionId = sessionId;

            _fmtMgr = new MediaFormatManager<VideoFormat>(Formats);
            _fmtMgr.SetSelectedFormat(Formats[0]);

            _timer = new Timer(Tick, null, Timeout.Infinite, Timeout.Infinite);
        }

        public event RawVideoSampleDelegate? OnVideoSourceRawSample;
#pragma warning disable CS0067
        public event RawVideoSampleFasterDelegate? OnVideoSourceRawSampleFaster;
#pragma warning restore CS0067
        public event EncodedSampleDelegate? OnVideoSourceEncodedSample;
        public event SourceErrorDelegate? OnVideoSourceError;

        public void RestrictFormats(Func<VideoFormat, bool> filter) => _fmtMgr.RestrictFormats(filter);

        public List<VideoFormat> GetVideoSourceFormats() => _fmtMgr.GetSourceFormats();
        public void SetVideoSourceFormat(VideoFormat videoFormat) => _fmtMgr.SetSelectedFormat(videoFormat);

        public List<VideoFormat> GetVideoSinkFormats() => _fmtMgr.GetSourceFormats();
        public void SetVideoSinkFormat(VideoFormat videoFormat) => _fmtMgr.SetSelectedFormat(videoFormat);

        public void ForceKeyFrame() => _encoder.ForceKeyFrame();
        public bool HasEncodedVideoSubscribers() => OnVideoSourceEncodedSample != null;
        public Task<bool> InitialiseVideoSourceDevice() => Task.FromResult(true);
        public bool IsVideoSourcePaused() => false;

        public Task PauseVideo() => Task.CompletedTask;
        public Task ResumeVideo() => Task.CompletedTask;

        public Task StartVideo()
        {
            if (_closed) return Task.CompletedTask;
            if (_started) return Task.CompletedTask;

            _started = true;
            _timer?.Change(0, FrameMs);
            return Task.CompletedTask;
        }

        public Task CloseVideo()
        {
            if (_closed) return Task.CompletedTask;
            _closed = true;

            try { _timer?.Change(Timeout.Infinite, Timeout.Infinite); } catch { }
            try { _timer?.Dispose(); } catch { }
            _timer = null;

            return Task.CompletedTask;
        }

        public void Dispose() => _ = CloseVideo();

        public void ExternalVideoSourceRawSample(uint durationMilliseconds, int width, int height, byte[] sample, VideoPixelFormatsEnum pixelFormat)
            => throw new NotImplementedException();

        public void ExternalVideoSourceRawSampleFaster(uint durationMilliseconds, RawImage rawImage)
            => throw new NotImplementedException();

        private int FrameMs => (int)Math.Round(1000.0 / _fps);

        private void Tick(object? _)
        {
            if (_closed || !_started) return;
            if (OnVideoSourceEncodedSample == null && OnVideoSourceRawSample == null) return;

            try
            {
                var bgra = Gdi.CapturePrimaryScreenBgraScaled(_w, _h, out var err);
                if (bgra == null)
                {
                    OnVideoSourceError?.Invoke($"Direct capture failed: {err}");
                    return;
                }

                OnVideoSourceRawSample?.Invoke((uint)FrameMs, _w, _h, bgra, VideoPixelFormatsEnum.Bgra);

                if (OnVideoSourceEncodedSample != null && !_fmtMgr.SelectedFormat.IsEmpty())
                {
                    var encoded = EncodeWithVp9PrimaryVp8Fallback(_encoder, _w, _h, bgra, VideoPixelFormatsEnum.Bgra, _fmtMgr, _log, _sessionId, message => OnVideoSourceError?.Invoke(message));
                    if (encoded != null && encoded.Length > 0)
                    {
                        uint durationRtpTs = (uint)(VIDEO_SAMPLING_RATE / Math.Max(1, _fps));
                        OnVideoSourceEncodedSample.Invoke(durationRtpTs, encoded);
                    }
                }
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "RemoteConsole direct capture tick error session={SessionId}", _sessionId);
                OnVideoSourceError?.Invoke(ex.Message);
            }
        }
    }

    private sealed class HelperPipeDesktopVideoSource : IVideoSource, IDisposable
    {
        public const int ClipboardLimitBytes = 4 * 1024 * 1024;

        private readonly object _commandLock = new();
        private NamedPipeServerStream? _commandPipe;

        public event Action<string>? OnClipboardText;
        public event Action<string>? OnControlText;
        public event Action<string>? OnChatText;

        /// <summary>Sends a command to the helper in the user's session. Returns false if it is not connected yet.</summary>
        public bool TrySendCommand(byte op, int a, int b, byte[]? payload)
        {
            var pipe = _commandPipe;
            if (pipe is null || !pipe.IsConnected) return false;

            var buffer = new byte[9 + (payload?.Length ?? 0)];
            buffer[0] = op;
            BitConverter.TryWriteBytes(buffer.AsSpan(1), a);
            BitConverter.TryWriteBytes(buffer.AsSpan(5), b);
            payload?.CopyTo(buffer, 9);

            try
            {
                lock (_commandLock)
                {
                    pipe.Write(buffer, 0, buffer.Length);
                    pipe.Flush();
                }
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private const int VIDEO_SAMPLING_RATE = 90000;

        private const int VP8_PT = 96;

        // ✅ VP9 first, VP8 second
        private static readonly List<VideoFormat> Formats =
        [
            new VideoFormat(VideoCodecsEnum.VP8, VP8_PT, VIDEO_SAMPLING_RATE),
        ];

        private readonly int _w;
        private readonly int _h;
        private readonly int _fps;
        private readonly IVideoEncoder _encoder;
        private readonly ILogger _log;
        private readonly string _sessionId;

        private readonly MediaFormatManager<VideoFormat> _fmtMgr;

        private CancellationTokenSource? _cts;
        private Task? _loop;

        private volatile bool _started;
        private volatile bool _closed;

        // The newest frame waiting to be encoded. A slow link or encoder then skips to the current
        // picture, rather than working through old ones and falling further behind.
        private readonly object _frameLock = new();
        private byte[]? _newest;
        private int _newestW;
        private int _newestH;
        private byte[]? _spare;
        private bool _encoderStopped;

        // These frames are large enough that allocating each one causes garbage collection pauses.
        private byte[] TakeBuffer(int length)
        {
            lock (_frameLock)
            {
                var buffer = _spare;
                _spare = null;
                return buffer is not null && buffer.Length == length ? buffer : new byte[length];
            }
        }

        private void PublishFrame(byte[] frame, int width, int height)
        {
            lock (_frameLock)
            {
                if (_newest is not null) _spare = _newest;
                _newest = frame;
                _newestW = width;
                _newestH = height;
                Monitor.PulseAll(_frameLock);
            }
        }

        private void EncodeLoop()
        {
            while (true)
            {
                byte[] frame;
                int width, height;
                lock (_frameLock)
                {
                    while (_newest is null && !_encoderStopped) Monitor.Wait(_frameLock);
                    if (_encoderStopped) return;
                    frame = _newest!;
                    width = _newestW;
                    height = _newestH;
                    _newest = null;
                }

                OnVideoSourceRawSample?.Invoke((uint)(1000 / Math.Max(1, _fps)), width, height, frame, VideoPixelFormatsEnum.Bgra);

                if (OnVideoSourceEncodedSample != null && !_fmtMgr.SelectedFormat.IsEmpty())
                {
                    var encoded = EncodeWithVp9PrimaryVp8Fallback(_encoder, width, height, frame, VideoPixelFormatsEnum.Bgra, _fmtMgr, _log, _sessionId, message => OnVideoSourceError?.Invoke(message));
                    if (encoded != null && encoded.Length > 0)
                    {
                        OnVideoSourceEncodedSample.Invoke((uint)(VIDEO_SAMPLING_RATE / Math.Max(1, _fps)), encoded);
                    }
                }

                lock (_frameLock) _spare ??= frame;
            }
        }

        private void StopEncodeLoop()
        {
            lock (_frameLock)
            {
                _encoderStopped = true;
                Monitor.PulseAll(_frameLock);
            }
        }

        public HelperPipeDesktopVideoSource(int w, int h, int fps, IVideoEncoder encoder, ILogger log, string sessionId)
        {
            _w = w;
            _h = h;
            _fps = Math.Clamp(fps, 1, 30);
            _encoder = encoder;
            _log = log;
            _sessionId = sessionId;

            _fmtMgr = new MediaFormatManager<VideoFormat>(Formats);
            _fmtMgr.SetSelectedFormat(Formats[0]);
        }

        public event RawVideoSampleDelegate? OnVideoSourceRawSample;
#pragma warning disable CS0067
        public event RawVideoSampleFasterDelegate? OnVideoSourceRawSampleFaster;
#pragma warning restore CS0067
        public event EncodedSampleDelegate? OnVideoSourceEncodedSample;
        public event SourceErrorDelegate? OnVideoSourceError;

        public void RestrictFormats(Func<VideoFormat, bool> filter) => _fmtMgr.RestrictFormats(filter);

        public List<VideoFormat> GetVideoSourceFormats() => _fmtMgr.GetSourceFormats();
        public void SetVideoSourceFormat(VideoFormat videoFormat) => _fmtMgr.SetSelectedFormat(videoFormat);

        public List<VideoFormat> GetVideoSinkFormats() => _fmtMgr.GetSourceFormats();
        public void SetVideoSinkFormat(VideoFormat videoFormat) => _fmtMgr.SetSelectedFormat(videoFormat);

        public void ForceKeyFrame() => _encoder.ForceKeyFrame();
        public bool HasEncodedVideoSubscribers() => OnVideoSourceEncodedSample != null;
        public Task<bool> InitialiseVideoSourceDevice() => Task.FromResult(true);
        public bool IsVideoSourcePaused() => false;

        public Task PauseVideo() => Task.CompletedTask;
        public Task ResumeVideo() => Task.CompletedTask;

        public Task StartVideo()
        {
            if (_closed) return Task.CompletedTask;
            if (_started) return Task.CompletedTask;

            _started = true;

            _cts = new CancellationTokenSource();
            _loop = Task.Run(() => RunLoop(_cts.Token));

            return Task.CompletedTask;
        }

        public async Task CloseVideo()
        {
            if (_closed) return;
            _closed = true;

            try { _cts?.Cancel(); } catch { }

            try
            {
                if (_loop != null) await _loop.ConfigureAwait(false);
            }
            catch { }

            _cts?.Dispose();
            _cts = null;
            _loop = null;
        }

        public void Dispose() => _ = CloseVideo();

        public void ExternalVideoSourceRawSample(uint durationMilliseconds, int width, int height, byte[] sample, VideoPixelFormatsEnum pixelFormat)
            => throw new NotImplementedException();

        public void ExternalVideoSourceRawSampleFaster(uint durationMilliseconds, RawImage rawImage)
            => throw new NotImplementedException();

        private const int MaxHelperRestarts = 4;
        private const long HelperStableAfterMs = 30_000;
        private const int ConnectTimeoutMs = 25_000;
        private const int SessionCheckMs = 2000;

        // How long Windows may refuse the screen copy before a different helper is tried.
        private const long BlockedRestartMs = 8_000;

        private volatile bool _systemHelperUnavailable;
        private volatile bool _useSignedInUserHelper;
        private long _blockedSinceMs;
        private volatile int _blockedRetries;
        private volatile bool _helperIsSystem;
        private volatile bool _sessionMoved;
        private int _helperAttempt;
        private ChatHelperLink? _chat;

        private async Task RunLoop(CancellationToken ct)
        {
            new Thread(EncodeLoop) { IsBackground = true, Name = "RemoteConsole encoder" }.Start();

            var restarts = 0;
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    var startedMs = Environment.TickCount64;
                    _sessionMoved = false;
                    try
                    {
                        await RunHelperOnce(ct).ConfigureAwait(false);
                    }
                    catch (Exception) when (ct.IsCancellationRequested)
                    {
                        return;
                    }
                    catch (OperationCanceledException)
                    {
                        _log.LogWarning("RemoteConsole capture helper did not connect in time session={SessionId}", _sessionId);
                    }
                    catch (Exception ex) when (ex is EndOfStreamException or IOException or ObjectDisposedException)
                    {
                        if (!_sessionMoved) _log.LogWarning(ex, "RemoteConsole capture helper disconnected session={SessionId}", _sessionId);
                    }
                    catch (Exception ex)
                    {
                        _log.LogError(ex, "RemoteConsole helper pipe capture loop failed session={SessionId}", _sessionId);
                        OnVideoSourceError?.Invoke(ex.Message);
                        return;
                    }

                    if (ct.IsCancellationRequested) return;

                    // A new session is expected, such as someone signing in. A helper that keeps dying is not.
                    if (Environment.TickCount64 - startedMs >= HelperStableAfterMs) restarts = 0;
                    if (!_sessionMoved && ++restarts > MaxHelperRestarts)
                    {
                        OnVideoSourceError?.Invoke("The screen capture helper on the device stopped. Disconnect and connect again.");
                        return;
                    }

                    _encoder.ForceKeyFrame();
                    await Task.Delay(_sessionMoved ? 200 : 1000, ct).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // the session ended
            }
            finally
            {
                _chat?.Dispose();
                StopEncodeLoop();
            }
        }

        /// <summary>Starts one helper and reads from it until it goes away.</summary>
        private async Task RunHelperOnce(CancellationToken ct)
        {
            var pipeName = $"AdgRmm.RemoteConsole.{_sessionId}.{Interlocked.Increment(ref _helperAttempt)}";
            var secret = GenerateSecret();

            var target = _systemHelperUnavailable || _useSignedInUserHelper || !ConsoleSessions.RunningAsSystem() ? null : ConsoleSessions.FindTarget();
            var asSystem = target is not null;

            // A helper running as SYSTEM connects with the same rights as this service, so the
            // signed-in user gets no access to its pipe at all.
            using var pipe = CreatePipe(pipeName, allowInteractiveUser: !asSystem);

            // The reads below block, and a device showing nothing new sends no frames to wake them.
            // Closing the pipe ends them, and it is also what tells the helper to exit.
            using var closeOnCancel = ct.Register(() =>
            {
                try { pipe.Dispose(); } catch { /* already closed */ }
            });

            // This service runs in Windows' hidden session, whose display size says nothing about the
            // real screen. The helper sees the real one, so only a deliberate setting limits it.
            var forcedSize = ReadUIntEnv("REMOTE_CONSOLE_VIDEO_WIDTH", 0) > 0 || ReadUIntEnv("REMOTE_CONSOLE_VIDEO_HEIGHT", 0) > 0;
            var limit = (int)ReadUIntEnv("REMOTE_CONSOLE_VIDEO_MAX_DIM", 3840);
            if (limit <= 0) limit = 3840;
            var capW = forcedSize ? _w : limit;
            var capH = forcedSize ? _h : limit;

            var arguments = $"--pipe {pipeName} --secret {secret} --w {capW} --h {capH} --fps {_fps}";
            var launchStartedMs = Environment.TickCount64;
            SystemHelperProcess? process = null;
            var taskStarted = false;

            try
            {
                if (asSystem)
                {
                    try
                    {
                        process = SystemHelperProcess.Start(CaptureHelperTask.ResolveHelperPath(), arguments + " --system", target!.Value);
                    }
                    catch (System.ComponentModel.Win32Exception ex)
                    {
                        // Starting as the signed-in user still works for a normal desktop.
                        _log.LogWarning(ex, "RemoteConsole could not start the capture helper as SYSTEM session={SessionId}", _sessionId);
                        _systemHelperUnavailable = true;
                        return;
                    }
                }
                else
                {
                    CaptureHelperTask.EnsureAndRun(pipeName, secret, _w, _h, _fps, _log, _sessionId);
                    taskStarted = true;
                }

                var launchedMs = Environment.TickCount64;

                using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                connectCts.CancelAfter(ConnectTimeoutMs);
                var connecting = pipe.WaitForConnectionAsync(connectCts.Token);
                while (!connecting.IsCompleted)
                {
                    await Task.WhenAny(connecting, Task.Delay(250, ct)).ConfigureAwait(false);
                    if (process is { HasExited: true } && !connecting.IsCompleted)
                        throw new IOException($"The capture helper exited with code {process.ExitCode} before connecting.");
                }
                await connecting.ConfigureAwait(false);

                using var br = new BinaryReader(pipe, Encoding.UTF8, leaveOpen: true);
                Authenticate(br, secret);

                _helperIsSystem = asSystem;
                _commandPipe = pipe;
                if (LocalCursorWanted)
                {
                    TrySendCommand(HelperCommands.SetLocalCursor, 1, 0, null);
                    TrySendCommand(HelperCommands.WatchClipboard, 1, 0, null);
                }

                // Starting a helper takes seconds, so it is ready before anyone sends a chat message.
                if (asSystem)
                {
                    _chat ??= UserHelperFor(_sessionId, _log);
                    _chat.SetHandlers(reply => OnChatText?.Invoke(reply), () => SessionIndicator.RequestEnd(_sessionId));
                    _chat.StartIfSomeoneSignedIn();

                    // The indicator belongs in the user's own helper, never in this one.
                    _chat.ShowIndicator(SessionIndicator.TextFor(_sessionId));
                }
                else if (SessionIndicator.TextFor(_sessionId) is { } indicatorText)
                {
                    var indicatorBytes = Encoding.UTF8.GetBytes(indicatorText);
                    TrySendCommand(HelperCommands.ShowIndicator, indicatorBytes.Length, 0, indicatorBytes);
                }

                _log.LogInformation(
                    "RemoteConsole capture helper connected session={SessionId} asSystem={AsSystem} windowsSession={Target} fps={Fps} launchMs={LaunchMs} connectMs={ConnectMs}",
                    _sessionId, asSystem, target, _fps, launchedMs - launchStartedMs, Environment.TickCount64 - launchedMs);

                Interlocked.Exchange(ref _blockedSinceMs, 0);

                // Windows can refuse a SYSTEM helper's screen copy on a normal desktop, and refuses a
                // signed-in user's on the lock and sign-in screens. A refusal that lasts means this
                // helper cannot do the job right now, so the other kind gets a turn.
                using var blockedWatcher = new Timer(_ =>
                {
                    var since = Interlocked.Read(ref _blockedSinceMs);
                    if (since == 0 || Environment.TickCount64 - since < BlockedRestartMs) return;

                    // A helper whose session was moved to Remote Desktop, or back, is refused until it is replaced, so
                    // a new helper of the same kind gets the first turn. Only a refusal that outlasts that switches kind.
                    if (_blockedRetries == 0)
                    {
                        _blockedRetries = 1;
                        _log.LogWarning(
                            "RemoteConsole starting a new capture helper of the same kind after a refused capture session={SessionId} asSystem={AsSystem}",
                            _sessionId, asSystem);
                        _sessionMoved = true;
                        try { pipe.Dispose(); } catch { /* already closed */ }
                        return;
                    }

                    var canSwitch = ConsoleSessions.RunningAsSystem() && !_systemHelperUnavailable && ConsoleSessions.SomeoneSignedIn();
                    _useSignedInUserHelper = canSwitch && asSystem;
                    _log.LogWarning(
                        "RemoteConsole restarting the capture helper after a refused capture session={SessionId} wasSystem={WasSystem} nextAsSystem={NextAsSystem}",
                        _sessionId, asSystem, !_useSignedInUserHelper);
                    _sessionMoved = true;
                    try { pipe.Dispose(); } catch { /* already closed */ }
                }, null, 2000, 2000);

                // Signing in, switching user or Remote Desktop can move what is on screen to another session.
                using var watcher = asSystem
                    ? new Timer(_ =>
                    {
                        if (ConsoleSessions.FindTarget() is { } now && now != target)
                        {
                            _log.LogInformation("RemoteConsole following Windows session {Old} to {New} session={SessionId}", target, now, _sessionId);
                            _sessionMoved = true;
                            try { pipe.Dispose(); } catch { /* already closed */ }
                        }
                    }, null, SessionCheckMs, SessionCheckMs)
                    : null;

                while (!ct.IsCancellationRequested && pipe.IsConnected)
                {
                    var fw = br.ReadInt32();
                    var fh = br.ReadInt32();
                    var pf = br.ReadInt32();
                    var len = br.ReadInt32();

                    if (pf is HelperCommands.ClipboardTextFormat or HelperCommands.ControlTextFormat or HelperCommands.ChatTextFormat or HelperCommands.EndSessionFormat)
                    {
                        if (len < 0 || len > ClipboardLimitBytes) throw new InvalidOperationException("Bad text length.");
                        var text = Encoding.UTF8.GetString(br.ReadBytes(len));
                        if (pf == HelperCommands.ClipboardTextFormat) OnClipboardText?.Invoke(text);
                        else if (pf == HelperCommands.ControlTextFormat)
                        {
                            // A warning, so it reaches the Windows event log.
                            if (text.Contains("\"capture.blocked\"", StringComparison.Ordinal) && text.Contains("\"blocked\":true", StringComparison.Ordinal))
                            {
                                _log.LogWarning("RemoteConsole capture blocked session={SessionId} asSystem={AsSystem} target={Target}: {Detail}", _sessionId, asSystem, target, text);
                                Interlocked.CompareExchange(ref _blockedSinceMs, Environment.TickCount64, 0);
                            }
                            else if (text.Contains("\"capture.blocked\"", StringComparison.Ordinal))
                            {
                                Interlocked.Exchange(ref _blockedSinceMs, 0);
                            }
                            // Which capture method is in use, and why the faster one could not be.
                            if (text.Contains("\"helper.stats\"", StringComparison.Ordinal) && !text.Contains("\"problem\":null", StringComparison.Ordinal))
                                _log.LogInformation("RemoteConsole capture report session={SessionId}: {Detail}", _sessionId, text);
                            OnControlText?.Invoke(text);
                        }
                        else if (pf == HelperCommands.EndSessionFormat) SessionIndicator.RequestEnd(_sessionId);
                        else OnChatText?.Invoke(text);
                        continue;
                    }

                    if (pf != 1) throw new InvalidOperationException($"Unsupported pixel format {pf}.");

                    // The size follows the monitor being shown. The encoder restarts when it changes.
                    if (fw < 2 || fh < 2 || fw > 7680 || fh > 4320 || len != fw * fh * 4)
                        throw new InvalidOperationException($"Bad frame {fw}x{fh} length {len}.");

                    var data = TakeBuffer(len);
                    pipe.ReadExactly(data, 0, len);
                    Interlocked.Exchange(ref _blockedSinceMs, 0);
                    _blockedRetries = 0;
                    PublishFrame(data, fw, fh);
                }
            }
            finally
            {
                _commandPipe = null;
                try { pipe.Dispose(); } catch { /* already closed */ }
                process?.Dispose();
                if (taskStarted) CaptureHelperTask.Remove(_log, _sessionId);
            }
        }

        private static NamedPipeServerStream CreatePipe(string pipeName, bool allowInteractiveUser)
        {
            var security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));

            // The default ACL only lets administrators write. This helper proves itself with the secret.
            if (allowInteractiveUser)
                security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.InteractiveSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));

            return NamedPipeServerStreamAcl.Create(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 1024 * 1024, 64 * 1024, security);
        }

        private static void Authenticate(BinaryReader br, string secret)
        {
            var m1 = br.ReadByte();
            var m2 = br.ReadByte();
            var m3 = br.ReadByte();
            var m4 = br.ReadByte();
            if (m1 != (byte)'R' || m2 != (byte)'I' || m3 != (byte)'Q' || m4 != (byte)'1')
                throw new InvalidOperationException("Bad pipe magic.");

            var ver = br.ReadInt32();
            if (ver != 1) throw new InvalidOperationException($"Unsupported pipe protocol version {ver}.");

            var secretLen = br.ReadInt32();
            if (secretLen <= 0 || secretLen > 4096) throw new InvalidOperationException("Invalid secret length.");
            var gotSecret = Encoding.UTF8.GetString(br.ReadBytes(secretLen));

            if (!FixedTimeEquals(secret, gotSecret))
                throw new UnauthorizedAccessException("Pipe secret mismatch.");
        }

        /// <summary>Delivers a chat message. A helper running as SYSTEM has no chat window, so another helper shows it.</summary>
        public bool LocalCursorWanted { get; set; }

        public bool TrySendChat(byte[] text)
        {
            if (!_helperIsSystem) return TrySendCommand(HelperCommands.ChatMessage, text.Length, 0, text);

            _chat ??= UserHelperFor(_sessionId, _log);
            _chat.SetHandlers(reply => OnChatText?.Invoke(reply), () => SessionIndicator.RequestEnd(_sessionId));
            return _chat.Send(text);
        }

        /// <summary>The chat window, in a helper running as the signed-in user. It starts with the session, and stays hidden until a message arrives.</summary>
        internal sealed class ChatHelperLink : IDisposable
        {
            private readonly string _sessionId;
            private readonly ILogger _log;
            private Action<string> _onReply;
            private readonly object _gate = new();
            private readonly List<(byte Op, byte[] Data)> _pending = new();
            private readonly CancellationTokenSource _cts = new();
            private NamedPipeServerStream? _pipe;
            private bool _starting;
            private Action? _onEnd;
            private string? _indicatorText;

            // Completed once the helper has connected, or has failed to. The notice and the permission question wait on it.
            private readonly TaskCompletionSource<bool> _connected = new(TaskCreationOptions.RunContinuationsAsynchronously);
            private TaskCompletionSource<string>? _consentAnswer;

            public ChatHelperLink(string sessionId, ILogger log, Action<string> onReply, Action? onEnd = null)
            {
                _sessionId = sessionId;
                _log = log;
                _onReply = onReply;
                _onEnd = onEnd;
            }

            /// <summary>The worker may start this helper before the session exists, and the session takes it over afterwards.</summary>
            public void SetHandlers(Action<string> onReply, Action? onEnd)
            {
                _onReply = onReply;
                _onEnd = onEnd;
            }

            /// <summary>Starts the helper if needed and waits until it is ready, or the time runs out.</summary>
            public async Task<bool> WaitConnectedAsync(int timeoutMs)
            {
                StartIfSomeoneSignedIn();
                var finished = await Task.WhenAny(_connected.Task, Task.Delay(timeoutMs)).ConfigureAwait(false);
                return finished == _connected.Task && _connected.Task.Result;
            }

            /// <summary>
            /// Asks the person in the helper's own window. Returns "allow", "deny" or "timeout", or null when the
            /// helper could not be started in time, so the caller can fall back to Windows' own prompt.
            /// </summary>
            public async Task<string?> AskConsentAsync(string technician, int seconds, int startTimeoutMs)
            {
                if (!await WaitConnectedAsync(startTimeoutMs).ConfigureAwait(false)) return null;

                var answer = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                lock (_gate)
                {
                    if (_pipe is not { IsConnected: true } pipe) return null;
                    _consentAnswer = answer;
                    var json = JsonSerializer.Serialize(new { technician, seconds });
                    Write(pipe, Encoding.UTF8.GetBytes(json), HelperCommands.AskConsent);
                }

                var finished = await Task.WhenAny(answer.Task, Task.Delay(TimeSpan.FromSeconds(seconds + 6))).ConfigureAwait(false);
                return finished == answer.Task ? answer.Task.Result : "timeout";
            }

            /// <summary>Shows the notice in the helper's own window. False when the helper could not be started in time.</summary>
            public async Task<bool> ShowNoticeAsync(string title, string message, int seconds, int startTimeoutMs)
            {
                if (!await WaitConnectedAsync(startTimeoutMs).ConfigureAwait(false)) return false;

                lock (_gate)
                {
                    if (_pipe is not { IsConnected: true } pipe) return false;
                    Write(pipe, Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { title, message, seconds })), HelperCommands.ShowNotice);
                    return true;
                }
            }

            /// <summary>Puts the live-session indicator on the person's screen, once this helper is up.</summary>
            public void ShowIndicator(string? text)
            {
                if (string.IsNullOrWhiteSpace(text)) return;

                lock (_gate)
                {
                    _indicatorText = text;
                    if (_pipe is { IsConnected: true } pipe) Write(pipe, Encoding.UTF8.GetBytes(text), HelperCommands.ShowIndicator);
                }
                StartIfSomeoneSignedIn();
            }

            public void StartIfSomeoneSignedIn()
            {
                lock (_gate)
                {
                    if (_starting || _pipe is { IsConnected: true }) return;
                    if (string.IsNullOrWhiteSpace(InteractiveUserProbe.GetInteractiveUser())) return;
                    _starting = true;
                    _ = Task.Run(RunAsync);
                }
            }

            public bool Send(byte[] text)
            {
                lock (_gate)
                {
                    if (_pipe is { IsConnected: true } pipe)
                    {
                        Write(pipe, text);
                        return true;
                    }

                    // With nobody signed in there is nobody to read it.
                    if (string.IsNullOrWhiteSpace(InteractiveUserProbe.GetInteractiveUser())) return false;

                    _pending.Add((HelperCommands.ChatMessage, text));
                    if (!_starting)
                    {
                        _starting = true;
                        _ = Task.Run(RunAsync);
                    }
                    return true;
                }
            }

            private static void Write(NamedPipeServerStream pipe, byte[] text, byte op = HelperCommands.ChatMessage)
            {
                var buffer = new byte[9 + text.Length];
                buffer[0] = op;
                BitConverter.TryWriteBytes(buffer.AsSpan(1), text.Length);
                text.CopyTo(buffer, 9);
                pipe.Write(buffer, 0, buffer.Length);
                pipe.Flush();
            }

            private async Task RunAsync()
            {
                var taskStarted = false;
                try
                {
                    var pipeName = $"AdgRmm.RemoteConsole.{_sessionId}.Chat";
                    var secret = GenerateSecret();

                    using var pipe = CreatePipe(pipeName, allowInteractiveUser: true);
                    using var closeOnCancel = _cts.Token.Register(() =>
                    {
                        try { pipe.Dispose(); } catch { /* already closed */ }
                    });

                    CaptureHelperTask.EnsureAndRun(pipeName, secret, 64, 64, 1, _log, _sessionId, chatOnly: true);
                    taskStarted = true;

                    using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
                    connectCts.CancelAfter(ConnectTimeoutMs);
                    await pipe.WaitForConnectionAsync(connectCts.Token).ConfigureAwait(false);

                    using var br = new BinaryReader(pipe, Encoding.UTF8, leaveOpen: true);
                    Authenticate(br, secret);

                    lock (_gate)
                    {
                        _pipe = pipe;
                        foreach (var (op, data) in _pending) Write(pipe, data, op);
                        _pending.Clear();
                        if (_indicatorText is { } shown) Write(pipe, Encoding.UTF8.GetBytes(shown), HelperCommands.ShowIndicator);
                    }
                    _connected.TrySetResult(true);

                    while (pipe.IsConnected)
                    {
                        br.ReadInt32();
                        br.ReadInt32();
                        var format = br.ReadInt32();
                        var length = br.ReadInt32();
                        if (length < 0 || length > ClipboardLimitBytes) return;
                        var bytes = br.ReadBytes(length);
                        if (format == HelperCommands.ChatTextFormat) _onReply(Encoding.UTF8.GetString(bytes));
                        else if (format == HelperCommands.EndSessionFormat) _onEnd?.Invoke();
                        else if (format == HelperCommands.ConsentAnswerFormat) _consentAnswer?.TrySetResult(Encoding.UTF8.GetString(bytes));
                    }
                }
                catch (Exception ex) when (!_cts.IsCancellationRequested)
                {
                    _log.LogWarning(ex, "RemoteConsole chat helper stopped session={SessionId}", _sessionId);
                }
                catch (Exception)
                {
                    // the session ended
                }
                finally
                {
                    lock (_gate)
                    {
                        _pipe = null;
                        _starting = false;
                        _pending.Clear();
                    }
                    _connected.TrySetResult(false);
                    _consentAnswer?.TrySetResult("timeout");
                    if (taskStarted) CaptureHelperTask.Remove(_log, _sessionId, chatOnly: true);
                }
            }

            public void Dispose() => _cts.Cancel();
        }

        private static string GenerateSecret()
        {
            Span<byte> b = stackalloc byte[32];
            RandomNumberGenerator.Fill(b);
            return Convert.ToBase64String(b);
        }

        private static bool FixedTimeEquals(string a, string b)
        {
            var ab = Encoding.UTF8.GetBytes(a);
            var bb = Encoding.UTF8.GetBytes(b);
            return CryptographicOperations.FixedTimeEquals(ab, bb);
        }
    }

    // ---------------------------------------------------------------------
    // The helper that belongs to the signed-in user, shared by the worker and the session
    // ---------------------------------------------------------------------

    // The notice and the permission question come before the session exists, and the indicator and chat come
    // after it, so both use the same helper for a session instead of each starting their own.
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, HelperPipeDesktopVideoSource.ChatHelperLink> UserHelpers = new();

    private static HelperPipeDesktopVideoSource.ChatHelperLink UserHelperFor(string sessionId, ILogger log)
        => UserHelpers.GetOrAdd(sessionId, id => new HelperPipeDesktopVideoSource.ChatHelperLink(id, log, _ => { }, null));

    /// <summary>Asks in the user's helper. "allow", "deny" or "timeout", or null if the helper could not be started in time.</summary>
    internal static Task<string?> AskConsentThroughHelperAsync(string sessionId, ILogger log, string? technician, int seconds, int startTimeoutMs)
        => UserHelperFor(sessionId, log).AskConsentAsync(ConsoleSessions.CleanName(technician), seconds, startTimeoutMs);

    /// <summary>Shows the notice in the user's helper. False if the helper could not be started in time.</summary>
    internal static Task<bool> ShowNoticeThroughHelperAsync(string sessionId, ILogger log, string? technician, int seconds, int startTimeoutMs)
        => UserHelperFor(sessionId, log).ShowNoticeAsync(
            "Remote access started",
            $"{ConsoleSessions.CleanName(technician)} from your IT provider has connected to this computer to provide support.",
            seconds, startTimeoutMs);

    /// <summary>Lets go of the helper once the session is over, or was never allowed.</summary>
    internal static void ReleaseUserHelper(string sessionId)
    {
        if (UserHelpers.TryRemove(sessionId, out var link)) link.Dispose();
    }

    private static long _lastEncodeWarningMs = -30_000;

    private static byte[]? EncodeWithVp9PrimaryVp8Fallback(
        IVideoEncoder encoder,
        int w,
        int h,
        byte[] bgra,
        VideoPixelFormatsEnum px,
        MediaFormatManager<VideoFormat> fmtMgr,
        ILogger log,
        string sessionId,
        Action<string>? reportFailure = null)
    {
        var fmt = fmtMgr.SelectedFormat;
        if (fmt.IsEmpty()) return null;

        // Try selected codec first
        try
        {
            var enc = encoder.EncodeVideo(w, h, bgra, px, fmt.Codec);
            if (enc != null && enc.Length > 0) return enc;
        }
        catch (Exception ex)
        {
            // If VP9 fails, drop to VP8
            if (fmt.Codec == VideoCodecsEnum.VP9)
            {
                log.LogWarning(ex, "RemoteConsole VP9 encode failed; falling back to VP8. session={SessionId}", sessionId);
            }
            else
            {
                // This runs for every frame, so it is reported at most every 30 seconds.
                var nowMs = Environment.TickCount64;
                if (nowMs - Interlocked.Read(ref _lastEncodeWarningMs) >= 30_000)
                {
                    Interlocked.Exchange(ref _lastEncodeWarningMs, nowMs);
                    log.LogWarning(ex, "RemoteConsole encode failed codec={Codec} session={SessionId}", fmt.Codec, sessionId);
                    reportFailure?.Invoke($"The video encoder on this device failed: {ex.Message}");
                }
                return null;
            }
        }

        // Fallback: if current is VP9, switch to VP8 and try once
        if (fmt.Codec == VideoCodecsEnum.VP9)
        {
            try
            {
                var vp8 = fmtMgr.GetSourceFormats().FirstOrDefault(f => f.Codec == VideoCodecsEnum.VP8);
                if (!vp8.IsEmpty())
                {
                    fmtMgr.SetSelectedFormat(vp8);
                    log.LogInformation("RemoteConsole switched selected codec to VP8 (fallback) session={SessionId}", sessionId);

                    var enc2 = encoder.EncodeVideo(w, h, bgra, px, vp8.Codec);
                    if (enc2 != null && enc2.Length > 0) return enc2;
                }
            }
            catch (Exception ex2)
            {
                log.LogWarning(ex2, "RemoteConsole VP8 fallback encode failed session={SessionId}", sessionId);
            }
        }

        return null;
    }

    // ---------------------------------------------------------------------
    // Task Scheduler COM launcher (InteractiveToken) - needs REAL userId
    // ---------------------------------------------------------------------

    private static class CaptureHelperTask
    {
        public static void EnsureAndRun(string pipeName, string secret, int w, int h, int fps, ILogger log, string sessionId, bool chatOnly = false)
        {
            var helperExe = ResolveHelperPath();
            if (string.IsNullOrWhiteSpace(helperExe) || !File.Exists(helperExe))
                throw new FileNotFoundException($"Capture helper not found at '{helperExe}'. Ensure it is deployed next to the agent service.");

            var user = InteractiveUserProbe.GetInteractiveUser();
            log.LogInformation("RemoteConsole capture helper target interactive user session={SessionId} user='{User}'", sessionId, user ?? "(null)");

            if (string.IsNullOrWhiteSpace(user))
                throw new InvalidOperationException("Nobody is signed in at this device's screen, so there is no desktop to show. Remote Shell and File Browser still work.");

            var taskName = TaskName(sessionId, chatOnly);
            var args = $"--pipe {pipeName} --secret {secret} --w {w} --h {h} --fps {fps}" + (chatOnly ? " --chat-only" : "");

            var workDir = Path.GetDirectoryName(helperExe) ?? AppContext.BaseDirectory;

            TaskSchedulerCom.CreateOrUpdateAndRunInteractiveTask(
                taskName: taskName,
                exePath: helperExe,
                arguments: args,
                workingDirectory: workDir,
                description: "ADG RMM Remote Console desktop capture helper",
                userId: user,
                log: log,
                sessionId: sessionId
            );
        }

        // The task's arguments hold the session secret, and its start trigger would otherwise fire
        // once more after a short session.
        public static void Remove(ILogger log, string sessionId, bool chatOnly = false)
        {
            try
            {
                TaskSchedulerCom.Delete(TaskName(sessionId, chatOnly));
            }
            catch (Exception ex)
            {
                log.LogWarning("RemoteConsole could not remove the capture task session={SessionId}: {Message}", sessionId, ex.Message);
            }
        }

        private static string TaskName(string sessionId, bool chatOnly) =>
            $"AdgRmm.RemoteConsole.Capture.{sessionId}" + (chatOnly ? ".Chat" : "");

        public static string ResolveHelperPath()
        {
            // In a single-file app AppContext.BaseDirectory is the temporary extraction folder,
            // so the install folder has to come from the running executable.
            var installDir = Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;

            var p1 = Path.Combine(installDir, "tools", "capture-helper", "AdgRmm.CaptureHelper.exe");
            if (File.Exists(p1)) return p1;

            var p2 = Path.Combine(installDir, "AdgRmm.CaptureHelper.exe");
            if (File.Exists(p2)) return p2;

            return p1;
        }
    }

    private static class TaskSchedulerCom
    {
        private const int TASK_TRIGGER_TIME = 1;
        private const int TASK_ACTION_EXEC = 0;
        private const int TASK_CREATE_OR_UPDATE = 6;

        private const int TASK_LOGON_INTERACTIVE_TOKEN = 3;
        private const int TASK_RUNLEVEL_HIGHEST = 1;

        public static void Delete(string taskName)
        {
            var svcType = Type.GetTypeFromProgID("Schedule.Service")
                ?? throw new InvalidOperationException("Task Scheduler COM (Schedule.Service) not available.");
            dynamic service = Activator.CreateInstance(svcType)
                ?? throw new InvalidOperationException("Failed to create Schedule.Service COM instance.");
            service.Connect();
            dynamic root = service.GetFolder("\\");
            root.DeleteTask(taskName, 0);
        }

        // Each session registers a task, so finished ones are cleared or they pile up forever.
        private static void DeleteFinishedTasks(dynamic root, ILogger log, string sessionId)
        {
            const int TASK_ENUM_HIDDEN = 1;
            const int TASK_STATE_RUNNING = 4;

            try
            {
                var finished = new List<string>();
                dynamic tasks = root.GetTasks(TASK_ENUM_HIDDEN);
                int count = tasks.Count;
                for (var i = 1; i <= count; i++)
                {
                    dynamic task = tasks[i];
                    string name = task.Name;
                    int state = task.State;
                    if (name.StartsWith("AdgRmm.RemoteConsole.Capture.", StringComparison.Ordinal) && state != TASK_STATE_RUNNING)
                        finished.Add(name);
                }

                foreach (var name in finished)
                {
                    try { root.DeleteTask(name, 0); } catch { /* it may have just been removed */ }
                }

                if (finished.Count > 0)
                    log.LogInformation("RemoteConsole removed {Count} finished capture task(s) session={SessionId}", finished.Count, sessionId);
            }
            catch (Exception ex)
            {
                log.LogWarning("RemoteConsole could not clean up capture tasks session={SessionId}: {Message}", sessionId, ex.Message);
            }
        }

        public static void CreateOrUpdateAndRunInteractiveTask(
            string taskName,
            string exePath,
            string arguments,
            string workingDirectory,
            string description,
            string userId,
            ILogger log,
            string sessionId)
        {
            var svcType = Type.GetTypeFromProgID("Schedule.Service")
                ?? throw new InvalidOperationException("Task Scheduler COM (Schedule.Service) not available.");

            dynamic service = Activator.CreateInstance(svcType)
                ?? throw new InvalidOperationException("Failed to create Schedule.Service COM instance.");

            service.Connect();
            dynamic root = service.GetFolder("\\");

            try { root.DeleteTask(taskName, 0); } catch { }
            DeleteFinishedTasks(root, log, sessionId);

            dynamic def = service.NewTask(0);

            def.RegistrationInfo.Description = description;

            def.Principal.UserId = userId;
            def.Principal.LogonType = TASK_LOGON_INTERACTIVE_TOKEN;
            def.Principal.RunLevel = TASK_RUNLEVEL_HIGHEST;

            def.Settings.Enabled = true;
            def.Settings.Hidden = true;
            def.Settings.AllowDemandStart = true;
            def.Settings.DisallowStartIfOnBatteries = false;
            def.Settings.StopIfGoingOnBatteries = false;
            def.Settings.ExecutionTimeLimit = "PT0S";
            def.Settings.MultipleInstances = 0; // IgnoreNew

            dynamic triggers = def.Triggers;
            dynamic trigger = triggers.Create(TASK_TRIGGER_TIME);
            var start = DateTime.Now.AddSeconds(30);
            trigger.StartBoundary = start.ToString("yyyy-MM-dd'T'HH:mm:ss");

            dynamic actions = def.Actions;
            dynamic action = actions.Create(TASK_ACTION_EXEC);
            action.Path = exePath;
            action.Arguments = arguments;
            action.WorkingDirectory = workingDirectory;

            log.LogInformation(
                "RemoteConsole registering task session={SessionId} task='{Task}' userId='{UserId}' exe='{Exe}' args='{Args}' wd='{Wd}'",
                sessionId, taskName, userId, exePath, "[hidden]", workingDirectory
            );

            dynamic registered = root.RegisterTaskDefinition(
                taskName,
                def,
                TASK_CREATE_OR_UPDATE,
                userId,
                null,
                TASK_LOGON_INTERACTIVE_TOKEN,
                null
            );

            log.LogInformation(
                "RemoteConsole task registered session={SessionId} task='{Task}'",
                sessionId, taskName
            );

            dynamic running = registered.Run(null);

            try
            {
                var state = (int)running.State;
                log.LogInformation("RemoteConsole task started session={SessionId} task='{Task}' state={State}", sessionId, taskName, state);
            }
            catch
            {
                log.LogInformation("RemoteConsole task started session={SessionId} task='{Task}'", sessionId, taskName);
            }
        }
    }

    private static class InteractiveUserProbe
    {
        public static string? GetInteractiveUser()
        {
            try
            {
                using var searcher = new ManagementObjectSearcher("SELECT UserName FROM Win32_ComputerSystem");
                foreach (var o in searcher.Get())
                {
                    if (o is ManagementObject mo)
                    {
                        var user = (mo["UserName"] as string ?? "").Trim();
                        if (!string.IsNullOrWhiteSpace(user))
                            return user;
                    }
                }
            }
            catch { }

            // Nobody at the console does not mean nobody is signed in: the user's session may be shown over
            // Remote Desktop, where the console user above comes back empty.
            try
            {
                var shown = ConsoleSessions.TargetUser();
                if (!string.IsNullOrWhiteSpace(shown)) return shown;
            }
            catch { }

            try
            {
                var sessionId = WTSGetActiveConsoleSessionId();
                if (sessionId == 0xFFFFFFFF) return null;

                if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, WTS_INFO_CLASS.WTSUserName, out var pUser, out var _))
                    return null;

                if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, WTS_INFO_CLASS.WTSDomainName, out var pDomain, out var _2))
                {
                    WTSFreeMemory(pUser);
                    return null;
                }

                var user = PtrToString(pUser);
                var domain = PtrToString(pDomain);

                WTSFreeMemory(pUser);
                WTSFreeMemory(pDomain);

                if (string.IsNullOrWhiteSpace(user)) return null;
                if (string.IsNullOrWhiteSpace(domain)) return user;
                return $"{domain}\\{user}";
            }
            catch
            {
                return null;
            }
        }

        private static string PtrToString(IntPtr p)
        {
            if (p == IntPtr.Zero) return "";
            return Marshal.PtrToStringUni(p) ?? "";
        }

        private enum WTS_INFO_CLASS
        {
            WTSUserName = 5,
            WTSDomainName = 7
        }

        [DllImport("kernel32.dll")]
        private static extern uint WTSGetActiveConsoleSessionId();

        // Unicode, because the result is read as UTF-16. A garbled name would stop the capture helper from starting.
        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool WTSQuerySessionInformation(
            IntPtr hServer,
            uint sessionId,
            WTS_INFO_CLASS wtsInfoClass,
            out IntPtr ppBuffer,
            out uint pBytesReturned);

        [DllImport("wtsapi32.dll")]
        private static extern void WTSFreeMemory(IntPtr pMemory);
    }

    // ---------------------------------------------------------------------
    // GDI capture helpers (only used when NOT session0)
    // ---------------------------------------------------------------------

    private static class Gdi
    {
        public static byte[]? CapturePrimaryScreenBgraScaled(int targetW, int targetH, out string error)
        {
            error = "";
            try
            {
                var primary = DesktopGeometry.ReadCurrent(false).Primary;
                var srcW = Math.Max(1, primary.Width);
                var srcH = Math.Max(1, primary.Height);

                var native = DirectScreen.CaptureVirtualRectBgra(primary.Left, primary.Top, srcW, srcH);
                if (srcW == targetW && srcH == targetH) return native;
                return ImageScale.ScaleBgraBilinear(native, srcW, srcH, targetW, targetH);
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return null;
            }
        }
    }

    private static class ImageScale
    {
        public static byte[] ScaleBgraBilinear(byte[] src, int srcW, int srcH, int dstW, int dstH)
        {
            var dst = new byte[dstW * dstH * 4];
            ScaleBgraBilinearInto(src, srcW, srcH, dst, dstW, dstH);
            return dst;
        }

        public static void ScaleBgraBilinearInto(byte[] src, int srcW, int srcH, byte[] dst, int dstW, int dstH)
        {
            if (dst.Length < dstW * dstH * 4) throw new ArgumentException("dst too small");

            double xScale = (double)(srcW - 1) / Math.Max(1, dstW - 1);
            double yScale = (double)(srcH - 1) / Math.Max(1, dstH - 1);

            for (int y = 0; y < dstH; y++)
            {
                double sy = y * yScale;
                int y0 = (int)sy;
                int y1 = Math.Min(y0 + 1, srcH - 1);
                double fy = sy - y0;

                int dstRow = y * dstW * 4;
                int srcRow0 = y0 * srcW * 4;
                int srcRow1 = y1 * srcW * 4;

                for (int x = 0; x < dstW; x++)
                {
                    double sx = x * xScale;
                    int x0 = (int)sx;
                    int x1 = Math.Min(x0 + 1, srcW - 1);
                    double fx = sx - x0;

                    int i00 = srcRow0 + x0 * 4;
                    int i10 = srcRow0 + x1 * 4;
                    int i01 = srcRow1 + x0 * 4;
                    int i11 = srcRow1 + x1 * 4;

                    int d = dstRow + x * 4;

                    for (int c = 0; c < 4; c++)
                    {
                        double p00 = src[i00 + c];
                        double p10 = src[i10 + c];
                        double p01 = src[i01 + c];
                        double p11 = src[i11 + c];

                        double a = p00 + (p10 - p00) * fx;
                        double b = p01 + (p11 - p01) * fx;
                        double v = a + (b - a) * fy;

                        dst[d + c] = (byte)Math.Clamp((int)Math.Round(v), 0, 255);
                    }
                }
            }
        }
    }

    private static class DirectScreen
    {
        private const int SRCCOPY = 0x00CC0020;
        private const int CAPTUREBLT = 0x40000000;
        private const uint BI_RGB = 0;
        private const uint DIB_RGB_COLORS = 0;

        public static byte[] CaptureVirtualRectBgra(int x, int y, int w, int h)
        {
            IntPtr hDesk = GetDesktopWindow();
            IntPtr hSrcDc = GetWindowDC(hDesk);
            if (hSrcDc == IntPtr.Zero)
                throw new InvalidOperationException("GetWindowDC returned NULL.");

            IntPtr hMemDc = IntPtr.Zero;
            IntPtr hBmp = IntPtr.Zero;
            IntPtr hOld = IntPtr.Zero;

            try
            {
                hMemDc = CreateCompatibleDC(hSrcDc);
                if (hMemDc == IntPtr.Zero) throw new InvalidOperationException("CreateCompatibleDC returned NULL.");

                var bmi = new BITMAPINFO();
                bmi.bmiHeader.biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>();
                bmi.bmiHeader.biWidth = w;
                bmi.bmiHeader.biHeight = -h;
                bmi.bmiHeader.biPlanes = 1;
                bmi.bmiHeader.biBitCount = 32;
                bmi.bmiHeader.biCompression = BI_RGB;

                IntPtr ppvBits;
                hBmp = CreateDIBSection(hSrcDc, ref bmi, DIB_RGB_COLORS, out ppvBits, IntPtr.Zero, 0);
                if (hBmp == IntPtr.Zero || ppvBits == IntPtr.Zero)
                    throw new InvalidOperationException("CreateDIBSection failed.");

                hOld = SelectObject(hMemDc, hBmp);
                if (hOld == IntPtr.Zero) throw new InvalidOperationException("SelectObject failed.");

                bool ok = BitBlt(hMemDc, 0, 0, w, h, hSrcDc, x, y, SRCCOPY | CAPTUREBLT);
                if (!ok)
                {
                    var err = Marshal.GetLastWin32Error();
                    throw new InvalidOperationException($"BitBlt failed. GetLastError={err} (0x{err:X8}).");
                }

                int bytes = w * h * 4;
                byte[] buffer = new byte[bytes];
                Marshal.Copy(ppvBits, buffer, 0, bytes);
                return buffer;
            }
            finally
            {
                if (hOld != IntPtr.Zero && hMemDc != IntPtr.Zero) SelectObject(hMemDc, hOld);
                if (hBmp != IntPtr.Zero) DeleteObject(hBmp);
                if (hMemDc != IntPtr.Zero) DeleteDC(hMemDc);
                if (hSrcDc != IntPtr.Zero) ReleaseDC(hDesk, hSrcDc);
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BITMAPINFO
        {
            public BITMAPINFOHEADER bmiHeader;
            public uint bmiColors;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BITMAPINFOHEADER
        {
            public uint biSize;
            public int biWidth;
            public int biHeight;
            public ushort biPlanes;
            public ushort biBitCount;
            public uint biCompression;
            public uint biSizeImage;
            public int biXPelsPerMeter;
            public uint biYPelsPerMeter;
            public uint biClrUsed;
            public uint biClrImportant;
        }

        [DllImport("user32.dll")]
        private static extern IntPtr GetDesktopWindow();

        [DllImport("user32.dll")]
        private static extern IntPtr GetWindowDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool DeleteObject(IntPtr ho);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern IntPtr CreateDIBSection(
            IntPtr hdc,
            [In] ref BITMAPINFO pbmi,
            uint iUsage,
            out IntPtr ppvBits,
            IntPtr hSection,
            uint dwOffset);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool BitBlt(
            IntPtr hdcDest,
            int xDest,
            int yDest,
            int wDest,
            int hDest,
            IntPtr hdcSrc,
            int xSrc,
            int ySrc,
            int rop);
    }

    private static uint ReadUIntEnv(string name, uint fallback)
    {
        var raw = (Environment.GetEnvironmentVariable(name) ?? "").Trim();
        if (uint.TryParse(raw, out var v) && v > 0) return v;
        return fallback;
    }

    // ---------------------------------------------------------------------
    // SDP utilities (Prefer VP9 primary, VP8 fallback + set bitrate hints)
    // ---------------------------------------------------------------------

    private static class SdpUtil
    {
        public static string PreferVp9Vp8AndSetBitrateHints(string sdp, int startKbps, int maxKbps)
        {
            if (string.IsNullOrWhiteSpace(sdp)) return sdp;

            var lines = sdp.Replace("\r\n", "\n").Split('\n').Select(l => l.TrimEnd()).ToList();
            int videoM = lines.FindIndex(l => l.StartsWith("m=video ", StringComparison.OrdinalIgnoreCase));
            if (videoM < 0) return sdp;

            var vp9Pts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var vp8Pts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < lines.Count; i++)
            {
                var l = lines[i];
                if (!l.StartsWith("a=rtpmap:", StringComparison.OrdinalIgnoreCase)) continue;

                var rest = l.Substring("a=rtpmap:".Length);
                var sp = rest.IndexOf(' ');
                if (sp <= 0) continue;
                var pt = rest.Substring(0, sp).Trim();
                var codec = rest.Substring(sp + 1).Trim();

                if (codec.StartsWith("VP9/", StringComparison.OrdinalIgnoreCase)) vp9Pts.Add(pt);
                if (codec.StartsWith("VP8/", StringComparison.OrdinalIgnoreCase)) vp8Pts.Add(pt);
            }

            // Prefer VP9 first, then VP8
            if (vp9Pts.Count > 0 || vp8Pts.Count > 0)
            {
                var m = lines[videoM];
                var parts = m.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 4)
                {
                    var header = parts.Take(3).ToList();
                    var pts = parts.Skip(3).ToList();

                    string? firstVp9 = pts.FirstOrDefault(p => vp9Pts.Contains(p));
                    string? firstVp8 = pts.FirstOrDefault(p => vp8Pts.Contains(p));

                    // Move VP9 to front if present; else move VP8 to front.
                    if (!string.IsNullOrWhiteSpace(firstVp9))
                    {
                        pts.Remove(firstVp9);
                        pts.Insert(0, firstVp9);
                    }
                    else if (!string.IsNullOrWhiteSpace(firstVp8))
                    {
                        pts.Remove(firstVp8);
                        pts.Insert(0, firstVp8);
                    }

                    lines[videoM] = string.Join(' ', header.Concat(pts));
                }
            }

            int insertAt = videoM + 1;
            while (insertAt < lines.Count &&
                   (lines[insertAt].StartsWith("i=", StringComparison.OrdinalIgnoreCase) ||
                    lines[insertAt].StartsWith("c=", StringComparison.OrdinalIgnoreCase)))
            {
                insertAt++;
            }

            int end = FindSectionEnd(lines, videoM);

            // remove existing b=AS/b=TIAS in video section
            for (int i = end - 1; i > videoM; i--)
            {
                if (lines[i].StartsWith("b=AS:", StringComparison.OrdinalIgnoreCase) ||
                    lines[i].StartsWith("b=TIAS:", StringComparison.OrdinalIgnoreCase))
                {
                    lines.RemoveAt(i);
                    end--;
                }
            }

            var max = Math.Clamp(maxKbps, 300, 300_000);

            lines.Insert(insertAt++, $"b=AS:{max}");
            lines.Insert(insertAt++, $"b=TIAS:{max * 1000}");
            lines.Insert(insertAt++, "a=content:screen");

            // Add bitrate hints for both VP9 and VP8 if present
            var min = 12000;
            foreach (var pt in vp9Pts.Concat(vp8Pts))
            {
                lines.Insert(insertAt++, $"a=fmtp:{pt} x-google-min-bitrate={min};x-google-start-bitrate={min};x-google-max-bitrate={max};x-google-denoise=false;x-google-conference=true;googCpuOveruseDetection=false;googNoiseReduction=false;googHighStartBitrate=true");
            }

            return string.Join("\r\n", lines.Where(l => l.Length > 0)) + "\r\n";
        }

        private static int FindSectionEnd(List<string> lines, int sectionStart)
        {
            for (int i = sectionStart + 1; i < lines.Count; i++)
            {
                if (lines[i].StartsWith("m=", StringComparison.OrdinalIgnoreCase))
                    return i;
            }
            return lines.Count;
        }
    }

    // ---------------------------------------------------------------------
    // Desktop geometry (virtual screen + primary monitor in virtual coords)
    // ---------------------------------------------------------------------

    private readonly struct DesktopGeometry
    {
        public readonly Rect Primary;
        public readonly Rect Virtual;
        public readonly bool IsUnknown;

        public DesktopGeometry(Rect primary, Rect virt, bool unknown = false)
        {
            Primary = primary;
            Virtual = virt;
            IsUnknown = unknown;
        }

        public static DesktopGeometry Unknown => new(new Rect(0, 0, 0, 0), new Rect(0, 0, 0, 0), unknown: true);

        public static DesktopGeometry ReadCurrent(bool isSession0)
        {
            try
            {
                int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
                int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
                int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
                int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);

                var virt = new Rect(vx, vy, Math.Max(1, vw), Math.Max(1, vh));

                Rect primary = isSession0 ? ProbeWmiHighestResolution() : MonitorUtil.GetPrimaryMonitorRect();

                if (primary.Width <= 0 || primary.Height <= 0)
                {
                    int pw = GetSystemMetrics(SM_CXSCREEN);
                    int ph = GetSystemMetrics(SM_CYSCREEN);
                    primary = new Rect(0, 0, Math.Max(1, pw), Math.Max(1, ph));
                }

                return new DesktopGeometry(primary, virt, unknown: false);
            }
            catch
            {
                return Unknown;
            }
        }

        private static Rect ProbeWmiHighestResolution()
        {
            try
            {
                using var searcher = new ManagementObjectSearcher("SELECT CurrentHorizontalResolution, CurrentVerticalResolution FROM Win32_VideoController WHERE CurrentHorizontalResolution IS NOT NULL");
                int bestW = 0;
                int bestH = 0;
                foreach (var o in searcher.Get())
                {
                    var w = Convert.ToInt32(o["CurrentHorizontalResolution"]);
                    var h = Convert.ToInt32(o["CurrentVerticalResolution"]);
                    if (w > bestW) { bestW = w; bestH = h; }
                }
                if (bestW > 0) return new Rect(0, 0, bestW, bestH);
            }
            catch { }
            return new Rect(0, 0, 0, 0);
        }

        private const int SM_CXSCREEN = 0;
        private const int SM_CYSCREEN = 1;
        private const int SM_XVIRTUALSCREEN = 76;
        private const int SM_YVIRTUALSCREEN = 77;
        private const int SM_CXVIRTUALSCREEN = 78;
        private const int SM_CYVIRTUALSCREEN = 79;

        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int nIndex);
    }

    private readonly struct Rect
    {
        public readonly int Left;
        public readonly int Top;
        public readonly int Width;
        public readonly int Height;

        public Rect(int left, int top, int width, int height)
        {
            Left = left;
            Top = top;
            Width = width;
            Height = height;
        }

        public int Right => Left + Width;
        public int Bottom => Top + Height;

        public override string ToString() => $"[{Left},{Top} {Width}x{Height}]";
    }

    private static class MonitorUtil
    {
        public static Rect GetPrimaryMonitorRect()
        {
            Rect primary = new Rect(0, 0, 0, 0);

            IntPtr hPrimary = MonitorFromPoint(new POINT { x = 0, y = 0 }, MONITOR_DEFAULTTOPRIMARY);
            if (hPrimary == IntPtr.Zero) return primary;

            var mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf<MONITORINFO>();
            if (!GetMonitorInfo(hPrimary, ref mi)) return primary;

            var rc = mi.rcMonitor;
            int w = rc.right - rc.left;
            int h = rc.bottom - rc.top;
            return new Rect(rc.left, rc.top, w, h);
        }

        private const uint MONITOR_DEFAULTTOPRIMARY = 1;

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int left, top, right, bottom; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
    }

    // ---------------------------------------------------------------------
    // DPI helper
    // ---------------------------------------------------------------------

    private static class DpiUtil
    {
        public static void TryEnablePerMonitorV2()
        {
            try
            {
                SetProcessDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
            }
            catch { }
        }

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiFlag);
    }

    // ---------------------------------------------------------------------
    // Input injection helpers
    // ---------------------------------------------------------------------

    private enum MouseButton { Left, Right, Middle }

    // Must match AdgRmm.CaptureHelper.
    private static class HelperCommands
    {
        public const byte MoveMouse = 1;
        public const byte MouseEvent = 2;
        public const byte Key = 3;
        public const byte SetClipboard = 4;
        public const byte GetClipboard = 5;
        public const byte SelectMonitor = 6;
        public const byte ChatMessage = 7;
        public const byte SetLocalCursor = 8;
        public const byte WatchClipboard = 9;
        public const byte SetResolution = 10;
        public const byte ShowIndicator = 11;
        public const byte HideIndicator = 12;
        public const byte ShowNotice = 13;
        public const byte AskConsent = 14;
        public const byte LockInput = 15;
        public const int ClipboardTextFormat = 2;
        public const int ControlTextFormat = 3;
        public const int ChatTextFormat = 4;
        public const int EndSessionFormat = 5;
        public const int ConsentAnswerFormat = 6;
    }

    private sealed class RemoteInputInjector
    {
        private bool _altDown, _ctrlDown, _shiftDown, _metaDown;

        // Letters and other keys held when focus leaves the page would otherwise stay down.
        private readonly HashSet<ushort> _keysDown = new();

        /// <summary>When set, input is sent here instead of being injected from this process.</summary>
        public Action<byte, int, int>? Sink { get; set; }

        public void ReleaseAll()
        {
            if (_shiftDown) Key(VK_SHIFT, false);
            if (_ctrlDown) Key(VK_CONTROL, false);
            if (_altDown) Key(VK_MENU, false);
            if (_metaDown) Key(VK_LWIN, false);

            foreach (var vk in _keysDown) Key(vk, false);
            _keysDown.Clear();

            _altDown = _ctrlDown = _shiftDown = _metaDown = false;
        }

        public void SyncModifiers(bool alt, bool ctrl, bool shift, bool meta)
        {
            if (alt != _altDown) { Key(VK_MENU, alt); _altDown = alt; }
            if (ctrl != _ctrlDown) { Key(VK_CONTROL, ctrl); _ctrlDown = ctrl; }
            if (shift != _shiftDown) { Key(VK_SHIFT, shift); _shiftDown = shift; }
            if (meta != _metaDown) { Key(VK_LWIN, meta); _metaDown = meta; }
        }

        public void SetCursorPos(int x, int y)
        {
            try { SetCursorPosNative(x, y); } catch { }
        }

        public void MouseBtn(bool down, MouseButton button)
        {
            uint flag = 0;
            if (button == MouseButton.Left) flag = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
            else if (button == MouseButton.Right) flag = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
            else if (button == MouseButton.Middle) flag = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;

            SendMouse(flag, 0);
        }

        public void MouseWheelVertical(int delta)
        {
            SendMouse(MOUSEEVENTF_WHEEL, delta);
        }

        public void MouseWheelHorizontal(int delta)
        {
            SendMouse(MOUSEEVENTF_HWHEEL, delta);
        }

        public void Key(ushort vk, bool down)
        {
            SendKey(vk, down);
        }

        public void PressKey(ushort vk, bool down)
        {
            if (down) _keysDown.Add(vk);
            else _keysDown.Remove(vk);
            SendKey(vk, down);
        }

        private void SendMouse(uint flags, int mouseData)
        {
            if (Sink is { } sink) { sink(HelperCommands.MouseEvent, (int)flags, mouseData); return; }

            INPUT[] inputs = new INPUT[1];
            inputs[0] = new INPUT
            {
                type = INPUT_MOUSE,
                U = new InputUnion
                {
                    mi = new MOUSEINPUT
                    {
                        dx = 0,
                        dy = 0,
                        mouseData = (uint)mouseData,
                        dwFlags = flags,
                        time = 0,
                        dwExtraInfo = IntPtr.Zero
                    }
                }
            };
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        }

        private void SendKey(ushort vk, bool down)
        {
            if (Sink is { } sink) { sink(HelperCommands.Key, vk, down ? 1 : 0); return; }

            INPUT[] inputs = new INPUT[1];
            inputs[0] = new INPUT
            {
                type = INPUT_KEYBOARD,
                U = new InputUnion
                {
                    ki = new KEYBDINPUT
                    {
                        wVk = vk,
                        wScan = 0,
                        dwFlags = down ? 0u : KEYEVENTF_KEYUP,
                        time = 0,
                        dwExtraInfo = IntPtr.Zero
                    }
                }
            };
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        }

        private const ushort VK_SHIFT = 0x10;
        private const ushort VK_CONTROL = 0x11;
        private const ushort VK_MENU = 0x12;
        private const ushort VK_LWIN = 0x5B;

        private const uint INPUT_MOUSE = 0;
        private const uint INPUT_KEYBOARD = 1;

        private const uint KEYEVENTF_KEYUP = 0x0002;

        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        private const uint MOUSEEVENTF_WHEEL = 0x0800;
        private const uint MOUSEEVENTF_HWHEEL = 0x01000;

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;
            public InputUnion U;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion
        {
            [FieldOffset(0)]
            public MOUSEINPUT mi;

            [FieldOffset(0)]
            public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [DllImport("user32.dll", EntryPoint = "SetCursorPos")]
        private static extern bool SetCursorPosNative(int X, int Y);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    }

    // ---------------------------------------------------------------------
    // DataChannel wiring + control message handling
    // ---------------------------------------------------------------------

    private void HookInputChannel(RTCDataChannel dc)
    {
        try
        {
            dc.onopen += () =>
            {
                _log.LogInformation("RemoteConsole input dc open session={SessionId}", SessionId);
                FlushPendingTerminal();
            };
            dc.onclose += () => _log.LogInformation("RemoteConsole input dc closed session={SessionId}", SessionId);

            AddDataChannelOnMessage(dc, (obj) =>
            {
                try
                {
                    // A bare newline matters: Enter on an empty line is how a terminal asks for a new prompt.
                    var text = obj?.ToString() ?? "";
                    if (text.Length == 0) return;
                    OnTextFromTech?.Invoke(text);
                }
                catch (Exception ex)
                {
                    _log.LogWarning(ex, "RemoteConsole terminal input failed session={SessionId}", SessionId);
                }
            });

            // A channel announced by the browser may already be open, in which case onopen never fires.
            FlushPendingTerminal();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "HookInputChannel failed session={SessionId}", SessionId);
        }
    }

    private void HookControlChannel(RTCDataChannel dc)
    {
        try
        {
            dc.onopen += () => _log.LogInformation("RemoteConsole control dc open session={SessionId}", SessionId);
            dc.onclose += () => _log.LogInformation("RemoteConsole control dc closed session={SessionId}", SessionId);

            AddDataChannelOnMessage(dc, (obj) =>
            {
                try
                {
                    var raw = obj?.ToString() ?? "";
                    if (string.IsNullOrWhiteSpace(raw)) return;

                    using var doc = JsonDocument.Parse(raw);
                    var root = doc.RootElement;

                    OnControlFromTech?.Invoke(root);
                    HandleControl(root);
                }
                catch (Exception ex)
                {
                    _log.LogWarning(ex, "RemoteConsole control message failed session={SessionId}", SessionId);
                }
            });

            dc.onopen += ResendLatestControl;
            ResendLatestControl();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "HookControlChannel failed session={SessionId}", SessionId);
        }
    }

    private void HookClipboardChannel(RTCDataChannel dc)
    {
        AddDataChannelOnMessage(dc, (obj) =>
        {
            try
            {
                var raw = obj?.ToString() ?? "";
                if (string.IsNullOrWhiteSpace(raw)) return;

                using var doc = JsonDocument.Parse(raw);
                var type = doc.RootElement.TryGetProperty("type", out var t) ? t.GetString() : null;

                var delivered = true;
                if (type == "clipboard.get")
                {
                    delivered = _helperSource?.TrySendCommand(HelperCommands.GetClipboard, 0, 0, null) ?? false;
                }
                else if (type == "clipboard.set" && doc.RootElement.TryGetProperty("text", out var text))
                {
                    var bytes = Encoding.UTF8.GetBytes(text.GetString() ?? "");
                    delivered = bytes.Length <= HelperPipeDesktopVideoSource.ClipboardLimitBytes &&
                                (_helperSource?.TrySendCommand(HelperCommands.SetClipboard, bytes.Length, 0, bytes) ?? false);
                }

                if (!delivered)
                    TryDcSend(dc, JsonSerializer.Serialize(new { type = "clipboard.error", message = "The clipboard could not be reached because the screen capture helper is not connected." }));
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "RemoteConsole clipboard message failed session={SessionId}", SessionId);
            }
        });
    }

    private void SendClipboardToTech(string text)
    {
        try
        {
            _clipboardDc?.send(JsonSerializer.Serialize(new { type = "clipboard.set", text }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "RemoteConsole could not send clipboard session={SessionId}", SessionId);
            TryDcSend(_clipboardDc, JsonSerializer.Serialize(new { type = "clipboard.error", message = "The clipboard on the device is too large to send." }));
        }
    }

    private void HookChatChannel(RTCDataChannel dc)
    {
        AddDataChannelOnMessage(dc, (obj) =>
        {
            var raw = obj?.ToString() ?? "";
            if (string.IsNullOrWhiteSpace(raw)) return;

            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var t) || t.GetString() != "chat.msg") return;
            if (!root.TryGetProperty("text", out var textEl)) return;

            var bytes = Encoding.UTF8.GetBytes(textEl.GetString() ?? "");
            if (bytes.Length == 0) return;

            var delivered = _helperSource?.TrySendChat(bytes) ?? false;
            if (!delivered)
            {
                TryDcSend(dc, JsonSerializer.Serialize(new
                {
                    type = "chat.error",
                    message = "That message was not delivered, because nobody is signed in at the device to read it. It needs someone signed in at the screen.",
                }));
            }
        });
    }

    private void SendChatToTech(string text)
    {
        if (!TryDcSend(_chatDc, JsonSerializer.Serialize(new { type = "chat.msg", text })))
            _log.LogWarning("RemoteConsole could not deliver a chat reply session={SessionId}", SessionId);
    }

    private void SendControlToTech(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("type", out var t) && t.GetString() is { } type)
                _latestControl[type] = json;
        }
        catch (JsonException ex)
        {
            _log.LogWarning(ex, "RemoteConsole got an unreadable control message session={SessionId}", SessionId);
            return;
        }

        TryDcSend(_controlDc, json);
    }

    private void ResendLatestControl()
    {
        foreach (var json in _latestControl.Values) TryDcSend(_controlDc, json);
    }

    private void FlushPendingTerminal()
    {
        lock (_terminalLock)
        {
            if (_pendingTerminal.Length == 0 || _inputDc?.readyState != RTCDataChannelState.open) return;
            if (TryDcSend(_inputDc, _pendingTerminal.ToString())) _pendingTerminal.Clear();
        }
    }

    private long _lastMouseSeq;

    private void NoteMouseSeq(JsonElement msg)
    {
        if (msg.TryGetProperty("seq", out var seq) && seq.TryGetInt64(out var number) && number > _lastMouseSeq) _lastMouseSeq = number;
    }

    private bool _inputLocked;
    private Timer? _lockBeat;

    /// <summary>Locks or unlocks the keyboard and mouse of the person at the computer. Only a technician in this session can ask, and it lets go when the session ends.</summary>
    private void SetInputLock(bool on)
    {
        if (on && _helperSource is not { } helper)
        {
            SendControlToTech(JsonSerializer.Serialize(new { type = "input.lock.state", locked = false, ok = false, message = "There is no helper on this computer's screen to lock the keyboard and mouse with." }));
            return;
        }
        if (on)
        {
            if (!_helperSource!.TrySendCommand(HelperCommands.LockInput, 1, 0, null)) return;
            _inputLocked = true;
            // the helper unlocks by itself when this stops, so a broken connection cannot leave the person locked out
            _lockBeat ??= new Timer(_ => { try { if (_inputLocked && !_closed) _helperSource?.TrySendCommand(HelperCommands.LockInput, 1, 0, null); } catch { } }, null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));
            _log.LogInformation("RemoteConsole keyboard and mouse of the person at the computer locked session={SessionId}", SessionId);
        }
        else
        {
            ReleaseInputLock();
        }
    }

    private void ReleaseInputLock()
    {
        var was = _inputLocked;
        _inputLocked = false;
        try { _lockBeat?.Dispose(); } catch { }
        _lockBeat = null;
        try { _helperSource?.TrySendCommand(HelperCommands.LockInput, 0, 0, null); } catch { }
        if (was) _log.LogInformation("RemoteConsole keyboard and mouse unlocked session={SessionId}", SessionId);
    }

    private void HandleControl(JsonElement msg)
    {
        if (_closed) return;

        var type = msg.TryGetProperty("type", out var t) ? (t.GetString() ?? "") : "";
        if (string.IsNullOrWhiteSpace(type)) return;

        if (_desktopGeom.IsUnknown)
        {
            try
            {
                var proc = Process.GetCurrentProcess();
                _desktopGeom = DesktopGeometry.ReadCurrent(proc.SessionId == 0);
            }
            catch { }
        }

        try
        {
            switch (type)
            {
                case "focus":
                case "blur":
                    _input.ReleaseAll();
                    break;

                case "video.codec":
                    // The browser could not show the H.264 picture (or asks for VP8 for another reason).
                    if (msg.TryGetProperty("prefer", out var preferred) && preferred.GetString() == "vp8")
                        FallBackFromH264(msg.TryGetProperty("reason", out var why) ? "the browser reported: " + why.GetString() : "the browser asked for VP8");
                    break;

                case "cursor.local":
                    if (_helperSource is { } cursorHelper)
                    {
                        cursorHelper.LocalCursorWanted = true;
                        cursorHelper.TrySendCommand(HelperCommands.SetLocalCursor, 1, 0, null);
                        cursorHelper.TrySendCommand(HelperCommands.WatchClipboard, 1, 0, null);
                    }
                    SendControlToTech(JsonSerializer.Serialize(new { type = "agent.caps", move = true, localCursor = _helperSource is not null, inputLock = _helperSource is not null }));
                    break;

                case "mouse.move":
                    // Movement can arrive out of order on its channel, and only the newest position matters.
                    if (msg.TryGetProperty("seq", out var moveSeq) && moveSeq.TryGetInt64(out var moveNumber))
                    {
                        if (moveNumber <= _lastMouseSeq) break;
                        _lastMouseSeq = moveNumber;
                    }
                    HandleMouseMove(msg);
                    break;

                case "mouse.down":
                    NoteMouseSeq(msg);
                    HandleMouseButton(msg, down: true);
                    break;

                case "mouse.up":
                    NoteMouseSeq(msg);
                    HandleMouseButton(msg, down: false);
                    break;

                case "mouse.wheel":
                    HandleMouseWheel(msg);
                    break;

                case "key.down":
                    HandleKey(msg, down: true);
                    break;

                case "key.up":
                    HandleKey(msg, down: false);
                    break;

                case "keys.sas":
                    _ = Task.Run(() => SecureAttention.Send(_log));
                    break;

                case "input.lock":
                    SetInputLock(msg.TryGetProperty("locked", out var lockEl) && lockEl.ValueKind == JsonValueKind.True);
                    break;

                case "monitor.select":
                    if (msg.TryGetProperty("index", out var indexEl) && indexEl.TryGetInt32(out var index))
                        _helperSource?.TrySendCommand(HelperCommands.SelectMonitor, index, 0, null);
                    break;

                case "display.set":
                    // The helper only accepts sizes the display itself lists, so a bad request changes nothing.
                    if (msg.TryGetProperty("w", out var widthEl) && widthEl.TryGetInt32(out var displayWidth)
                        && msg.TryGetProperty("h", out var heightEl) && heightEl.TryGetInt32(out var displayHeight))
                    {
                        _log.LogInformation("RemoteConsole display size change to {W}x{H} requested session={SessionId}", displayWidth, displayHeight, SessionId);
                        _helperSource?.TrySendCommand(HelperCommands.SetResolution, displayWidth, displayHeight, null);
                    }
                    break;
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "RemoteConsole control handling failed session={SessionId} type={Type}", SessionId, type);
        }
    }

    private void HandleMouseMove(JsonElement msg)
    {
        var (alt, ctrl, shift, meta) = ReadMods(msg);
        _input.SyncModifiers(alt, ctrl, shift, meta);

        if (!TryReadDouble(msg, "x", out var nx)) return;
        if (!TryReadDouble(msg, "y", out var ny)) return;

        MoveCursor(nx, ny);
    }

    // The helper knows which monitor is on screen and its real size, so it does the mapping itself.
    // From Session 0 this process cannot see the display layout.
    private void MoveCursor(double nx, double ny)
    {
        if (_input.Sink is { } sink)
        {
            sink(HelperCommands.MoveMouse, (int)Math.Round(Clamp01(nx) * 65535), (int)Math.Round(Clamp01(ny) * 65535));
            return;
        }

        var p = MapNormToDesktop(nx, ny);
        _input.SetCursorPos(p.x, p.y);
    }

    private void HandleMouseButton(JsonElement msg, bool down)
    {
        var (alt, ctrl, shift, meta) = ReadMods(msg);
        _input.SyncModifiers(alt, ctrl, shift, meta);

        if (TryReadDouble(msg, "x", out var nx) && TryReadDouble(msg, "y", out var ny))
        {
            MoveCursor(nx, ny);
        }

        // The Back and Forward side buttons must not act as a left click.
        int btn = msg.TryGetProperty("button", out var b) ? b.GetInt32() : 0;
        MouseButton which;
        switch (btn)
        {
            case 0: which = MouseButton.Left; break;
            case 1: which = MouseButton.Middle; break;
            case 2: which = MouseButton.Right; break;
            default: return;
        }

        _input.MouseBtn(down, which);
    }

    private void HandleMouseWheel(JsonElement msg)
    {
        var (alt, ctrl, shift, meta) = ReadMods(msg);
        _input.SyncModifiers(alt, ctrl, shift, meta);

        double dx = 0;
        double dy = 0;

        if (TryReadDouble(msg, "dx", out var ddx)) dx = ddx;
        if (TryReadDouble(msg, "dy", out var ddy)) dy = ddy;

        var mode = msg.TryGetProperty("mode", out var m) ? m.GetString() : "pixel";

        // Browsers report scrolling down as positive and Windows as negative. Sideways they agree.
        int notchesY = _wheelY.Add(dy, mode);
        int notchesX = _wheelX.Add(dx, mode);

        if (notchesY != 0) _input.MouseWheelVertical(-notchesY * WheelNotch);
        if (notchesX != 0) _input.MouseWheelHorizontal(notchesX * WheelNotch);
    }

    private void HandleKey(JsonElement msg, bool down)
    {
        var (alt, ctrl, shift, meta) = ReadMods(msg);
        _input.SyncModifiers(alt, ctrl, shift, meta);

        var code = msg.TryGetProperty("code", out var c) ? (c.GetString() ?? "") : "";
        var key = msg.TryGetProperty("key", out var k) ? (k.GetString() ?? "") : "";

        if (RemoteKeyMap.TryMapKey(code, key, out var vk))
        {
            _input.PressKey(vk, down);
        }
    }

    private (int x, int y) MapNormToDesktop(double nx, double ny)
    {
        nx = Clamp01(nx);
        ny = Clamp01(ny);

        var primary = _desktopGeom.Primary;
        if (primary.Width <= 0 || primary.Height <= 0)
        {
            primary = new Rect(0, 0, 1920, 1080);
        }

        int x = primary.Left + (int)Math.Round(nx * (primary.Width - 1));
        int y = primary.Top + (int)Math.Round(ny * (primary.Height - 1));

        return (x, y);
    }

    private static double Clamp01(double v) => v < 0 ? 0 : (v > 1 ? 1 : v);

    private const int WheelNotch = 120;
    private readonly WheelAccumulator _wheelX = new();
    private readonly WheelAccumulator _wheelY = new();

    /// <summary>
    /// Turns browser scroll amounts into whole wheel notches. A mouse wheel reports about 100 pixels
    /// a notch, while a trackpad sends many small amounts that must add up rather than each scroll a notch.
    /// </summary>
    private sealed class WheelAccumulator
    {
        private const double PixelsPerNotch = 100;
        private const double PixelsPerLine = 33;
        private const double PixelsPerPage = 300;
        private const int MaxNotchesAtOnce = 6;

        private double _pixels;

        public int Add(double delta, string? mode)
        {
            if (delta == 0) return 0;

            var pixels = delta * (mode == "line" ? PixelsPerLine : mode == "page" ? PixelsPerPage : 1);

            // Changing direction should respond at once, not first pay off what was left over.
            if (Math.Sign(pixels) != Math.Sign(_pixels)) _pixels = 0;
            _pixels += pixels;

            var notches = (int)(_pixels / PixelsPerNotch);
            _pixels -= notches * PixelsPerNotch;
            return Math.Clamp(notches, -MaxNotchesAtOnce, MaxNotchesAtOnce);
        }
    }

    private static (bool alt, bool ctrl, bool shift, bool meta) ReadMods(JsonElement msg)
    {
        try
        {
            if (!msg.TryGetProperty("mods", out var m) || m.ValueKind != JsonValueKind.Object)
                return (false, false, false, false);

            bool alt = m.TryGetProperty("alt", out var a) && a.ValueKind == JsonValueKind.True;
            bool ctrl = m.TryGetProperty("ctrl", out var c) && c.ValueKind == JsonValueKind.True;
            bool shift = m.TryGetProperty("shift", out var s) && s.ValueKind == JsonValueKind.True;
            bool meta = m.TryGetProperty("meta", out var me) && me.ValueKind == JsonValueKind.True;

            return (alt, ctrl, shift, meta);
        }
        catch
        {
            return (false, false, false, false);
        }
    }

    private static bool TryReadDouble(JsonElement obj, string prop, out double value)
    {
        value = 0;
        if (!obj.TryGetProperty(prop, out var p)) return false;

        try
        {
            if (p.ValueKind == JsonValueKind.Number) { value = p.GetDouble(); return true; }
            if (p.ValueKind == JsonValueKind.String && double.TryParse(p.GetString(), out var d)) { value = d; return true; }
        }
        catch { }
        return false;
    }

    private void HookDataChannelDynamic(RTCDataChannel dc)
    {
        if (dc == null) return;

        if (!_dcMembersDumped)
        {
            _dcMembersDumped = true;
            try
            {
                var t = dc.GetType();
                var methods = t.GetMethods(BindingFlags.Instance | BindingFlags.Public)
                    .Select(m => m.Name)
                    .Distinct()
                    .OrderBy(x => x)
                    .ToArray();
                _log.LogDebug("RTCDataChannel public methods: {Methods}", string.Join(", ", methods));
            }
            catch { }
        }
    }

    private void AddDataChannelOnMessage(RTCDataChannel dc, Action<object?> onMessageValue)
    {
        if (dc == null) return;

        var label = dc.label;
        var seenFirst = false;

        dc.onmessage += (_, _, data) =>
        {
            if (!seenFirst)
            {
                seenFirst = true;
                _log.LogInformation("RemoteConsole first message on {Label} session={SessionId}", label, SessionId);
            }

            try
            {
                onMessageValue(data == null ? null : Encoding.UTF8.GetString(data));
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "RemoteConsole could not handle a message on {Label} session={SessionId}", label, SessionId);
            }
        };
    }

    private static Delegate CombineDelegate(Delegate? existing, Delegate add)
    {
        if (existing == null) return add;
        try { return Delegate.Combine(existing, add); } catch { return add; }
    }

    private Delegate BuildOnMessageDelegate(RTCDataChannel dc, Type delegateType, Action<object?> onMessageValue)
    {
        var invoke = delegateType.GetMethod("Invoke");
        var parms = invoke?.GetParameters() ?? Array.Empty<ParameterInfo>();

        if (parms.Length == 0)
        {
            Action handler0 = () =>
            {
                object? val = TryGetLastDcMessage(dc);
                onMessageValue(val);
            };
            return Delegate.CreateDelegate(delegateType, handler0.Target!, handler0.Method);
        }

        if (parms.Length == 1)
        {
            var p0 = parms[0].ParameterType;
            var wrapper = new OnMessageWrapper(dc, onMessageValue);
            var mi = typeof(OnMessageWrapper).GetMethod(nameof(OnMessageWrapper.Invoke1), BindingFlags.Instance | BindingFlags.Public)!.MakeGenericMethod(p0);
            return Delegate.CreateDelegate(delegateType, wrapper, mi);
        }

        if (parms.Length == 2)
        {
            var p0 = parms[0].ParameterType;
            var p1 = parms[1].ParameterType;

            var wrapper = new OnMessageWrapper(dc, onMessageValue);
            var mi = typeof(OnMessageWrapper).GetMethod(nameof(OnMessageWrapper.Invoke2), BindingFlags.Instance | BindingFlags.Public)!.MakeGenericMethod(p0, p1);
            return Delegate.CreateDelegate(delegateType, wrapper, mi);
        }

        Action fallback = () => onMessageValue(TryGetLastDcMessage(dc));
        return Delegate.CreateDelegate(delegateType, fallback.Target!, fallback.Method);
    }

    private sealed class OnMessageWrapper
    {
        private readonly RTCDataChannel _dc;
        private readonly Action<object?> _sink;

        public OnMessageWrapper(RTCDataChannel dc, Action<object?> sink)
        {
            _dc = dc;
            _sink = sink;
        }

        public void Invoke1<T0>(T0 a0)
        {
            _sink(ExtractMessageValue(a0) ?? TryGetLastDcMessage(_dc));
        }

        public void Invoke2<T0, T1>(T0 a0, T1 a1)
        {
            _sink(ExtractMessageValue(a0) ?? ExtractMessageValue(a1) ?? TryGetLastDcMessage(_dc));
        }

        private static object? ExtractMessageValue(object? obj)
        {
            if (obj == null) return null;

            try
            {
                var t = obj.GetType();
                var prop = t.GetProperty("data", BindingFlags.Instance | BindingFlags.Public | BindingFlags.IgnoreCase);
                if (prop != null)
                {
                    var d = prop.GetValue(obj);
                    return d ?? obj;
                }
            }
            catch { }

            return obj;
        }
    }

    private static object? TryGetLastDcMessage(RTCDataChannel dc)
    {
        try
        {
            var t = dc.GetType();

            var candidates = new[]
            {
                "lastMessage", "LastMessage",
                "last_message", "Last_Message",
                "lastMessageString", "LastMessageString",
                "lastMessageData", "LastMessageData",
                "message", "Message"
            };

            foreach (var name in candidates)
            {
                var p = t.GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                if (p != null)
                {
                    var v = p.GetValue(dc);
                    if (v != null) return v;
                }

                var f = t.GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                if (f != null)
                {
                    var v = f.GetValue(dc);
                    if (v != null) return v;
                }
            }

            foreach (var mName in new[] { "receive", "Receive", "read", "Read" })
            {
                var m = t.GetMethod(mName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, Type.DefaultBinder, Type.EmptyTypes, null);
                if (m != null)
                {
                    var v = m.Invoke(dc, Array.Empty<object>());
                    if (v != null) return v;
                }
            }
        }
        catch { }

        return null;
    }

    private static bool TryDcSend(RTCDataChannel? dc, string text)
    {
        if (dc == null) return false;

        try
        {
            var t = dc.GetType();
            var m = t.GetMethod("send", new[] { typeof(string) }) ?? t.GetMethod("Send", new[] { typeof(string) });
            if (m == null) return false;
            m.Invoke(dc, new object[] { text });
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void TryDcClose(RTCDataChannel? dc)
    {
        if (dc == null) return;

        try
        {
            var t = dc.GetType();
            var m = t.GetMethod("close", Type.EmptyTypes) ?? t.GetMethod("Close", Type.EmptyTypes);
            m?.Invoke(dc, Array.Empty<object>());
        }
        catch { }
    }

    private static void TryConfigureEncoderBestEffort(IVideoEncoder enc, int startKbps, int maxKbps, int fps, ILogger log, string sessionId)
    {
        try
        {
            var t = enc.GetType();
            void SetInt(string name, int value)
            {
                var p = t.GetProperty(name, BindingFlags.Instance | BindingFlags.Public);
                if (p != null && p.CanWrite && p.PropertyType == typeof(int))
                {
                    p.SetValue(enc, value);
                }
            }

            SetInt("TargetBitrate", startKbps);
            SetInt("Bitrate", startKbps);
            SetInt("MaxBitrate", maxKbps);
            SetInt("MaxKbps", maxKbps);
            SetInt("FramesPerSecond", fps);
            SetInt("FPS", fps);

            log.LogInformation("RemoteConsole encoder configured best-effort session={SessionId} startKbps={Start} maxKbps={Max} fps={Fps}", sessionId, startKbps, maxKbps, fps);
        }
        catch (Exception ex)
        {
            log.LogDebug(ex, "RemoteConsole encoder configure best-effort failed session={SessionId}", sessionId);
        }
    }

    private static async Task<bool> SetRemoteDescriptionCompatAsync(RTCPeerConnection pc, RTCSessionDescriptionInit desc, ILogger log, string sessionId)
    {
        try
        {
            var mi = pc.GetType().GetMethod("setRemoteDescription", new[] { typeof(RTCSessionDescriptionInit) });
            if (mi == null) throw new MissingMethodException("RTCPeerConnection.setRemoteDescription not found.");

            var result = mi.Invoke(pc, new object[] { desc });
            if (result is Task task)
            {
                await task.ConfigureAwait(false);
                return true;
            }

            if (result is SetDescriptionResultEnum en)
            {
                if (en != SetDescriptionResultEnum.OK)
                    log.LogWarning("RemoteConsole setRemoteDescription returned {Result} session={SessionId}", en, sessionId);
                return en == SetDescriptionResultEnum.OK;
            }

            return true;
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "RemoteConsole setRemoteDescription failed session={SessionId}", sessionId);
            return false;
        }
    }

    private static async Task<bool> SetLocalDescriptionCompatAsync(RTCPeerConnection pc, RTCSessionDescriptionInit desc, ILogger log, string sessionId)
    {
        try
        {
            var mi = pc.GetType().GetMethod("setLocalDescription", new[] { typeof(RTCSessionDescriptionInit) });
            if (mi == null) throw new MissingMethodException("RTCPeerConnection.setLocalDescription not found.");

            var result = mi.Invoke(pc, new object[] { desc });
            if (result is Task task)
            {
                await task.ConfigureAwait(false);
                return true;
            }

            if (result is SetDescriptionResultEnum en)
            {
                if (en != SetDescriptionResultEnum.OK)
                    log.LogWarning("RemoteConsole setLocalDescription returned {Result} session={SessionId}", en, sessionId);
                return en == SetDescriptionResultEnum.OK;
            }

            return true;
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "RemoteConsole setLocalDescription failed session={SessionId}", sessionId);
            return false;
        }
    }

    private static async Task AddIceCandidateCompatAsync(RTCPeerConnection pc, RTCIceCandidateInit cand, ILogger log, string sessionId)
    {
        try
        {
            var mi = pc.GetType().GetMethod("addIceCandidate", new[] { typeof(RTCIceCandidateInit) });
            if (mi == null) throw new MissingMethodException("RTCPeerConnection.addIceCandidate not found.");

            var result = mi.Invoke(pc, new object[] { cand });
            if (result is Task task)
            {
                await task.ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "RemoteConsole addIceCandidate failed session={SessionId}", sessionId);
        }
    }

    // ---------------------------------------------------------------------
    // IWebRtcConsolePeer interface compliance
    // ---------------------------------------------------------------------

    public async Task HandleSignalAsync(object signal, CancellationToken ct)
    {
        if (ct.IsCancellationRequested) return;
        if (_closed) return;

        EnsurePeerCreated();
        var pc = _pc;
        if (pc == null) return;

        JsonElement? je = null;

        try
        {
            if (signal is JsonElement j0)
            {
                je = j0;
            }
            else if (signal is string s && !string.IsNullOrWhiteSpace(s))
            {
                using var doc = JsonDocument.Parse(s);
                je = doc.RootElement.Clone();
            }
            else
            {
                var json = JsonSerializer.Serialize(signal);
                using var doc = JsonDocument.Parse(json);
                je = doc.RootElement.Clone();
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "RemoteConsole HandleSignalAsync: unable to parse signal session={SessionId}", SessionId);
            return;
        }

        if (je == null) return;
        var root = je.Value;

        var type = root.TryGetProperty("type", out var t) ? (t.GetString() ?? "") : "";

        if (string.Equals(type, "tech.hangup", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(type, "hangup", StringComparison.OrdinalIgnoreCase))
        {
            await CloseAsync("hangup", ct).ConfigureAwait(false);
            return;
        }

        if (string.Equals(type, "offer", StringComparison.OrdinalIgnoreCase))
        {
            var sdp = root.TryGetProperty("sdp", out var s) ? (s.GetString() ?? "") : "";
            if (string.IsNullOrWhiteSpace(sdp)) return;

            try
            {
                var okRemote = await SetRemoteDescriptionCompatAsync(pc, new RTCSessionDescriptionInit
                {
                    type = RTCSdpType.offer,
                    sdp = sdp
                }, _log, SessionId).ConfigureAwait(false);

                if (!okRemote)
                {
                    _log.LogWarning("RemoteConsole setRemoteDescription failed (compat) session={SessionId}", SessionId);
                }

                // Which codec this session sends, decided here because only now is the browser's offer known.
                var decision = ConsoleCodecNegotiation.Decide(_h264Allowed ? _codecSetting : ConsoleVideoCodecSetting.Vp8, H264Support.Cached, ConsoleCodecNegotiation.ParseOffer(sdp));
                if (decision.Codec == ConsoleVideoCodec.H264 && !StartH264(decision, out var h264Problem))
                    decision = new ConsoleCodecDecision(ConsoleVideoCodec.Vp8, decision.Vp8PayloadType, null, "H.264 could not be started: " + h264Problem);
                _codecDecision = decision;
                _log.LogInformation("RemoteConsole video codec chosen={Codec} reason={Reason} session={SessionId}", decision.Codec, decision.Reason, SessionId);
                AnnounceCodec();

                var answer = pc.createAnswer(null);
                var answerSdp = answer?.sdp ?? "";

                // ✅ Prefer VP9 primary, VP8 fallback + bitrate hints
                answerSdp = AddRtcpFeedback(ConsoleCodecNegotiation.ApplyToAnswer(SdpUtil.PreferVp9Vp8AndSetBitrateHints(answerSdp, _targetKbps, _maxKbps), decision));

                var okLocal = await SetLocalDescriptionCompatAsync(pc, new RTCSessionDescriptionInit
                {
                    type = RTCSdpType.answer,
                    sdp = answerSdp
                }, _log, SessionId).ConfigureAwait(false);

                if (!okLocal)
                {
                    _log.LogWarning("RemoteConsole setLocalDescription failed (compat) session={SessionId}", SessionId);
                }

                OnSignalToSend?.Invoke(new
                {
                    type = "answer",
                    sdp = answerSdp
                });

                _log.LogInformation("RemoteConsole answered offer session={SessionId}", SessionId);
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "RemoteConsole failed to handle offer session={SessionId}", SessionId);
            }

            return;
        }

        if (root.TryGetProperty("candidate", out var candProp))
        {
            var candStr = candProp.GetString() ?? "";
            if (string.IsNullOrWhiteSpace(candStr)) return;

            try
            {
                string? sdpMid = null;
                ushort sdpMLineIndex = 0;

                if (root.TryGetProperty("sdpMid", out var mid) && mid.ValueKind == JsonValueKind.String)
                    sdpMid = mid.GetString();

                if (root.TryGetProperty("sdpMLineIndex", out var mli) && mli.ValueKind == JsonValueKind.Number)
                {
                    var idx = mli.GetInt32();
                    if (idx >= 0 && idx <= ushort.MaxValue) sdpMLineIndex = (ushort)idx;
                }

                CountCandidate(_remoteCandidates, candStr);

                await AddIceCandidateCompatAsync(pc, new RTCIceCandidateInit
                {
                    candidate = candStr,
                    sdpMid = sdpMid,
                    sdpMLineIndex = sdpMLineIndex
                }, _log, SessionId).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "RemoteConsole addIceCandidate failed session={SessionId}", SessionId);
            }

            return;
        }

        if (string.Equals(type, "answer", StringComparison.OrdinalIgnoreCase))
        {
            _log.LogDebug("RemoteConsole got unexpected answer on agent side session={SessionId} (ignored)", SessionId);
            return;
        }
    }

    public Task SendTextAsync(string text, CancellationToken ct)
    {
        if (ct.IsCancellationRequested) return Task.FromCanceled(ct);
        if (_closed) return Task.CompletedTask;

        lock (_terminalLock)
        {
            var open = _inputDc?.readyState == RTCDataChannelState.open;
            if (!open || !TryDcSend(_inputDc, text ?? string.Empty))
            {
                _pendingTerminal.Append(text);
                if (_pendingTerminal.Length > PendingTerminalLimitChars)
                    _pendingTerminal.Remove(0, _pendingTerminal.Length - PendingTerminalLimitChars);
            }
        }
        return Task.CompletedTask;
    }

    public async Task CloseAsync(string reason, CancellationToken ct)
    {
        if (_closed) return;

        _closed = true;

        // The technician is gone: the person gets their keyboard and mouse back, before anything else is torn down.
        try { ReleaseInputLock(); } catch { }

        try { StopKeyframeTimer(); } catch { }

        // First, because the capture side may be waiting on it.
        StopVideoSender();

        try
        {
            await StopVideoBestEffortAsync().ConfigureAwait(false);
        }
        catch { }

        // Closing the pipe above makes the helper release anything still held and exit.
        try { TryDcClose(_inputDc); } catch { }
        try { TryDcClose(_controlDc); } catch { }
        try { TryDcClose(_chatDc); } catch { }
        try { TryDcClose(_clipboardDc); } catch { }

        _inputDc = null;
        _controlDc = null;
        _chatDc = null;
        _clipboardDc = null;
        _helperSource = null;

        try
        {
            _videoTrack = null;
            _videoSource = null;
            _videoEncoder = null;
            _videoAttached = false;
            _videoStarted = false;
        }
        catch { }

        try
        {
            _pc?.Close(reason ?? "closed");
        }
        catch { }

        _pc = null;

        await Task.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        await CloseAsync("dispose", CancellationToken.None).ConfigureAwait(false);
    }

    private static class RemoteKeyMap
    {
        public static bool TryMapKey(string code, string key, out ushort vk)
        {
            vk = 0;

            var c = (code ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(c))
            {
                if (TryMapCode(c, out vk)) return true;
            }

            var k = (key ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(k))
            {
                if (TryMapKeyValue(k, out vk)) return true;
            }

            return false;
        }

        private static bool TryMapCode(string code, out ushort vk)
        {
            vk = 0;

            if (code.Length == 4 && code.StartsWith("Key", StringComparison.OrdinalIgnoreCase))
            {
                char ch = code[3];
                if (ch >= 'A' && ch <= 'Z') { vk = (ushort)ch; return true; }
            }

            if (code.Length == 6 && code.StartsWith("Digit", StringComparison.OrdinalIgnoreCase))
            {
                char ch = code[5];
                if (ch >= '0' && ch <= '9') { vk = (ushort)ch; return true; }
            }

            switch (code)
            {
                case "Enter": vk = 0x0D; return true;
                case "NumpadEnter": vk = 0x0D; return true;
                case "Tab": vk = 0x09; return true;
                case "Escape": vk = 0x1B; return true;
                case "Backspace": vk = 0x08; return true;
                case "Space": vk = 0x20; return true;

                case "ArrowLeft": vk = 0x25; return true;
                case "ArrowUp": vk = 0x26; return true;
                case "ArrowRight": vk = 0x27; return true;
                case "ArrowDown": vk = 0x28; return true;

                case "Delete": vk = 0x2E; return true;
                case "Insert": vk = 0x2D; return true;
                case "Home": vk = 0x24; return true;
                case "End": vk = 0x23; return true;
                case "PageUp": vk = 0x21; return true;
                case "PageDown": vk = 0x22; return true;

                case "F1": vk = 0x70; return true;
                case "F2": vk = 0x71; return true;
                case "F3": vk = 0x72; return true;
                case "F4": vk = 0x73; return true;
                case "F5": vk = 0x74; return true;
                case "F6": vk = 0x75; return true;
                case "F7": vk = 0x76; return true;
                case "F8": vk = 0x77; return true;
                case "F9": vk = 0x78; return true;
                case "F10": vk = 0x79; return true;
                case "F11": vk = 0x7A; return true;
                case "F12": vk = 0x7B; return true;

                case "Minus": vk = 0xBD; return true;
                case "Equal": vk = 0xBB; return true;
                case "BracketLeft": vk = 0xDB; return true;
                case "BracketRight": vk = 0xDD; return true;
                case "Backslash": vk = 0xDC; return true;
                case "Semicolon": vk = 0xBA; return true;
                case "Quote": vk = 0xDE; return true;
                case "Backquote": vk = 0xC0; return true;
                case "Comma": vk = 0xBC; return true;
                case "Period": vk = 0xBE; return true;
                case "Slash": vk = 0xBF; return true;
                case "IntlBackslash": vk = 0xE2; return true;

                case "CapsLock": vk = 0x14; return true;
                case "NumLock": vk = 0x90; return true;
                case "ScrollLock": vk = 0x91; return true;
                case "Pause": vk = 0x13; return true;
                case "PrintScreen": vk = 0x2C; return true;
                case "ContextMenu": vk = 0x5D; return true;

                case "Numpad0": vk = 0x60; return true;
                case "Numpad1": vk = 0x61; return true;
                case "Numpad2": vk = 0x62; return true;
                case "Numpad3": vk = 0x63; return true;
                case "Numpad4": vk = 0x64; return true;
                case "Numpad5": vk = 0x65; return true;
                case "Numpad6": vk = 0x66; return true;
                case "Numpad7": vk = 0x67; return true;
                case "Numpad8": vk = 0x68; return true;
                case "Numpad9": vk = 0x69; return true;
                case "NumpadMultiply": vk = 0x6A; return true;
                case "NumpadAdd": vk = 0x6B; return true;
                case "NumpadSubtract": vk = 0x6D; return true;
                case "NumpadDecimal": vk = 0x6E; return true;
                case "NumpadDivide": vk = 0x6F; return true;
            }

            return false;
        }

        private static bool TryMapKeyValue(string key, out ushort vk)
        {
            vk = 0;

            if (key.Length == 1)
            {
                char ch = char.ToUpperInvariant(key[0]);
                if (ch >= 'A' && ch <= 'Z') { vk = (ushort)ch; return true; }
                if (ch >= '0' && ch <= '9') { vk = (ushort)ch; return true; }
            }

            switch (key)
            {
                case "Enter": vk = 0x0D; return true;
                case "Tab": vk = 0x09; return true;
                case "Escape": vk = 0x1B; return true;
                case "Backspace": vk = 0x08; return true;
                case " ": vk = 0x20; return true;

                case "ArrowLeft": vk = 0x25; return true;
                case "ArrowUp": vk = 0x26; return true;
                case "ArrowRight": vk = 0x27; return true;
                case "ArrowDown": vk = 0x28; return true;

                case "Delete": vk = 0x2E; return true;
                case "Insert": vk = 0x2D; return true;
                case "Home": vk = 0x24; return true;
                case "End": vk = 0x23; return true;
                case "PageUp": vk = 0x21; return true;
                case "PageDown": vk = 0x22; return true;
            }

            return false;
        }
    }
}
