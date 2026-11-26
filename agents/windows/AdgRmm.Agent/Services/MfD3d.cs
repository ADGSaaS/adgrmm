// agents/windows/AdgRmm.Agent/Services/MfD3d.cs

using System.Runtime.InteropServices;

namespace AdgRmm.Agent.Services;

/// <summary>
/// A hardware H.264 encoder belongs to one graphics adapter and wants to be given that adapter's Direct3D device
/// before it starts. Pictures still go in from memory: the device is only what the driver needs to run on.
/// </summary>
internal sealed class MfD3dDevice : IDisposable
{
    public static readonly Guid AdapterLuidAttribute = new("1d39518c-e220-4da8-a07f-ba172552d6b1");
    public static readonly Guid D3d11AwareAttribute = new("206b4fc8-fcf9-4c51-afe3-9764369e33a0");

    private const uint CreateBgraSupport = 0x20;
    private const uint CreateVideoSupport = 0x800;
    private const uint Sdk = 7;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct AdapterDesc1
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint VendorId, DeviceId, SubSysId, Revision;
        public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
        public uint LuidLow;
        public int LuidHigh;
        public uint Flags;
    }

    [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDxgiFactory1
    {
        [PreserveSig] int SetPrivateData();
        [PreserveSig] int SetPrivateDataInterface();
        [PreserveSig] int GetPrivateData();
        [PreserveSig] int GetParent();
        [PreserveSig] int EnumAdapters();
        [PreserveSig] int MakeWindowAssociation();
        [PreserveSig] int GetWindowAssociation();
        [PreserveSig] int CreateSwapChain();
        [PreserveSig] int CreateSoftwareAdapter();
        [PreserveSig] int EnumAdapters1(uint index, out IDxgiAdapter1 adapter);
    }

    [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDxgiAdapter1
    {
        [PreserveSig] int SetPrivateData();
        [PreserveSig] int SetPrivateDataInterface();
        [PreserveSig] int GetPrivateData();
        [PreserveSig] int GetParent();
        [PreserveSig] int EnumOutputs();
        [PreserveSig] int GetDesc();
        [PreserveSig] int CheckInterfaceSupport();
        [PreserveSig] int GetDesc1(out AdapterDesc1 desc);
    }

    [ComImport, Guid("eb533d5d-2db6-40f8-97a9-494692014f07"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMfDxgiDeviceManager
    {
        [PreserveSig] int CloseDeviceHandle(IntPtr handle);
        [PreserveSig] int GetVideoService(IntPtr handle, ref Guid iid, out IntPtr service);
        [PreserveSig] int LockDevice(IntPtr handle, ref Guid iid, out IntPtr device, bool block);
        [PreserveSig] int OpenDeviceHandle(out IntPtr handle);
        [PreserveSig] int ResetDevice(IntPtr device, uint token);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Texture2DDesc
    {
        public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CpuAccessFlags, MiscFlags;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int SetMultithreadProtectedFn(IntPtr self, int protect);

    private static IntPtr VTable(IntPtr self, int index) => Marshal.ReadIntPtr(Marshal.ReadIntPtr(self), index * IntPtr.Size);

    private static readonly Guid IidMultithread = new("9b7e4e00-342c-4106-a19f-4f2704f689f0");

    /// <summary>The driver's encoder may call into the device from its own threads, which Direct3D only allows when told so.</summary>
    private void ProtectMultithread()
    {
        var iid = IidMultithread;
        if (Marshal.QueryInterface(_device, ref iid, out var mt) < 0 || mt == IntPtr.Zero) return;
        try
        {
            var set = Marshal.GetDelegateForFunctionPointer<SetMultithreadProtectedFn>(VTable(mt, 5));
            set(mt, 1);
        }
        finally { Marshal.Release(mt); }
    }

    [DllImport("dxgi.dll")] private static extern int CreateDXGIFactory1(ref Guid iid, out IDxgiFactory1 factory);

    [DllImport("d3d11.dll")]
    private static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint levelCount,
        uint sdk, out IntPtr device, out int level, out IntPtr context);

    [DllImport("mfplat.dll")] private static extern int MFCreateDXGIDeviceManager(out uint token, out IMfDxgiDeviceManager manager);

    private IntPtr _device;
    private IntPtr _context;
    private IMfDxgiDeviceManager? _manager;

    /// <summary>The graphics adapters that can run a hardware encoder, the one with the most video memory (the discrete card) first. Software adapters are left out.</summary>
    public static List<(ulong Luid, string Name)> Adapters()
    {
        var result = new List<(ulong Luid, string Name, ulong Memory)>();
        try
        {
            var iid = typeof(IDxgiFactory1).GUID;
            if (CreateDXGIFactory1(ref iid, out var factory) < 0) return new();
            for (uint index = 0; factory.EnumAdapters1(index, out var adapter) >= 0; index++)
            {
                adapter.GetDesc1(out var desc);
                Marshal.ReleaseComObject(adapter);
                if ((desc.Flags & 2) != 0 || desc.VendorId == 0x1414) continue; // software (WARP, Basic Render)
                result.Add((((ulong)(uint)desc.LuidHigh << 32) | desc.LuidLow, desc.Description, (ulong)desc.DedicatedVideoMemory));
            }
            Marshal.ReleaseComObject(factory);
        }
        catch (Exception) { }
        return result.OrderByDescending(a => a.Memory).Select(a => (a.Luid, a.Name)).ToList();
    }

    /// <summary>The device manager to hand to an encoder, as a COM pointer owned by this object.</summary>
    public IntPtr ManagerPointer { get; private set; }

    /// <summary>Creates a device on the adapter with this LUID, or on the default adapter when it is zero or unknown.</summary>
    public static MfD3dDevice Create(ulong adapterLuid)
    {
        var result = new MfD3dDevice();
        try
        {
            IntPtr adapterPointer = IntPtr.Zero;
            object? adapterObject = null;
            if (adapterLuid != 0)
            {
                var iid = typeof(IDxgiFactory1).GUID;
                if (CreateDXGIFactory1(ref iid, out var factory) >= 0)
                {
                    for (uint index = 0; factory.EnumAdapters1(index, out var adapter) >= 0; index++)
                    {
                        adapter.GetDesc1(out var desc);
                        var luid = ((ulong)(uint)desc.LuidHigh << 32) | desc.LuidLow;
                        if (luid == adapterLuid)
                        {
                            adapterObject = adapter;
                            adapterPointer = Marshal.GetComInterfaceForObject(adapter, typeof(IDxgiAdapter1));
                            break;
                        }
                        Marshal.ReleaseComObject(adapter);
                    }
                    Marshal.ReleaseComObject(factory);
                }
            }

            // With an adapter given the driver type must be "unknown" (0), with none the default hardware one (1).
            var hr = D3D11CreateDevice(adapterPointer, adapterPointer != IntPtr.Zero ? 0 : 1, IntPtr.Zero, CreateBgraSupport | CreateVideoSupport,
                IntPtr.Zero, 0, Sdk, out result._device, out _, out result._context);
            if (adapterPointer != IntPtr.Zero) Marshal.Release(adapterPointer);
            if (adapterObject is not null) Marshal.ReleaseComObject(adapterObject);
            MfInterop.Check(hr, "create a Direct3D device");
            result.ProtectMultithread();

            MfInterop.Check(MFCreateDXGIDeviceManager(out var token, out var manager), "create the device manager");
            result._manager = manager;
            MfInterop.Check(manager.ResetDevice(result._device, token), "give the device to the manager");
            result.ManagerPointer = Marshal.GetComInterfaceForObject(manager, typeof(IMfDxgiDeviceManager));
            return result;
        }
        catch
        {
            result.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        if (ManagerPointer != IntPtr.Zero) { Marshal.Release(ManagerPointer); ManagerPointer = IntPtr.Zero; }
        if (_manager is not null) { Marshal.ReleaseComObject(_manager); _manager = null; }
        if (_context != IntPtr.Zero) { Marshal.Release(_context); _context = IntPtr.Zero; }
        if (_device != IntPtr.Zero) { Marshal.Release(_device); _device = IntPtr.Zero; }
    }
}
