// GPU video super resolution through the D3D11 video processor and the vendor driver extensions,
// the same driver path Chromium uses for playback (no SDK needed):
//   NVIDIA RTX Video Super Resolution: stream extension {version 1, method 2 (super resolution), enable}.
//   Intel Video Super Resolution (experimental): VPE version 3, pre-processing mode, scaling = super resolution.
// Frames are NV12 in system memory; one Process() call uploads, scales and reads back one frame.
using System.Runtime.InteropServices;
using Vortice;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;

namespace Visubly.Upscaler;

public enum VsrVendor { None, Nvidia, Intel }

public sealed class GpuException(string message) : Exception(message);

public sealed class VideoProcessor : IDisposable
{
  public const uint VendorNvidia = 0x10DE;
  public const uint VendorIntel = 0x8086;
  public const uint VendorAmd = 0x1002;

  static readonly Guid NvidiaPpe = new("d43ce1b3-1f4b-48ac-baee-c3c25375e6f7");
  static readonly Guid IntelVpe = new("edd1d4b9-8659-4cbc-a4d6-9831a2163ac3");

  [StructLayout(LayoutKind.Sequential)]
  struct IntelVpeExt { public uint Function; public IntPtr Param; }

  readonly ID3D11Device device;
  readonly ID3D11DeviceContext ctx;
  readonly ID3D11VideoDevice vdev;
  readonly ID3D11VideoContext1 vctx;
  readonly ID3D11VideoProcessorEnumerator vpEnum;
  readonly ID3D11VideoProcessor vp;
  readonly ID3D11Texture2D inTex, inStage, outTex, outStage;
  readonly ID3D11VideoProcessorInputView inView;
  readonly ID3D11VideoProcessorOutputView outView;
  readonly VideoProcessorStream[] streams;
  uint frameIndex;

  public int InWidth { get; }
  public int InHeight { get; }
  public int OutWidth { get; }
  public int OutHeight { get; }
  public int InFrameBytes => InWidth * InHeight * 3 / 2;
  public int OutFrameBytes => OutWidth * OutHeight * 3 / 2;

  public static List<IDXGIAdapter1> Adapters()
  {
    var list = new List<IDXGIAdapter1>();
    using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
    for (uint i = 0; factory.EnumAdapters1(i, out IDXGIAdapter1? adapter).Success; i++)
    {
      if ((adapter!.Description1.Flags & AdapterFlags.Software) != 0) { adapter.Dispose(); continue; }
      list.Add(adapter);
    }
    return list;
  }

  public static IDXGIAdapter1? FindAdapter(uint vendorId)
  {
    IDXGIAdapter1? found = null;
    foreach (var a in Adapters())
    {
      if (found == null && a.Description1.VendorId == vendorId) found = a; else a.Dispose();
    }
    return found;
  }

  public VideoProcessor(IDXGIAdapter1 adapter, int inW, int inH, int outW, int outH, int fpsNum = 30, int fpsDen = 1)
  {
    if (inW % 2 != 0 || inH % 2 != 0 || outW % 2 != 0 || outH % 2 != 0) throw new ArgumentException("NV12 needs even frame sizes.");
    InWidth = inW; InHeight = inH; OutWidth = outW; OutHeight = outH;
    D3D11.D3D11CreateDevice(adapter, DriverType.Unknown, DeviceCreationFlags.VideoSupport | DeviceCreationFlags.BgraSupport,
      new[] { FeatureLevel.Level_11_1, FeatureLevel.Level_11_0 }, out ID3D11Device? d, out ID3D11DeviceContext? c).CheckError();
    device = d!; ctx = c!;
    vdev = device.QueryInterface<ID3D11VideoDevice>();
    vctx = ctx.QueryInterface<ID3D11VideoContext1>();

    var content = new VideoProcessorContentDescription
    {
      InputFrameFormat = VideoFrameFormat.Progressive,
      InputFrameRate = new Rational((uint)fpsNum, (uint)fpsDen), InputWidth = (uint)inW, InputHeight = (uint)inH,
      OutputFrameRate = new Rational((uint)fpsNum, (uint)fpsDen), OutputWidth = (uint)outW, OutputHeight = (uint)outH,
      Usage = VideoUsage.PlaybackNormal
    };
    vpEnum = vdev.CreateVideoProcessorEnumerator(content);
    vp = vdev.CreateVideoProcessor(vpEnum, 0);

    // The input must be bindable as a render target too, or CreateVideoProcessorInputView fails (measured).
    inTex = device.CreateTexture2D(new Texture2DDescription(Format.NV12, (uint)inW, (uint)inH, 1, 1, BindFlags.RenderTarget | BindFlags.ShaderResource, ResourceUsage.Default, CpuAccessFlags.None));
    inStage = device.CreateTexture2D(new Texture2DDescription(Format.NV12, (uint)inW, (uint)inH, 1, 1, BindFlags.None, ResourceUsage.Staging, CpuAccessFlags.Write));
    outTex = device.CreateTexture2D(new Texture2DDescription(Format.NV12, (uint)outW, (uint)outH, 1, 1, BindFlags.RenderTarget, ResourceUsage.Default, CpuAccessFlags.None));
    outStage = device.CreateTexture2D(new Texture2DDescription(Format.NV12, (uint)outW, (uint)outH, 1, 1, BindFlags.None, ResourceUsage.Staging, CpuAccessFlags.Read));
    inView = vdev.CreateVideoProcessorInputView(inTex, vpEnum, new VideoProcessorInputViewDescription { ViewDimension = VideoProcessorInputViewDimension.Texture2D });
    outView = vdev.CreateVideoProcessorOutputView(outTex, vpEnum, new VideoProcessorOutputViewDescription { ViewDimension = VideoProcessorOutputViewDimension.Texture2D });

    vctx.VideoProcessorSetStreamFrameFormat(vp, 0, VideoFrameFormat.Progressive);
    vctx.VideoProcessorSetStreamSourceRect(vp, 0, true, new RawRect(0, 0, inW, inH));
    vctx.VideoProcessorSetStreamDestRect(vp, 0, true, new RawRect(0, 0, outW, outH));
    vctx.VideoProcessorSetOutputTargetRect(vp, true, new RawRect(0, 0, outW, outH));
    vctx.VideoProcessorSetStreamColorSpace1(vp, 0, ColorSpaceType.YcbcrStudioG22LeftP709);
    vctx.VideoProcessorSetOutputColorSpace1(vp, ColorSpaceType.YcbcrStudioG22LeftP709);
    vctx.VideoProcessorSetStreamAutoProcessingMode(vp, 0, false);
    streams = new[] { new VideoProcessorStream { Enable = true, InputSurface = inView } };
  }

  /// <summary>Turns the vendor super resolution on or off. Returns false when the driver rejects it.</summary>
  public bool SetSuperResolution(VsrVendor vendor, bool on)
  {
    return vendor switch
    {
      VsrVendor.Nvidia => SetNvidia(on),
      VsrVendor.Intel => SetIntel(on),
      _ => !on
    };
  }

  bool SetNvidia(bool on)
  {
    uint[] data = { 1u, 2u, on ? 1u : 0u };
    var handle = GCHandle.Alloc(data, GCHandleType.Pinned);
    try { return vctx.VideoProcessorSetStreamExtension(vp, 0, NvidiaPpe, 12, handle.AddrOfPinnedObject()).Success; }
    finally { handle.Free(); }
  }

  unsafe bool SetIntel(bool on)
  {
    uint version = 3, mode = on ? 1u : 0u, scaling = on ? 2u : 0u;
    var ext = new IntelVpeExt { Function = 0x01, Param = (IntPtr)(&version) };
    if (!vctx.VideoProcessorSetOutputExtension(vp, IntelVpe, (uint)sizeof(IntelVpeExt), (IntPtr)(&ext)).Success) return false;
    ext = new IntelVpeExt { Function = 0x20, Param = (IntPtr)(&mode) };
    if (!vctx.VideoProcessorSetOutputExtension(vp, IntelVpe, (uint)sizeof(IntelVpeExt), (IntPtr)(&ext)).Success) return false;
    ext = new IntelVpeExt { Function = 0x37, Param = (IntPtr)(&scaling) };
    return vctx.VideoProcessorSetStreamExtension(vp, 0, IntelVpe, (uint)sizeof(IntelVpeExt), (IntPtr)(&ext)).Success;
  }

  public unsafe void Process(ReadOnlySpan<byte> input, Span<byte> output)
  {
    var m = ctx.Map(inStage, 0, MapMode.Write);
    fixed (byte* src = input)
    {
      byte* dst = (byte*)m.DataPointer;
      for (int y = 0; y < InHeight * 3 / 2; y++) Buffer.MemoryCopy(src + y * InWidth, dst + y * m.RowPitch, InWidth, InWidth);
    }
    ctx.Unmap(inStage, 0);
    ctx.CopyResource(inTex, inStage);
    var hr = vctx.VideoProcessorBlt(vp, outView, frameIndex++, 1, streams);
    if (hr.Failure) throw new GpuException($"VideoProcessorBlt failed (0x{hr.Code:X8}); device removed reason 0x{device.DeviceRemovedReason.Code:X8}.");
    ctx.CopyResource(outStage, outTex);
    var r = ctx.Map(outStage, 0, MapMode.Read);
    fixed (byte* dst = output)
    {
      byte* src = (byte*)r.DataPointer;
      for (int y = 0; y < OutHeight * 3 / 2; y++) Buffer.MemoryCopy(src + y * r.RowPitch, dst + y * OutWidth, OutWidth, OutWidth);
    }
    ctx.Unmap(outStage, 0);
  }

  public void Dispose()
  {
    outView.Dispose(); inView.Dispose();
    outStage.Dispose(); outTex.Dispose(); inStage.Dispose(); inTex.Dispose();
    vp.Dispose(); vpEnum.Dispose(); vctx.Dispose(); vdev.Dispose();
    ctx.Dispose(); device.Dispose();
  }
}
