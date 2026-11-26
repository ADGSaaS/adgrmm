// agents/windows/AdgRmm.Agent/Services/ScreenVp8Encoder.cs

using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using SIPSorceryMedia.Abstractions;
using vpxmd;

namespace AdgRmm.Agent.Services;

/// <summary>
/// VP8 encoder tuned for desktop video. The library's VpxVideoEncoder cannot be used for this:
/// it overwrites its bitrate with defaults, runs on one thread, and gives every frame the same
/// timestamp, which leaves rate control unable to work.
/// </summary>
public sealed class ScreenVp8Encoder : IVideoEncoder
{
    private const int EncoderAbiVersion = 23;
    private const int ForceKeyFrameFlag = 1;
    private const uint DeadlineRealtime = 1;

    // An unchanged screen is still sent this often, so the stream never looks stalled.
    private const long IdleIntervalMs = 1000;

    // After a change the same picture is sent again for a while, which lets the encoder sharpen what
    // it had to send roughly while the screen was moving.
    private const long SharpenWindowMs = 3000;
    private const long SharpenIntervalMs = 200;

    [DllImport("vpxmd", CallingConvention = CallingConvention.Cdecl, EntryPoint = "vpx_codec_control_")]
    private static extern int CodecControl(IntPtr ctx, int controlId, int value);

    private readonly object _lock = new();
    private uint _targetKbps;
    private readonly int _fps;
    private readonly Stopwatch _clock = Stopwatch.StartNew();

    private VpxCodecCtx? _ctx;
    private VpxCodecEncCfg? _cfg;
    private VpxImage? _image;
    private bool _imageAllocated;
    private int _width;
    private int _height;
    private byte[]? _i420;
    private byte[]? _previous;
    private long _lastSentMs = -IdleIntervalMs;
    private long _lastChangeMs;
    private long _lastPts = -1;
    private bool _forceKeyFrame = true;
    private bool _disposed;

    public ScreenVp8Encoder(int targetKbps, int fps)
    {
        _targetKbps = (uint)Math.Max(100, targetKbps);
        _fps = Math.Max(1, fps);
    }

    public List<VideoFormat> SupportedFormats { get; } =
        new() { new VideoFormat(VideoCodecsEnum.VP8, 96) };

    private long _encodeTicks;
    private long _encodeCount;

    /// <summary>The average time to encode a frame since this was last asked, and how many there were.</summary>
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

    public void ForceKeyFrame()
    {
        lock (_lock) _forceKeyFrame = true;
    }

    /// <summary>Changes the bitrate of a running encoder, so a session can follow its network.</summary>
    public void SetTargetKbps(int kbps)
    {
        lock (_lock)
        {
            _targetKbps = (uint)Math.Max(100, kbps);
            if (_ctx is null || _cfg is null) return;
            _cfg.RcTargetBitrate = _targetKbps;
            vpx_encoder.VpxCodecEncConfigSet(_ctx, _cfg);
        }
    }

    private void Initialise(int width, int height)
    {
        var cfg = new VpxCodecEncCfg();
        var result = vpx_encoder.VpxCodecEncConfigDefault(vp8cx.VpxCodecVp8Cx(), cfg, 0);
        if (result != VpxCodecErrT.VPX_CODEC_OK) throw new InvalidOperationException($"VP8 defaults failed: {result}");

        cfg.GW = (uint)width;
        cfg.GH = (uint)height;
        cfg.GThreads = (uint)Math.Clamp(Environment.ProcessorCount / 2, 1, 8);
        cfg.GTimebase.Num = 1;
        cfg.GTimebase.Den = 1000;
        cfg.GLagInFrames = 0;
        cfg.GErrorResilient = 1;
        cfg.RcTargetBitrate = _targetKbps;
        // Constant bitrate, because a frame far over budget is what overflows a network queue.
        cfg.RcEndUsage = VpxRcMode.VPX_CBR;
        cfg.RcMinQuantizer = 4;
        cfg.RcMaxQuantizer = 52;
        cfg.RcDropframeThresh = 30;
        cfg.RcResizeAllowed = 0;
        cfg.RcUndershootPct = 100;
        cfg.RcOvershootPct = 15;
        cfg.RcBufSz = 1000;
        cfg.RcBufInitialSz = 500;
        cfg.RcBufOptimalSz = 600;
        cfg.KfMode = VpxKfMode.VPX_KF_DISABLED;

        // Assigned only on success, because destroying a context that never initialised crashes.
        var ctx = new VpxCodecCtx();
        result = vpx_encoder.VpxCodecEncInitVer(ctx, vp8cx.VpxCodecVp8Cx(), cfg, 0, EncoderAbiVersion);
        if (result != VpxCodecErrT.VPX_CODEC_OK) throw new InvalidOperationException($"VP8 init failed: {result}");
        _ctx = ctx;
        _cfg = cfg;

        var handle = ctx.__Instance;
        CodecControl(handle, (int)Vp8eEncControlId.VP8E_SET_CPUUSED, 12);
        CodecControl(handle, (int)Vp8eEncControlId.VP8E_SET_SCREEN_CONTENT_MODE, 1);
        CodecControl(handle, (int)Vp8eEncControlId.VP8E_SET_STATIC_THRESHOLD, 1);
        CodecControl(handle, (int)Vp8eEncControlId.VP8E_SET_TOKEN_PARTITIONS, 2);
        CodecControl(handle, (int)Vp8eEncControlId.VP8E_SET_MAX_INTRA_BITRATE_PCT, 500);

        _image = new VpxImage();
        _width = width;
        _height = height;
        _i420 = new byte[width * height * 3 / 2];
    }

    // BT.601 limited range, which is what browsers assume for VP8.
    private static void BgraToI420(byte[] bgra, int w, int h, byte[] i420)
    {
        int ySize = w * h;
        int uOffset = ySize;
        int vOffset = ySize + (ySize / 4);
        int chromaW = w / 2;

        Parallel.For(0, h, y =>
        {
            int src = y * w * 4;
            int dst = y * w;
            for (int x = 0; x < w; x++, src += 4, dst++)
            {
                int b = bgra[src], g = bgra[src + 1], r = bgra[src + 2];
                i420[dst] = (byte)(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
            }

            if ((y & 1) != 0 || y + 1 >= h) return;

            int row = y / 2 * chromaW;
            int s0 = y * w * 4;
            int s1 = s0 + (w * 4);
            for (int x = 0; x < chromaW; x++, s0 += 8, s1 += 8)
            {
                int b = (bgra[s0] + bgra[s0 + 4] + bgra[s1] + bgra[s1 + 4]) >> 2;
                int g = (bgra[s0 + 1] + bgra[s0 + 5] + bgra[s1 + 1] + bgra[s1 + 5]) >> 2;
                int r = (bgra[s0 + 2] + bgra[s0 + 6] + bgra[s1 + 2] + bgra[s1 + 6]) >> 2;
                i420[uOffset + row + x] = (byte)(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
                i420[vOffset + row + x] = (byte)(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
            }
        });
    }

    public byte[]? EncodeVideo(int width, int height, byte[] sample, VideoPixelFormatsEnum pixelFormat, VideoCodecsEnum codec)
    {
        if (codec != VideoCodecsEnum.VP8) throw new NotSupportedException($"Only VP8 is supported, not {codec}.");
        if (pixelFormat != VideoPixelFormatsEnum.Bgra) throw new NotSupportedException($"Only BGRA input is supported, not {pixelFormat}.");

        lock (_lock)
        {
            if (_disposed) return null;
            if (_ctx is null || width != _width || height != _height)
            {
                ReleaseEncoder();
                Initialise(width, height);
            }

            long now = _clock.ElapsedMilliseconds;

            var unchanged = _previous is { } prev && prev.Length == sample.Length && prev.AsSpan().SequenceEqual(sample);
            if (unchanged)
            {
                // An unchanged screen costs no bandwidth and almost no CPU.
                var interval = now - _lastChangeMs < SharpenWindowMs ? SharpenIntervalMs : IdleIntervalMs;
                if (!_forceKeyFrame && now - _lastSentMs < interval) return null;
            }
            else
            {
                _lastChangeMs = now;
                if (_previous is null || _previous.Length != sample.Length) _previous = new byte[sample.Length];
                Buffer.BlockCopy(sample, 0, _previous, 0, sample.Length);
            }

            var encodeStart = Stopwatch.GetTimestamp();
            BgraToI420(sample, width, height, _i420!);

            long pts = Math.Max(now, _lastPts + 1);

            // The real time since the last frame, so rate control knows what it can spend on this one.
            uint duration = (uint)Math.Clamp(_lastPts < 0 ? 1000 / _fps : pts - _lastPts, 1, IdleIntervalMs);
            _lastPts = pts;

            int flags = _forceKeyFrame ? ForceKeyFrameFlag : 0;
            _forceKeyFrame = false;

            byte[]? encoded = null;
            unsafe
            {
                fixed (byte* frame = _i420)
                {
                    if (!_imageAllocated)
                    {
                        _imageAllocated = true;
                        VpxImage.VpxImgAlloc(_image, VpxImgFmt.VPX_IMG_FMT_I420, (uint)width, (uint)height, 1);
                    }
                    VpxImage.VpxImgWrap(_image, VpxImgFmt.VPX_IMG_FMT_I420, (uint)width, (uint)height, 1, frame);

                    var result = vpx_encoder.VpxCodecEncode(_ctx, _image, pts, duration, flags, DeadlineRealtime);
                    if (result != VpxCodecErrT.VPX_CODEC_OK) throw new InvalidOperationException($"VP8 encode failed: {result}");

                    IntPtr iter = IntPtr.Zero;
                    var packet = vpx_encoder.VpxCodecGetCxData(_ctx, (void**)&iter);
                    while (packet != null)
                    {
                        if (packet.Kind == VpxCodecCxPktKind.VPX_CODEC_CX_FRAME_PKT)
                        {
                            encoded = new byte[packet.data.Raw.Sz];
                            Marshal.Copy(packet.data.Raw.Buf, encoded, 0, encoded.Length);
                        }
                        packet = vpx_encoder.VpxCodecGetCxData(_ctx, (void**)&iter);
                    }
                }
            }

            _encodeTicks += Stopwatch.GetTimestamp() - encodeStart;
            _encodeCount++;

            if (encoded != null) _lastSentMs = now;
            return encoded;
        }
    }

    public byte[] EncodeVideoFaster(RawImage rawImage, VideoCodecsEnum codec) => throw new NotSupportedException();

    public IEnumerable<VideoSample> DecodeVideo(byte[] encodedSample, VideoPixelFormatsEnum pixelFormat, VideoCodecsEnum codec)
        => throw new NotSupportedException("This encoder does not decode.");

    public IEnumerable<RawImage> DecodeVideoFaster(byte[] encodedSample, VideoPixelFormatsEnum pixelFormat, VideoCodecsEnum codec)
        => throw new NotSupportedException("This encoder does not decode.");

    private void ReleaseEncoder()
    {
        if (_ctx != null)
        {
            vpx_codec.VpxCodecDestroy(_ctx);
            _ctx = null;
            _cfg = null;
        }
        _image = null;
        _imageAllocated = false;
    }

    public void Dispose()
    {
        lock (_lock)
        {
            _disposed = true;
            ReleaseEncoder();
        }
    }
}
