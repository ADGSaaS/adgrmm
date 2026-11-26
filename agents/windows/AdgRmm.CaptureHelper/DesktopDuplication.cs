// agents/windows/AdgRmm.CaptureHelper/DesktopDuplication.cs

using System;
using System.Runtime.InteropServices;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;

/// <summary>
/// Reads the screen through Windows' Desktop Duplication API, which hands over the finished picture
/// instead of copying it pixel by pixel, and leaves the pointer out. It is not available everywhere,
/// such as in a Remote Desktop session, so a failure here just means the older screen copy is used.
/// All of it runs on the capture thread.
/// </summary>
internal sealed class DesktopDuplication : IDisposable
{
    // After a failure, how long the older method runs before this is tried again. Setting this up is
    // too slow to retry on every frame.
    private const long RetryAfterMs = 5000;

    private ID3D11Device? _device;
    private ID3D11DeviceContext? _context;
    private IDXGIOutputDuplication? _duplication;
    private ID3D11Texture2D? _staging;
    private MonitorRect? _monitor;
    private byte[]? _latest;
    private long _retryAtMs;

    /// <summary>Why it last could not be used, for the logs.</summary>
    public string? LastProblem { get; private set; }

    /// <summary>
    /// The current picture of the monitor, or null if the older method has to supply this frame. An
    /// unchanged screen returns the previous picture without any copying from the graphics system.
    /// </summary>
    public byte[]? TryCapture(MonitorRect monitor, byte[]? reuse, long nowMs)
    {
        if (nowMs < _retryAtMs) return null;

        try
        {
            if (_duplication is null || _monitor != monitor)
            {
                Release();
                if (!Open(monitor))
                {
                    _retryAtMs = nowMs + RetryAfterMs;
                    return null;
                }
            }

            var result = _duplication!.AcquireNextFrame(0, out var info, out var resource);

            if (result.Code == Vortice.DXGI.ResultCode.WaitTimeout.Code) return CopyOfLatest(reuse);

            if (result.Failure)
            {
                // Usually the desktop changed, such as a sign-in screen or a resolution change.
                LastProblem = $"AcquireNextFrame 0x{result.Code:X8}";
                Release();
                _retryAtMs = nowMs + (result.Code == Vortice.DXGI.ResultCode.AccessLost.Code ? 0 : RetryAfterMs);
                return null;
            }

            try
            {
                // Only the pointer moved, and it is not part of the picture.
                if (info.LastPresentTime == 0) return CopyOfLatest(reuse);

                using var texture = resource!.QueryInterface<ID3D11Texture2D>();
                _context!.CopyResource(_staging!, texture);
                ReadStaging(monitor);
            }
            finally
            {
                resource?.Dispose();
                _duplication.ReleaseFrame();
            }

            return CopyOfLatest(reuse);
        }
        catch (Exception ex)
        {
            LastProblem = ex.Message;
            Release();
            _retryAtMs = nowMs + RetryAfterMs;
            return null;
        }
    }

    private byte[]? CopyOfLatest(byte[]? reuse)
    {
        // Nothing has been shown yet, so the older method supplies the first picture.
        if (_latest is null) return null;

        var buffer = reuse is not null && reuse.Length == _latest.Length ? reuse : new byte[_latest.Length];
        Buffer.BlockCopy(_latest, 0, buffer, 0, _latest.Length);
        return buffer;
    }

    private void ReadStaging(MonitorRect monitor)
    {
        var mapped = _context!.Map(_staging!, 0, MapMode.Read);
        try
        {
            var row = monitor.Width * 4;
            var total = row * monitor.Height;
            if (_latest is null || _latest.Length != total) _latest = new byte[total];

            for (var y = 0; y < monitor.Height; y++)
                Marshal.Copy(IntPtr.Add(mapped.DataPointer, y * (int)mapped.RowPitch), _latest, y * row, row);
        }
        finally
        {
            _context.Unmap(_staging!, 0);
        }
    }

    private bool Open(MonitorRect monitor)
    {
        if (DXGI.CreateDXGIFactory1(out IDXGIFactory1? factory).Failure || factory is null)
        {
            LastProblem = "CreateDXGIFactory1 failed";
            return false;
        }

        using (factory)
        {
            for (uint a = 0; factory.EnumAdapters1(a, out var adapter).Success; a++)
            {
                using (adapter)
                {
                    for (uint o = 0; adapter.EnumOutputs(o, out var output).Success; o++)
                    {
                        using (output)
                        {
                            var bounds = output.Description.DesktopCoordinates;
                            if (bounds.Left != monitor.Left || bounds.Top != monitor.Top ||
                                bounds.Right - bounds.Left != monitor.Width || bounds.Bottom - bounds.Top != monitor.Height)
                                continue;

                            // A rotated screen arrives rotated, which the older method already handles.
                            if (output.Description.Rotation is not (ModeRotation.Identity or ModeRotation.Unspecified))
                            {
                                LastProblem = "rotated screen";
                                return false;
                            }

                            return OpenOutput(adapter, output, monitor);
                        }
                    }
                }
            }
        }

        LastProblem = "no graphics output matches this monitor";
        return false;
    }

    private bool OpenOutput(IDXGIAdapter1 adapter, IDXGIOutput output, MonitorRect monitor)
    {
        var created = D3D11.D3D11CreateDevice(adapter, DriverType.Unknown, DeviceCreationFlags.BgraSupport, null!, out _device, out _context);
        if (created.Failure || _device is null || _context is null)
        {
            LastProblem = $"D3D11CreateDevice 0x{created.Code:X8}";
            Release();
            return false;
        }

        using var output1 = output.QueryInterface<IDXGIOutput1>();
        _duplication = output1.DuplicateOutput(_device);

        _staging = _device.CreateTexture2D(new Texture2DDescription
        {
            Width = (uint)monitor.Width,
            Height = (uint)monitor.Height,
            MipLevels = 1,
            ArraySize = 1,
            Format = Format.B8G8R8A8_UNorm,
            SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Staging,
            CPUAccessFlags = CpuAccessFlags.Read,
        });

        _monitor = monitor;
        LastProblem = null;
        return true;
    }

    private void Release()
    {
        _staging?.Dispose();
        _staging = null;
        _duplication?.Dispose();
        _duplication = null;
        _context?.Dispose();
        _context = null;
        _device?.Dispose();
        _device = null;
        _monitor = null;
    }

    public void Dispose() => Release();
}
