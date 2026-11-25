// agents/windows/RemoteIQ.Agent/Services/ConsoleVideoSender.cs

using System.Diagnostics;
using SIPSorcery.Net;

namespace RemoteIQ.Agent.Services;

/// <summary>The video codecs the console can send. VP8 is the default and the fallback for everything else.</summary>
public enum ConsoleVideoCodec
{
    Vp8,
    H264,
}

/// <summary>
/// Sends VP8 or H.264 frames as RTP on its own thread. A frame depends on the one before it, so a single
/// lost packet stops the picture until a keyframe arrives, and a keyframe is hundreds of packets
/// that all have to survive. Resending what the browser reports missing is what keeps video moving
/// on a real network. Packets are spread out so the sender does not cause that loss itself.
/// </summary>
public sealed class ConsoleVideoSender : IDisposable
{
    // Leaves room for relay and VPN headers, because oversized packets vanish while small control
    // messages still pass.
    private const int MaxPayload = 1100;
    private const int HistorySize = 4096;
    private const int BurstBytes = 12_000;
    private const int MinBytesPerMs = 60;
    private const int MaxResends = 3;
    private const long MinResendGapMs = 30;
    private const long MaxResendAgeMs = 1000;
    private const long KeyframeSettleMs = 300;
    private const long MinKeyframeGapMs = 500;
    private const uint RtpUnitsPerMs = 90;

    // A full frame is hundreds of packets that all have to survive, and one lost packet stops the picture until the
    // next full frame, so it is paced at half the speed of ordinary frames. They are rare, so nothing is slower
    // for it, and a weak moment at the start of a connection is far less likely to lose part of one.
    private const double KeyframePaceFactor = 0.5;

    public delegate void Transmit(byte[] payload, uint timestamp, int marker, ushort sequence);

    /// <summary>Like <see cref="Transmit"/>, and says which codec the packet belongs to, because the payload type differs.</summary>
    public delegate void TransmitCodec(byte[] payload, uint timestamp, int marker, ushort sequence, ConsoleVideoCodec codec);

    // Windows sleeps in steps of about 15 ms by default, which would cap sending at around 6 Mbps.
    [System.Runtime.InteropServices.DllImport("winmm.dll")]
    private static extern uint timeBeginPeriod(uint milliseconds);

    [System.Runtime.InteropServices.DllImport("winmm.dll")]
    private static extern uint timeEndPeriod(uint milliseconds);

    private sealed class Packet
    {
        public required byte[] Payload;
        public required uint Timestamp;
        public required int Marker;
        public required ushort Sequence;
        public required bool LastOfKeyframe;
        public ConsoleVideoCodec Codec;
        public bool InKeyframe;
        public long FirstSentMs;
        public long LastSentMs;
        public int Resends;
    }

    private readonly TransmitCodec _transmit;
    private readonly Action<Exception>? _onSendError;
    private readonly H264Packetizer.Preparer _h264 = new();
    private volatile ConsoleVideoCodec _codec = ConsoleVideoCodec.Vp8;
    private readonly object _gate = new();
    private readonly Queue<Packet> _framePackets = new();
    private readonly Queue<Packet> _resends = new();
    private readonly Packet?[] _history = new Packet?[HistorySize];
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly Thread _thread;
    private readonly uint _timestampBase;

    private ushort _nextSequence;
    private int _bytesPerMs;
    private bool _stopped;
    private bool _keyframeInFlight;
    private long _lastKeyframeDoneMs = -10_000;
    private long _lastKeyframeRequestMs = -10_000;

    private long _windowPackets;
    private long _windowMissing;
    private long _windowBytes;

    public ConsoleVideoSender(Transmit transmit, int startKbps, Action<Exception>? onSendError = null)
        : this((payload, timestamp, marker, sequence, _) => transmit(payload, timestamp, marker, sequence), startKbps, onSendError)
    {
    }

    public ConsoleVideoSender(TransmitCodec transmit, int startKbps, Action<Exception>? onSendError = null)
    {
        _transmit = transmit;
        _onSendError = onSendError;
        _timestampBase = (uint)Random.Shared.Next();

        // Kept low so a long session does not hit the sequence rollover at a bad moment first.
        _nextSequence = (ushort)Random.Shared.Next(0, 0x7FFF);

        SetRateKbps(startKbps);
        _thread = new Thread(Run) { IsBackground = true, Name = "RemoteConsole video sender", Priority = ThreadPriority.AboveNormal };
        _thread.Start();
    }

    /// <summary>Spreads packets faster than the average, so a large frame clears quickly without a burst.</summary>
    /// <summary>How long what is waiting to be sent will take at the current rate.</summary>
    public int QueuedMs()
    {
        lock (_gate) return _framePackets.Count * MaxPayload / Math.Max(1, Volatile.Read(ref _bytesPerMs));
    }

    public void SetRateKbps(int kbps) => Volatile.Write(ref _bytesPerMs, Math.Max(MinBytesPerMs, kbps * 3 / 8));

    /// <summary>Raised when a frame could not be sent because it was unusable (an H.264 keyframe with no parameter sets, say), so its encoder can be asked for another.</summary>
    public event Action? OnUnusableFrame;

    /// <summary>The codec frames are currently made and packetized for.</summary>
    public ConsoleVideoCodec Codec => _codec;

    /// <summary>
    /// Starts sending another codec. Whatever is still queued or waiting to be resent belongs to the old one and
    /// is dropped, because the browser could not decode it under the new payload type. The first frame after this has
    /// to be a keyframe, which the caller arranges.
    /// </summary>
    public void SwitchCodec(ConsoleVideoCodec codec)
    {
        lock (_gate)
        {
            if (_codec == codec) return;
            _codec = codec;
            _framePackets.Clear();
            _resends.Clear();
            Array.Clear(_history);
            _keyframeInFlight = false;
            Monitor.PulseAll(_gate);
        }
    }

    /// <summary>
    /// Queues one encoded frame. It waits for the previous frame to leave, which is what makes the
    /// capture side skip to the newest picture on a slow link instead of building up a delay.
    /// </summary>
    public void Send(uint durationRtpUnits, byte[] frame)
    {
        if (frame.Length == 0) return;

        // The RTP clock has to follow real time. Frames of an unchanged screen are skipped, and a clock
        // that advanced per frame would tell the browser that seconds of video took milliseconds,
        // which is read as network jitter and answered by holding frames back.
        var timestamp = unchecked(_timestampBase + (uint)(_clock.ElapsedMilliseconds * RtpUnitsPerMs));

        var codec = _codec;
        List<byte[]> payloads;
        bool isKeyframe;
        if (codec == ConsoleVideoCodec.H264)
        {
            var nals = _h264.Prepare(frame, out isKeyframe);
            if (nals is null)
            {
                OnUnusableFrame?.Invoke();
                return;
            }
            payloads = H264Packetizer.Packetize(nals, MaxPayload);
        }
        else
        {
            // Bit 0 of the first byte of a VP8 frame is clear on a keyframe.
            isKeyframe = (frame[0] & 1) == 0;
            payloads = new List<byte[]>((frame.Length + MaxPayload - 1) / MaxPayload);
            for (var offset = 0; offset < frame.Length; offset += MaxPayload)
            {
                var size = Math.Min(MaxPayload, frame.Length - offset);
                var payload = new byte[size + 1];

                // VP8 payload descriptor: the S bit marks the first packet of a frame.
                payload[0] = offset == 0 ? (byte)0x10 : (byte)0x00;
                Buffer.BlockCopy(frame, offset, payload, 1, size);
                payloads.Add(payload);
            }
        }
        if (payloads.Count == 0) return;

        lock (_gate)
        {
            while (_framePackets.Count > 0 && !_stopped) Monitor.Wait(_gate, 1000);
            if (_stopped) return;

            // The codec may have been switched while this frame waited, and then it no longer fits.
            if (_codec != codec) return;

            for (var i = 0; i < payloads.Count; i++)
            {
                var last = i == payloads.Count - 1;
                _framePackets.Enqueue(new Packet
                {
                    Payload = payloads[i],
                    Timestamp = timestamp,
                    Marker = last ? 1 : 0,
                    Sequence = NextSequence(),
                    LastOfKeyframe = last && isKeyframe,
                    InKeyframe = isKeyframe,
                    Codec = codec,
                });
            }

            if (isKeyframe) _keyframeInFlight = true;
            Monitor.PulseAll(_gate);
        }
    }

    private ushort NextSequence()
    {
        var sequence = _nextSequence++;

        // Encryption counts rollovers as packets pass through it, so a packet from before a rollover
        // cannot be sent again afterwards, and resending the last number would count one twice.
        if (sequence == 0) Array.Clear(_history);
        return sequence;
    }

    /// <summary>The browser reported packets missing: a base sequence, and a bitmask of the 16 after it.</summary>
    public void OnNack(ushort first, ushort following)
    {
        var now = _clock.ElapsedMilliseconds;
        lock (_gate)
        {
            Request(first, now);
            for (var bit = 0; bit < 16; bit++)
            {
                if ((following & (1 << bit)) != 0) Request(unchecked((ushort)(first + bit + 1)), now);
            }
            if (_resends.Count > 0) Monitor.PulseAll(_gate);
        }
    }

    private void Request(ushort sequence, long now)
    {
        var packet = _history[sequence % HistorySize];
        if (packet is null || packet.Sequence != sequence) return;
        if (packet.Resends == 0) _windowMissing++;
        if (packet.Resends >= MaxResends) return;
        if (now - packet.FirstSentMs > MaxResendAgeMs || now - packet.LastSentMs < MinResendGapMs) return;

        packet.Resends++;
        packet.LastSentMs = now;
        _resends.Enqueue(packet);
    }

    /// <summary>
    /// Whether a keyframe the browser asked for should be made. One still on its way would answer the
    /// request, and starting another then would only add to the congestion that lost the first.
    /// </summary>
    public bool ShouldMakeKeyframe()
    {
        var now = _clock.ElapsedMilliseconds;
        lock (_gate)
        {
            if (_keyframeInFlight) return false;
            if (now - _lastKeyframeDoneMs < KeyframeSettleMs) return false;
            if (now - _lastKeyframeRequestMs < MinKeyframeGapMs) return false;
            _lastKeyframeRequestMs = now;
            return true;
        }
    }

    /// <summary>What was sent since the last call, and how much of it the browser reported missing.</summary>
    public (long Packets, long Missing, long Bytes) TakeWindow()
    {
        lock (_gate)
        {
            var result = (_windowPackets, _windowMissing, _windowBytes);
            _windowPackets = 0;
            _windowMissing = 0;
            _windowBytes = 0;
            return result;
        }
    }

    private void Run()
    {
        timeBeginPeriod(1);
        try
        {
            RunLoop();
        }
        finally
        {
            timeEndPeriod(1);
        }
    }

    private void RunLoop()
    {
        double tokens = BurstBytes;
        var lastRefillMs = _clock.ElapsedMilliseconds;

        while (true)
        {
            Packet packet;
            bool isResend;
            lock (_gate)
            {
                while (!_stopped && _resends.Count == 0 && _framePackets.Count == 0) Monitor.Wait(_gate);
                if (_stopped) return;

                // Resends go first: a frame that is missing a packet holds up everything after it.
                isResend = _resends.Count > 0;
                packet = isResend ? _resends.Dequeue() : _framePackets.Dequeue();
            }

            while (true)
            {
                var now = _clock.ElapsedMilliseconds;
                var perMs = (double)Volatile.Read(ref _bytesPerMs);
                if (packet.InKeyframe) perMs *= KeyframePaceFactor;
                tokens = Math.Min(BurstBytes, tokens + (now - lastRefillMs) * perMs);
                lastRefillMs = now;
                if (tokens >= packet.Payload.Length) break;
                Thread.Sleep(1);
                if (Volatile.Read(ref _stopped)) return;
            }
            tokens -= packet.Payload.Length;

            try
            {
                _transmit(packet.Payload, packet.Timestamp, packet.Marker, packet.Sequence, packet.Codec);
            }
            catch (Exception ex)
            {
                _onSendError?.Invoke(ex);
            }

            lock (_gate)
            {
                _windowBytes += packet.Payload.Length;

                if (!isResend)
                {
                    var now = _clock.ElapsedMilliseconds;
                    packet.FirstSentMs = now;
                    packet.LastSentMs = now;
                    _windowPackets++;
                    if (packet.Sequence != 0xFFFF) _history[packet.Sequence % HistorySize] = packet;

                    if (packet.LastOfKeyframe)
                    {
                        _keyframeInFlight = false;
                        _lastKeyframeDoneMs = now;
                    }
                    if (_framePackets.Count == 0) Monitor.PulseAll(_gate);
                }
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _stopped = true;
            Monitor.PulseAll(_gate);
        }
    }
}

/// <summary>
/// Finds what the network can carry. It starts low and climbs quickly until the first sign of trouble,
/// then climbs slowly, and backs off on packet loss or on round trips growing, which is what a
/// queue filling up looks like before anything is dropped.
/// </summary>
public sealed class ConsoleRateController
{
    private const long IntervalMs = 1000;
    private const long HoldAfterCutMs = 3000;

    // The first seconds of a connection are when readings are least trustworthy: little has been sent, the browser is
    // still settling, and a few early resend requests can look like heavy loss. Cutting hard then, three times in a
    // row, took a session from 4000 kbps to the 800 kbps floor in three seconds. So the start gets gentler cuts and a
    // higher floor, and the usual rules apply once it has settled.
    private const long StartWindowMs = 8000;
    private const int StartFloorKbps = 1200;

    private readonly int _minKbps;
    private readonly int _maxKbps;
    private bool _slowStart = true;
    private long _lastChangeMs = long.MinValue / 2;
    private long _lastCutMs = long.MinValue / 2;
    private double _minRttMs = double.MaxValue;

    public ConsoleRateController(int startKbps, int minKbps, int maxKbps)
    {
        _minKbps = minKbps;
        _maxKbps = Math.Max(minKbps, maxKbps);
        CurrentKbps = Math.Clamp(startKbps, _minKbps, _maxKbps);
    }

    public int CurrentKbps { get; private set; }

    /// <param name="loss">Fraction of packets lost in this period, from 0 to 1.</param>
    /// <param name="rttMs">Round trip time, when a new measurement exists.</param>
    /// <param name="usingBandwidth">False when the screen is too quiet to say whether more would fit.</param>
    /// <returns>True when the rate changed.</returns>
    public bool Update(double loss, double? rttMs, bool usingBandwidth, long nowMs)
    {
        var queueBuilding = false;
        if (rttMs is { } rtt and >= 0 and < 5000)
        {
            _minRttMs = Math.Min(_minRttMs, rtt);
            queueBuilding = rtt > _minRttMs + Math.Max(80, _minRttMs);
        }

        if (nowMs - _lastChangeMs < IntervalMs) return false;

        var starting = nowMs < StartWindowMs;

        double factor = 1;
        if (loss >= 0.10) factor = starting ? 0.85 : 0.65;
        else if (loss >= 0.03 || queueBuilding) factor = 0.85;
        else if (loss < 0.01 && usingBandwidth && nowMs - _lastCutMs >= HoldAfterCutMs) factor = _slowStart ? 1.25 : 1.06;

        if (factor < 1)
        {
            _slowStart = false;
            _lastCutMs = nowMs;
        }

        var floor = starting ? Math.Min(Math.Max(_minKbps, StartFloorKbps), _maxKbps) : _minKbps;
        var next = Math.Clamp((int)(CurrentKbps * factor), floor, _maxKbps);
        if (next == CurrentKbps) return false;

        CurrentKbps = next;
        _lastChangeMs = nowMs;
        return true;
    }
}

/// <summary>
/// Acts on what the browser reports. The library's parser reads only the first entry of a list of
/// missing packets, then loses its place and drops the rest of the message, including any keyframe
/// request after it. So this reads the decrypted packets itself.
/// </summary>
public sealed class ConsoleVideoFeedback : IDisposable
{
    private const byte RtpFeedback = 205;
    private const byte PayloadFeedback = 206;
    private const int FormatNack = 1;
    private const int FormatPli = 1;
    private const int FormatFir = 4;
    private const long MinPacketsToJudgeLoss = 30;

    private readonly ConsoleVideoSender _sender;
    private readonly ConsoleRateController _rate;
    private readonly Action _makeKeyframe;
    private readonly Action<int> _setKbps;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly Timer _timer;
    private double _rttMs = -1;
    private long _lastTickMs;

    private readonly Action<string>? _log;

    /// <param name="log">Told why each rate change was made, so a session that went wrong can be understood afterwards.</param>
    public ConsoleVideoFeedback(ConsoleVideoSender sender, ConsoleRateController rate, Action makeKeyframe, Action<int> setKbps, Action<string>? log = null)
    {
        _sender = sender;
        _rate = rate;
        _makeKeyframe = makeKeyframe;
        _setKbps = setKbps;
        _log = log;
        _timer = new Timer(_ => Tick(), null, 1000, 1000);
    }

    public long NacksHeard { get; private set; }
    public long KeyframeRequestsHeard { get; private set; }
    public long KeyframesMade { get; private set; }
    public double RoundTripMs => Volatile.Read(ref _rttMs);

    /// <summary>
    /// Watches RTCP as it is decrypted. The library decrypts it with the session's primary stream unless
    /// the sender is a known track, and a browser that only receives is not, so both are covered.
    /// Call this once the connection is up, because the keys do not exist before that.
    /// </summary>
    public bool AttachTo(RTPSession session)
    {
        var attached = false;
        foreach (MediaStream? stream in new MediaStream?[] { session.PrimaryStream, session.VideoStream }.Distinct())
        {
            var context = stream?.GetSecurityContext();
            if (stream is null || context is null) continue;

            var unprotect = context.UnprotectRtcpPacket;
            stream.SetSecurityContext(context.ProtectRtpPacket, context.UnprotectRtpPacket, context.ProtectRtcpPacket,
                (byte[] packet, int length, out int outputLength) =>
                {
                    var result = unprotect(packet, length, out outputLength);
                    if (result == 0) OnRtcp(packet.AsSpan(0, outputLength));
                    return result;
                });
            attached = true;
        }
        return attached;
    }

    public void OnRoundTrip(double ms) => Volatile.Write(ref _rttMs, ms);

    /// <summary>Reads one decrypted compound RTCP packet.</summary>
    public void OnRtcp(ReadOnlySpan<byte> rtcp)
    {
        var offset = 0;
        while (rtcp.Length - offset >= 12)
        {
            var first = rtcp[offset];
            if (first >> 6 != 2) return;

            var format = first & 0x1F;
            var type = rtcp[offset + 1];
            var length = (((rtcp[offset + 2] << 8) | rtcp[offset + 3]) + 1) * 4;
            if (length > rtcp.Length - offset) return;

            if (type == RtpFeedback && format == FormatNack)
            {
                for (var entry = offset + 12; entry + 4 <= offset + length; entry += 4)
                {
                    NacksHeard++;
                    _sender.OnNack((ushort)((rtcp[entry] << 8) | rtcp[entry + 1]), (ushort)((rtcp[entry + 2] << 8) | rtcp[entry + 3]));
                }
            }
            else if (type == PayloadFeedback && format is FormatPli or FormatFir)
            {
                KeyframeRequestsHeard++;
                if (_sender.ShouldMakeKeyframe())
                {
                    KeyframesMade++;
                    _makeKeyframe();
                }
            }

            offset += length;
        }
    }

    private void Tick()
    {
        var now = _clock.ElapsedMilliseconds;
        var elapsedMs = Math.Max(1, now - _lastTickMs);
        _lastTickMs = now;

        var (packets, missing, bytes) = _sender.TakeWindow();

        // A report covering a few packets says little: one loss in ten is not ten percent of a network.
        var loss = packets >= MinPacketsToJudgeLoss ? (double)missing / packets : 0;
        var kbpsUsed = bytes * 8.0 / elapsedMs;
        var rtt = Volatile.Read(ref _rttMs);

        var before = _rate.CurrentKbps;
        if (_rate.Update(loss, rtt >= 0 ? rtt : null, kbpsUsed >= _rate.CurrentKbps * 0.4, now))
        {
            _sender.SetRateKbps(_rate.CurrentKbps);
            _setKbps(_rate.CurrentKbps);

            // The reading behind the change: how much was lost, out of how many packets, and how long the round trip was.
            _log?.Invoke(
                $"rate {before} -> {_rate.CurrentKbps} kbps: {missing} of {packets} packets reported missing ({loss * 100:0.#}%), " +
                $"sent {kbpsUsed:0} kbps, round trip {(rtt >= 0 ? rtt.ToString("0") + " ms" : "unknown")}, {now / 1000.0:0.0} s into the session");
        }
    }

    public void Dispose() => _timer.Dispose();
}
