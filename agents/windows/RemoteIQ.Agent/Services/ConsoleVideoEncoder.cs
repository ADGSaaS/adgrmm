// agents/windows/RemoteIQ.Agent/Services/ConsoleVideoEncoder.cs

using SIPSorceryMedia.Abstractions;

namespace RemoteIQ.Agent.Services;

/// <summary>
/// The encoder the capture side talks to. It starts as the VP8 encoder, exactly as before, and becomes the H.264 one only
/// when the session negotiated H.264 and the encoder could be started. If H.264 fails at any point it goes back to VP8 by
/// itself (the next picture is a VP8 keyframe) and says so, so the sender and the log follow.
/// </summary>
public sealed class ConsoleVideoEncoder : IVideoEncoder
{
    private readonly object _gate = new();
    private readonly ScreenVp8Encoder _vp8;
    private readonly Action<string> _onH264Failed;
    private IScreenEncoder? _h264;
    private volatile ConsoleVideoCodec _active = ConsoleVideoCodec.Vp8;
    private int _kbps;
    private int _fps;

    public ConsoleVideoEncoder(ScreenVp8Encoder vp8, int startKbps, int fps, Action<string> onH264Failed)
    {
        _vp8 = vp8;
        _kbps = startKbps;
        _fps = fps;
        _onH264Failed = onH264Failed;
    }

    public ConsoleVideoCodec Active => _active;
    public bool H264Hardware { get; private set; }
    public string? H264Name { get; private set; }

    public List<VideoFormat> SupportedFormats => _vp8.SupportedFormats;

    /// <summary>Starts the H.264 encoder the start-up check approved. Returns false (and stays on VP8) if it cannot be started.</summary>
    public bool TryEnableH264(H264Capability capability, Func<IScreenEncoder?> create, out string? error)
    {
        error = null;
        lock (_gate)
        {
            try
            {
                var encoder = create();
                if (encoder is null) { error = "the approved encoder is no longer offered by Windows"; return false; }
                _h264 = encoder;
                H264Hardware = capability.Hardware;
                H264Name = encoder.Description;
                encoder.SetTargetKbps(_kbps);
                encoder.ForceKeyFrame();
                _active = ConsoleVideoCodec.H264;
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }
    }

    /// <summary>Goes back to VP8 and drops the H.264 encoder. Safe to call from any thread, and when already on VP8.</summary>
    public void FallBackToVp8()
    {
        lock (_gate)
        {
            if (_active == ConsoleVideoCodec.Vp8) return;
            _active = ConsoleVideoCodec.Vp8;
            try { _h264?.Dispose(); } catch { }
            _h264 = null;
            _vp8.ForceKeyFrame();
        }
    }

    public void ForceKeyFrame()
    {
        lock (_gate)
        {
            if (_active == ConsoleVideoCodec.H264) _h264?.ForceKeyFrame();
            else _vp8.ForceKeyFrame();
        }
    }

    public void SetTargetKbps(int kbps)
    {
        lock (_gate)
        {
            _kbps = kbps;
            _vp8.SetTargetKbps(kbps);
            _h264?.SetTargetKbps(kbps);
        }
    }

    public (double Ms, long Frames) TakeEncodeStats()
    {
        lock (_gate) return _active == ConsoleVideoCodec.H264 && _h264 is not null ? _h264.TakeEncodeStats() : _vp8.TakeEncodeStats();
    }

    public byte[]? EncodeVideo(int width, int height, byte[] sample, VideoPixelFormatsEnum pixelFormat, VideoCodecsEnum codec)
    {
        string? failure = null;
        lock (_gate)
        {
            if (_active == ConsoleVideoCodec.H264 && _h264 is not null)
            {
                try
                {
                    return _h264.Encode(width, height, sample);
                }
                catch (Exception ex)
                {
                    failure = ex.Message;
                    _active = ConsoleVideoCodec.Vp8;
                    try { _h264.Dispose(); } catch { }
                    _h264 = null;
                    _vp8.ForceKeyFrame();
                }
            }
        }

        // Told outside the lock, and before the VP8 picture is returned, so the sender is on VP8 when that picture arrives.
        if (failure is not null) _onH264Failed(failure);

        return _vp8.EncodeVideo(width, height, sample, pixelFormat, VideoCodecsEnum.VP8);
    }

    public byte[] EncodeVideoFaster(RawImage rawImage, VideoCodecsEnum codec) => throw new NotSupportedException();

    public IEnumerable<VideoSample> DecodeVideo(byte[] encodedSample, VideoPixelFormatsEnum pixelFormat, VideoCodecsEnum codec)
        => throw new NotSupportedException("This encoder does not decode.");

    public IEnumerable<RawImage> DecodeVideoFaster(byte[] encodedSample, VideoPixelFormatsEnum pixelFormat, VideoCodecsEnum codec)
        => throw new NotSupportedException("This encoder does not decode.");

    public void Dispose()
    {
        lock (_gate)
        {
            try { _h264?.Dispose(); } catch { }
            _h264 = null;
            _vp8.Dispose();
        }
    }
}
