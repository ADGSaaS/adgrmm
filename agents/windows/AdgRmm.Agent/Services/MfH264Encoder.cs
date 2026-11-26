// agents/windows/AdgRmm.Agent/Services/MfH264Encoder.cs

using System.Diagnostics;
using System.Runtime.InteropServices;
using static AdgRmm.Agent.Services.MfInterop;

namespace AdgRmm.Agent.Services;

/// <summary>What the remote console needs from a screen encoder, whichever codec is behind it.</summary>
public interface IScreenEncoder : IDisposable
{
    string Description { get; }
    bool IsHardware { get; }

    /// <summary>One picture in, one encoded picture out, or null when nothing needs sending (an unchanged screen, or a frame the encoder skipped).</summary>
    byte[]? Encode(int width, int height, byte[] bgra);

    void ForceKeyFrame();
    void SetTargetKbps(int kbps);
    (double Ms, long Frames) TakeEncodeStats();
}

/// <summary>An H.264 encoder that Windows offers: Microsoft's software one, or a graphics driver's hardware one.</summary>
public sealed record MfH264Candidate(string Name, bool Hardware, object Activate, ulong AdapterLuid = 0)
{
    public override string ToString() => $"{Name} ({(Hardware ? "hardware" : "software")})";
}

/// <summary>
/// H.264 through the Media Foundation encoder Windows provides. This product ships no H.264 encoder of its own: the
/// encoder is whatever the operating system or the graphics driver supplies, under their licences.
/// Output is Annex B. Low latency, constant bitrate, no B-frames, baseline profile, so every picture decodes the
/// moment it arrives and the browser's decoder needs nothing beyond what WebRTC requires of it.
/// </summary>
public sealed class MfH264Encoder : IScreenEncoder
{
    private const long IdleIntervalMs = 1000;
    private const long SharpenWindowMs = 3000;
    private const long SharpenIntervalMs = 200;

    // How long one picture may take to come back before the encoder is judged to have stalled. A hardware encoder at
    // 4K takes a few milliseconds, so this is generous, and the first picture (device start-up) gets longer.
    private const int FirstOutputTimeoutMs = 3000;
    private const int OutputTimeoutMs = 400;
    // A single slow picture (a graphics card changing its clock, a busy machine) is only skipped. No output at all for this long, while pictures
    // are being fed, is a stall, and the caller then gives H.264 up.
    private const long StallMs = 3000;

    private static readonly object StartupLock = new();
    private static bool _started;

    private readonly MfH264Candidate _candidate;
    private readonly int _fps;
    private readonly object _lock = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();

    private IMFTransform? _mft;
    private MfD3dDevice? _d3d;
    private IMFMediaEventGenerator? _events;
    private ICodecApi? _codec;
    private bool _async;
    private bool _providesSamples;
    private int _outputBufferSize;
    private bool _canForceKeyFrame;
    private int _needInput;
    private int _haveOutput;
    private int _width;
    private int _height;
    private byte[]? _nv12;
    private byte[]? _previous;

    // An encoder can hold on to a picture after taking it, so each picture goes in a sample of its own, in turn, and one
    // is not written again until several others have gone by.
    private const int InputRing = 6;
    private readonly IMFSample?[] _inputSamples = new IMFSample?[InputRing];
    private readonly IMFMediaBuffer?[] _inputBuffers = new IMFMediaBuffer?[InputRing];
    private int _ringNext;
    private bool _fedAny;
    private uint _targetKbps;
    private long _lastPtsMs = -1;
    private long _ptsOrigin = -1;
    private long _lastSentMs = -IdleIntervalMs;
    private long _lastChangeMs;
    private bool _forceKeyFrame = true;
    private bool _disposed;
    private bool _gotOutput;
    private int _consecutiveEmpty;
    private long _lastOutputMs;
    private long _encodeTicks;
    private long _encodeCount;

    public MfH264Encoder(MfH264Candidate candidate, int targetKbps, int fps)
    {
        _candidate = candidate;
        _targetKbps = (uint)Math.Max(100, targetKbps);
        _fps = Math.Clamp(fps, 1, 60);
    }

    /// <summary>Told how the encoder was set up and which of its settings it refused, for the log of a session that went wrong.</summary>
    public Action<string>? Trace { get; set; }

    public string Description => _candidate.ToString();
    public bool IsHardware => _candidate.Hardware;

    /// <summary>The SPS and PPS that the encoder announced in its output type, for pictures that arrive without them.</summary>
    public (byte[]? Sps, byte[]? Pps) ParameterSets { get; private set; }

    /// <summary>Lists the encoders Windows offers, hardware ones first. Empty when there is none, or when Media Foundation is missing.</summary>
    public static List<MfH264Candidate> Enumerate()
    {
        var result = new List<MfH264Candidate>();
        try
        {
            EnsureStarted();
            // A hardware encoder belongs to one adapter, and a machine with two (a discrete card and the processor's graphics)
            // lists one per adapter. Asking per adapter keeps each encoder with its own, instead of all on the default one.
            var adapters = MfD3dDevice.Adapters();
            var perAdapter = false;
            foreach (var (luid, adapterName) in adapters)
            {
                try
                {
                    perAdapter |= AddCandidates(result, EnumFlagHardware | EnumFlagSortAndFilter, hardware: true, luid, adapterName);
                }
                catch (EntryPointNotFoundException) { break; }
            }
            if (!perAdapter) AddCandidates(result, EnumFlagHardware | EnumFlagSortAndFilter, hardware: true, 0, null);
            AddCandidates(result, EnumFlagSync | EnumFlagSortAndFilter, hardware: false, 0, null);
        }
        catch (Exception)
        {
            // No Media Foundation (a Server Core install, say) means no H.264 here.
        }
        return result;
    }

    private static void EnsureStarted()
    {
        lock (StartupLock)
        {
            if (_started) return;
            Check(MFStartup(MfVersion, 0), "MFStartup");
            _started = true;
        }
    }

    private static bool AddCandidates(List<MfH264Candidate> into, int flags, bool hardware, ulong adapterLuid, string? adapterName)
    {
        var input = new RegisterTypeInfo { MajorType = MediaTypeVideo, Subtype = FormatNv12 };
        var output = new RegisterTypeInfo { MajorType = MediaTypeVideo, Subtype = FormatH264 };
        IntPtr array;
        int count;
        if (adapterLuid != 0)
        {
            Check(MFCreateAttributes(out var filter, 1), "create the adapter filter");
            var luidKey = MfD3dDevice.AdapterLuidAttribute;
            Check(filter.SetUINT64(ref luidKey, adapterLuid), "name the adapter");
            if (MFTEnum2(CategoryVideoEncoder, flags, ref input, ref output, filter, out array, out count) < 0 || array == IntPtr.Zero) return false;
        }
        else if (MFTEnumEx(CategoryVideoEncoder, flags, ref input, ref output, out array, out count) < 0 || array == IntPtr.Zero) return false;
        var added = false;

        try
        {
            for (var i = 0; i < count; i++)
            {
                var pointer = Marshal.ReadIntPtr(array, i * IntPtr.Size);
                if (pointer == IntPtr.Zero) continue;
                var activate = (IMFActivate)Marshal.GetObjectForIUnknown(pointer);
                Marshal.Release(pointer);

                var name = ReadString((IMFAttributes)activate, FriendlyName) ?? "H.264 encoder";
                if (adapterName is not null) name += " on " + adapterName;
                into.Add(new MfH264Candidate(name, hardware, activate, adapterLuid));
                added = true;
            }
        }
        finally
        {
            CoTaskMemFree(array);
        }
        return added;
    }

    private static string? ReadString(IMFAttributes attributes, Guid key)
    {
        var k = key;
        if (attributes.GetAllocatedString(ref k, out var text, out _) < 0 || text == IntPtr.Zero) return null;
        try { return Marshal.PtrToStringUni(text); }
        finally { CoTaskMemFree(text); }
    }

    private static uint Level(int width, int height)
    {
        // The smallest H.264 level whose frame size limit holds the picture (macroblocks of 16x16).
        var macroblocks = ((width + 15) / 16) * ((height + 15) / 16);
        if (macroblocks <= 3600) return 31;
        if (macroblocks <= 8192) return 40;
        if (macroblocks <= 22080) return 50;
        if (macroblocks <= 36864) return 51;
        return 52;
    }

    private void Initialise(int width, int height)
    {
        Release();

        var activate = (IMFActivate)_candidate.Activate;

        // A hardware encoder runs on one graphics adapter and needs that adapter's Direct3D device before anything else.
        if (_candidate.Hardware)
        {
            _d3d = MfD3dDevice.Create(_candidate.AdapterLuid);
        }

        var iid = typeof(IMFTransform).GUID;
        Check(activate.ActivateObject(ref iid, out var obj), "activate the encoder");
        var mft = (IMFTransform)obj;
        _mft = mft;
        _events = mft as IMFMediaEventGenerator;
        _codec = mft as ICodecApi;

        if (mft.GetAttributes(out var attributes) >= 0 && attributes is not null)
        {
            var asyncKey = TransformAsync;
            _async = attributes.GetUINT32(ref asyncKey, out var isAsync) >= 0 && isAsync != 0;
            if (_async)
            {
                var unlock = TransformAsyncUnlock;
                Check(attributes.SetUINT32(ref unlock, 1), "unlock the asynchronous encoder");
            }
            var low = LowLatency;
            attributes.SetUINT32(ref low, 1);
        }
        if (_d3d is not null) Trace?.Invoke($"set Direct3D manager hr=0x{mft.ProcessMessage(MessageSetD3dManager, _d3d.ManagerPointer):X8}");
        if (_async && _events is null) throw new InvalidOperationException("The encoder is asynchronous but has no event interface.");

        // The output type is set first: an encoder cannot say what pictures it takes until it knows what it makes.
        Check(MFCreateMediaType(out var outputType), "create the output type");
        SetCommon(outputType, width, height);
        var subtype = FormatH264;
        SetMajorType(outputType);
        var typeKey = MtSubtype;
        outputType.SetGUID(ref typeKey, ref subtype);
        var bitrate = MtAvgBitrate;
        outputType.SetUINT32(ref bitrate, _targetKbps * 1000);
        var profile = MtMpeg2Profile;
        outputType.SetUINT32(ref profile, 66); // Baseline: no B-frames, understood by every browser.
        var level = MtMpeg2Level;
        outputType.SetUINT32(ref level, Level(width, height));
        Check(mft.SetOutputType(0, outputType, 0), "set the output type");

        Check(MFCreateMediaType(out var inputType), "create the input type");
        SetCommon(inputType, width, height);
        var inSubtype = FormatNv12;
        SetMajorType(inputType);
        var inKey = MtSubtype;
        inputType.SetGUID(ref inKey, ref inSubtype);
        Check(mft.SetInputType(0, inputType, 0), "set the input type");

        Marshal.ReleaseComObject(outputType);
        Marshal.ReleaseComObject(inputType);

        ApplyCodecSettings();

        Check(mft.GetOutputStreamInfo(0, out var info), "read the output stream info");
        _providesSamples = (info.Flags & OutputProvidesSamples) != 0;
        _outputBufferSize = (int)Math.Max(info.Size, (uint)(width * height));

        ReadSequenceHeader(mft);

        var begin = mft.ProcessMessage(MessageBeginStreaming, IntPtr.Zero);
        var startOfStream = mft.ProcessMessage(MessageStartOfStream, IntPtr.Zero);
        Trace?.Invoke($"async={_async} providesSamples={_providesSamples} outBuf={_outputBufferSize} begin=0x{begin:X8} start=0x{startOfStream:X8}");

        _width = width;
        _height = height;
        _nv12 = new byte[width * height * 3 / 2];

        for (var i = 0; i < InputRing; i++)
        {
            Check(MFCreateMemoryBuffer(_nv12.Length, out var buffer), "create the input buffer");
            Check(MFCreateSample(out var sample), "create the input sample");
            Check(sample.AddBuffer(buffer), "attach the input buffer");
            _inputBuffers[i] = buffer;
            _inputSamples[i] = sample;
        }
        _ringNext = 0;
        _fedAny = false;

        _needInput = 0;
        _haveOutput = 0;
        _gotOutput = false;
        _consecutiveEmpty = 0;
        _lastOutputMs = _clock.ElapsedMilliseconds;
        _forceKeyFrame = true;
    }

    private static void SetMajorType(IMFMediaType type)
    {
        var key = MtMajorType;
        var value = MediaTypeVideo;
        type.SetGUID(ref key, ref value);
    }

    private static void SetCommon(IMFMediaType type, int width, int height)
    {
        var size = MtFrameSize;
        type.SetUINT64(ref size, Pack((uint)width, (uint)height));
        var rate = MtFrameRate;
        type.SetUINT64(ref rate, Pack(30, 1));
        var aspect = MtPixelAspectRatio;
        type.SetUINT64(ref aspect, Pack(1, 1));
        var interlace = MtInterlaceMode;
        type.SetUINT32(ref interlace, 2); // progressive
    }

    private void ApplyCodecSettings()
    {
        if (_codec is null) return;

        // Each setting is best effort: encoders differ in what they accept. What matters is verified by the start-up check.
        SetCodec(CodecRateControlMode, 0u);                 // constant bitrate
        SetCodec(CodecMeanBitRate, _targetKbps * 1000);
        SetCodec(CodecLowLatency, true);
        SetCodec(CodecBPictureCount, 0u);
        SetCodec(CodecGopSize, 100000u);                    // a long GOP; the Microsoft software encoder ignores this and keeps one keyframe a second
        SetCodec(CodecQualityVsSpeed, 30u);

        var key = CodecForceKeyFrame;
        _canForceKeyFrame = _codec.IsSupported(ref key) == 0;
    }

    private bool SetCodec(Guid property, object value)
    {
        if (_codec is null) return false;
        var key = property;
        var boxed = value;
        var hr = _codec.SetValue(ref key, ref boxed);
        if (hr < 0) Trace?.Invoke($"setting {property} was refused (0x{hr:X8})");
        return hr >= 0;
    }

    private void ReadSequenceHeader(IMFTransform mft)
    {
        try
        {
            if (mft.GetOutputCurrentType(0, out var type) < 0 || type is null) return;
            var key = MtMpegSequenceHeader;
            if (type.GetBlobSize(ref key, out var size) >= 0 && size > 0)
            {
                var blob = new byte[size];
                if (type.GetBlob(ref key, blob, size, out var written) >= 0)
                {
                    var nals = H264Packetizer.Split(blob.AsSpan(0, (int)written));
                    byte[]? sps = null, pps = null;
                    foreach (var nal in nals)
                    {
                        var t = nal.Type(blob);
                        if (t == H264Packetizer.NalSps) sps = blob.AsSpan(nal.Offset, nal.Length).ToArray();
                        if (t == H264Packetizer.NalPps) pps = blob.AsSpan(nal.Offset, nal.Length).ToArray();
                    }
                    ParameterSets = (sps, pps);
                }
            }
            Marshal.ReleaseComObject(type);
        }
        catch (Exception)
        {
            // Optional: encoders that put the parameter sets in each keyframe do not need it.
        }
    }

    public void ForceKeyFrame()
    {
        lock (_lock) _forceKeyFrame = true;
    }

    public void SetTargetKbps(int kbps)
    {
        lock (_lock)
        {
            _targetKbps = (uint)Math.Max(100, kbps);
            if (_mft is not null) SetCodec(CodecMeanBitRate, _targetKbps * 1000);
        }
    }

    public (double Ms, long Frames) TakeEncodeStats()
    {
        lock (_lock)
        {
            var frames = _encodeCount;
            var ms = frames == 0 ? 0 : _encodeTicks * 1000.0 / Stopwatch.Frequency / frames;
            _encodeTicks = 0;
            _encodeCount = 0;
            return (ms, frames);
        }
    }

    public byte[]? Encode(int width, int height, byte[] bgra)
    {
        // Encoders take even sizes only. A row or column beyond that is left out of the picture.
        var w = width & ~1;
        var h = height & ~1;
        if (w < 64 || h < 64) throw new NotSupportedException($"A {width}x{height} picture is too small for the H.264 encoder.");

        lock (_lock)
        {
            if (_disposed) return null;
            if (_mft is null || w != _width || h != _height) Initialise(w, h);

            var now = _clock.ElapsedMilliseconds;

            var unchanged = _previous is { } prev && prev.Length == bgra.Length && prev.AsSpan().SequenceEqual(bgra);
            if (unchanged)
            {
                var interval = now - _lastChangeMs < SharpenWindowMs ? SharpenIntervalMs : IdleIntervalMs;
                if (!_forceKeyFrame && now - _lastSentMs < interval) return null;
            }
            else
            {
                _lastChangeMs = now;
                if (_previous is null || _previous.Length != bgra.Length) _previous = new byte[bgra.Length];
                Buffer.BlockCopy(bgra, 0, _previous, 0, bgra.Length);
            }

            var start = Stopwatch.GetTimestamp();
            BgraToNv12(bgra, width, w, h, _nv12!);

            if (_ptsOrigin < 0) _ptsOrigin = now;
            var pts = Math.Max(now - _ptsOrigin, _lastPtsMs + 1);
            var duration = _lastPtsMs < 0 ? 1000 / _fps : Math.Clamp(pts - _lastPtsMs, 1, IdleIntervalMs);
            _lastPtsMs = pts;

            var force = _forceKeyFrame;
            _forceKeyFrame = false;
            if (force)
            {
                if (_canForceKeyFrame && _gotOutput)
                {
                    SetCodec(CodecForceKeyFrame, 1u);
                }
                else if (_gotOutput)
                {
                    // An encoder that cannot be asked for a keyframe starts afresh, which always begins with one.
                    Initialise(w, h);
                }
            }

            var encoded = ProcessPicture(pts * 10_000, duration * 10_000);

            _encodeTicks += Stopwatch.GetTimestamp() - start;
            _encodeCount++;

            if (encoded is not null) _lastSentMs = now;
            return encoded;
        }
    }

    // BT.601 limited range, as the VP8 path uses, so both look the same in the browser.
    private static void BgraToNv12(byte[] bgra, int stride, int w, int h, byte[] nv12)
    {
        var uvOffset = w * h;
        Parallel.For(0, h / 2, pair =>
        {
            var y0 = pair * 2;
            var y1 = y0 + 1;
            int s0 = y0 * stride * 4, s1 = y1 * stride * 4;
            int d0 = y0 * w, d1 = y1 * w;
            var uv = uvOffset + pair * w;
            for (var x = 0; x < w; x += 2)
            {
                int b00 = bgra[s0], g00 = bgra[s0 + 1], r00 = bgra[s0 + 2];
                int b01 = bgra[s0 + 4], g01 = bgra[s0 + 5], r01 = bgra[s0 + 6];
                int b10 = bgra[s1], g10 = bgra[s1 + 1], r10 = bgra[s1 + 2];
                int b11 = bgra[s1 + 4], g11 = bgra[s1 + 5], r11 = bgra[s1 + 6];

                nv12[d0] = (byte)(((66 * r00 + 129 * g00 + 25 * b00 + 128) >> 8) + 16);
                nv12[d0 + 1] = (byte)(((66 * r01 + 129 * g01 + 25 * b01 + 128) >> 8) + 16);
                nv12[d1] = (byte)(((66 * r10 + 129 * g10 + 25 * b10 + 128) >> 8) + 16);
                nv12[d1 + 1] = (byte)(((66 * r11 + 129 * g11 + 25 * b11 + 128) >> 8) + 16);

                var b = (b00 + b01 + b10 + b11) >> 2;
                var g = (g00 + g01 + g10 + g11) >> 2;
                var r = (r00 + r01 + r10 + r11) >> 2;
                nv12[uv] = (byte)(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
                nv12[uv + 1] = (byte)(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);

                s0 += 8; s1 += 8; d0 += 2; d1 += 2; uv += 2;
            }
        });
    }

    private byte[]? ProcessPicture(long sampleTime, long sampleDuration)
    {
        var mft = _mft!;
        var slot = _ringNext;
        _ringNext = (_ringNext + 1) % InputRing;
        var sample = _inputSamples[slot]!;
        var buffer = _inputBuffers[slot]!;

        Check(buffer.Lock(out var pointer, out _, out _), "lock the input buffer");
        try { Marshal.Copy(_nv12!, 0, pointer, _nv12!.Length); }
        finally { buffer.Unlock(); }
        Check(buffer.SetCurrentLength(_nv12!.Length), "set the input length");
        sample.SetSampleTime(sampleTime);
        sample.SetSampleDuration(sampleDuration);

        byte[]? result = null;

        if (!_async)
        {
            Check(mft.ProcessInput(0, sample, 0), "feed the encoder");
            result = DrainSync(mft);
        }
        else
        {
            var timeout = _gotOutput ? OutputTimeoutMs : FirstOutputTimeoutMs;

            // Some hardware encoders ask for their first picture only once they have one, so the first goes in unasked.
            if (_fedAny)
            {
                if (!PumpUntil(() => _needInput > 0, timeout))
                {
                    // Not ready for another picture yet: this one is skipped, unless nothing has come out for too long.
                    if (_clock.ElapsedMilliseconds - _lastOutputMs > StallMs) throw new TimeoutException("The H.264 encoder stopped asking for pictures.");
                    _consecutiveEmpty++;
                    return null;
                }
            }
            else
            {
                PumpUntil(() => true, 0);
            }

            Check(mft.ProcessInput(0, sample, 0), "feed the encoder");
            _fedAny = true;
            if (_needInput > 0) _needInput--;

            // Wait for the picture to come back. Not coming back at all is normal for an occasional skipped frame.
            PumpUntil(() => _haveOutput > 0, timeout);
            while (_haveOutput > 0)
            {
                _haveOutput--;
                var piece = TakeOutput(mft);
                if (piece is not null) result = result is null ? piece : Concat(result, piece);
            }
        }

        if (result is null)
        {
            _consecutiveEmpty++;
            if (_clock.ElapsedMilliseconds - _lastOutputMs > StallMs) throw new TimeoutException("The H.264 encoder stopped producing pictures.");
            return null;
        }

        _consecutiveEmpty = 0;
        _lastOutputMs = _clock.ElapsedMilliseconds;
        _gotOutput = true;
        return result;
    }

    private static byte[] Concat(byte[] a, byte[] b)
    {
        var joined = new byte[a.Length + b.Length];
        Buffer.BlockCopy(a, 0, joined, 0, a.Length);
        Buffer.BlockCopy(b, 0, joined, a.Length, b.Length);
        return joined;
    }

    private byte[]? DrainSync(IMFTransform mft)
    {
        byte[]? result = null;
        for (var guard = 0; guard < 8; guard++)
        {
            var piece = TakeOutput(mft, out var more);
            if (piece is not null) result = result is null ? piece : Concat(result, piece);
            if (!more) break;
        }
        return result;
    }

    private bool PumpUntil(Func<bool> done, int timeoutMs)
    {
        var events = _events!;
        var watch = Stopwatch.StartNew();
        var spin = new SpinWait();
        while (true)
        {
            var hr = events.GetEvent(1, out var evt); // do not wait
            if (hr >= 0 && evt is not null)
            {
                evt.GetEventType(out var type);
                evt.GetStatus(out var status);
                if (type != EventNeedInput && type != EventHaveOutput) Trace?.Invoke($"event {type} status=0x{status:X8}");
                Marshal.ReleaseComObject(evt);
                if (type == EventNeedInput) _needInput++;
                else if (type == EventHaveOutput) _haveOutput++;
                if (done()) return true;
                continue;
            }
            if (hr != HrNoEvents) Check(hr, "read an encoder event");
            if (done()) return true;
            if (watch.ElapsedMilliseconds >= timeoutMs) { Trace?.Invoke($"gave up waiting after {timeoutMs} ms: need={_needInput} have={_haveOutput} fed={_fedAny} gotOutput={_gotOutput} empty={_consecutiveEmpty} at {_clock.ElapsedMilliseconds} ms"); return false; }
            if (watch.ElapsedMilliseconds < 3) spin.SpinOnce(-1); else Thread.Sleep(1);
        }
    }

    private byte[]? TakeOutput(IMFTransform mft) => TakeOutput(mft, out _);

    private byte[]? TakeOutput(IMFTransform mft, out bool more)
    {
        more = false;
        IMFSample? own = null;
        var buffer = new OutputDataBuffer();
        IntPtr ownPointer = IntPtr.Zero;

        if (!_providesSamples)
        {
            Check(MFCreateSample(out own), "create the output sample");
            Check(MFCreateMemoryBuffer(_outputBufferSize, out var memory), "create the output buffer");
            own.AddBuffer(memory);
            Marshal.ReleaseComObject(memory);
            ownPointer = Marshal.GetComInterfaceForObject(own, typeof(IMFSample));
            buffer.Sample = ownPointer;
        }

        try
        {
            var hr = mft.ProcessOutput(0, 1, ref buffer, out _);
            if (hr == HrNeedMoreInput) return null;
            if (hr == HrStreamChange)
            {
                if (mft.GetOutputAvailableType(0, 0, out var type) >= 0 && type is not null)
                {
                    mft.SetOutputType(0, type, 0);
                    Marshal.ReleaseComObject(type);
                }
                more = true;
                return null;
            }
            Check(hr, "read the encoder output");
            more = !_async;

            var sample = own ?? (buffer.Sample != IntPtr.Zero ? (IMFSample)Marshal.GetObjectForIUnknown(buffer.Sample) : null);
            if (sample is null) return null;

            try
            {
                Check(sample.ConvertToContiguousBuffer(out var contiguous), "read the output buffer");
                try
                {
                    Check(contiguous.Lock(out var data, out _, out var length), "lock the output buffer");
                    try
                    {
                        if (length <= 0) return null;
                        var bytes = new byte[length];
                        Marshal.Copy(data, bytes, 0, length);
                        return bytes;
                    }
                    finally { contiguous.Unlock(); }
                }
                finally { Marshal.ReleaseComObject(contiguous); }
            }
            finally
            {
                if (!ReferenceEquals(sample, own)) Marshal.ReleaseComObject(sample);
            }
        }
        finally
        {
            if (buffer.Sample != IntPtr.Zero && _providesSamples) Marshal.Release(buffer.Sample);
            if (buffer.Events != IntPtr.Zero) Marshal.Release(buffer.Events);
            if (ownPointer != IntPtr.Zero) Marshal.Release(ownPointer);
            if (own is not null) Marshal.ReleaseComObject(own);
        }
    }

    private void Release()
    {
        try
        {
            if (_mft is not null)
            {
                _mft.ProcessMessage(MessageEndStreaming, IntPtr.Zero);
                _mft.ProcessMessage(MessageFlush, IntPtr.Zero);
            }
        }
        catch (Exception) { }

        try { _d3d?.Dispose(); } catch (Exception) { }
        _d3d = null;

        var comObjects = new List<object?>();
        comObjects.AddRange(_inputSamples);
        comObjects.AddRange(_inputBuffers);
        comObjects.AddRange(new object?[] { _codec, _events, _mft });
        foreach (var com in comObjects)
        {
            try { if (com is not null && Marshal.IsComObject(com)) Marshal.FinalReleaseComObject(com); }
            catch (Exception) { }
        }
        Array.Clear(_inputSamples);
        Array.Clear(_inputBuffers);
        _codec = null;
        _events = null;
        _mft = null;
        _width = 0;
        _height = 0;

        // A later Initialise needs a new encoder, and an activation object hands back the same one until it is shut down.
        try { ((IMFActivate)_candidate.Activate).ShutdownObject(); } catch (Exception) { }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            _disposed = true;
            Release();
        }
    }
}
