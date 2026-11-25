// visubly-upscaler: helper process for ViSUBLY's "Nâng cấp video" tab.
//   probe                 adapters + whether NVIDIA / Intel driver super resolution is accepted AND changes pixels
//   bench [--seconds 1.5] super resolution speed (854x480 -> 1920x1080 frames per second) per working vendor
//   run --input ... --output ... --ffmpeg ... --mode ffmpeg|nvidia|intel ...   one upscale job (see Pipeline.cs)
// Every message is one JSON object per line on stdout. While "run" works, stdin takes: pause, resume, cancel.
using System.Diagnostics;
using System.Globalization;
using System.Text;
using Vortice.DXGI;

namespace Visubly.Upscaler;

public static class App
{
  public static int Main(string[] args)
  {
    Console.OutputEncoding = new UTF8Encoding(false);
    Console.InputEncoding = new UTF8Encoding(false);
    var command = args.Length > 0 ? args[0] : "help";
    var opts = Opts.Parse(args.Skip(1).ToArray());
    try
    {
      return command switch
      {
        "probe" => Probe(),
        "bench" => Bench(opts.Double("seconds", 1.5)),
        "run" => new Pipeline(opts).Run(),
        "version" => Version(),
        _ => Usage()
      };
    }
    catch (Exception ex)
    {
      Out.Emit(("type", "error"), ("kind", ex is GpuException ? "gpu" : "fatal"), ("message", ex.Message));
      return 2;
    }
  }

  static int Usage()
  {
    Console.Error.WriteLine("usage: visubly-upscaler probe | bench [--seconds 1.5] | run --input <file> --output <file> --ffmpeg <exe> --mode ffmpeg|nvidia|intel ...");
    return 1;
  }

  static int Version()
  {
    Out.Emit(("type", "version"), ("version", typeof(App).Assembly.GetName().Version?.ToString(3) ?? "0"));
    return 0;
  }

  public static string VendorName(uint id) => id switch
  {
    VideoProcessor.VendorNvidia => "nvidia",
    VideoProcessor.VendorIntel => "intel",
    VideoProcessor.VendorAmd => "amd",
    _ => "other"
  };

  /// <summary>Fine diagonal stripes and checkers: super resolution visibly changes such content.</summary>
  public static byte[] SyntheticFrame(int w, int h, int seed)
  {
    var buf = new byte[w * h * 3 / 2];
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++)
        buf[y * w + x] = (byte)((((x + seed) / 3 + y / 3) % 2 == 0 ? 50 : 200) + ((x * 7 + y * 3) % 23));
    for (int i = w * h; i < buf.Length; i++) buf[i] = (byte)(128 + ((i * 13) % 9) - 4);
    return buf;
  }

  static int Probe()
  {
    var adapters = new List<string>();
    var vsr = new List<string>();
    foreach (var adapter in VideoProcessor.Adapters())
    {
      using (adapter)
      {
        var d = adapter.Description1;
        var vendor = VendorName(d.VendorId);
        adapters.Add(Out.Object(("name", d.Description), ("vendor", vendor), ("vendorId", (long)d.VendorId),
          ("deviceId", (long)d.DeviceId), ("vramMb", (long)((ulong)d.DedicatedVideoMemory / (1024 * 1024)))));
        var kind = d.VendorId == VideoProcessor.VendorNvidia ? VsrVendor.Nvidia : d.VendorId == VideoProcessor.VendorIntel ? VsrVendor.Intel : VsrVendor.None;
        if (kind == VsrVendor.None) continue;
        vsr.Add(TestVsr(adapter, kind, vendor, d.Description));
      }
    }
    Out.Emit(("type", "probe"), ("adapters", new Raw("[" + string.Join(",", adapters) + "]")), ("vsr", new Raw("[" + string.Join(",", vsr) + "]")));
    return 0;
  }

  static string TestVsr(IDXGIAdapter1 adapter, VsrVendor kind, string vendor, string name)
  {
    try
    {
      using var vp = new VideoProcessor(adapter, 640, 360, 1280, 720);
      var input = SyntheticFrame(640, 360, 0);
      var plain = new byte[vp.OutFrameBytes];
      var enhanced = new byte[vp.OutFrameBytes];
      vp.SetSuperResolution(kind, false);
      for (int i = 0; i < 4; i++) vp.Process(input, plain);
      bool accepted = vp.SetSuperResolution(kind, true);
      for (int i = 0; i < 4; i++) vp.Process(input, enhanced);
      long diff = 0;
      for (int i = 0; i < plain.Length; i++) if (Math.Abs(plain[i] - enhanced[i]) > 2) diff++;
      double changed = (double)diff / plain.Length;
      // Accepted but no pixel change: the driver has it switched off (e.g. NVIDIA App > RTX Video Enhancement).
      return Out.Object(("vendor", vendor), ("adapter", name), ("accepted", accepted), ("effective", accepted && changed > 0.005), ("changed", changed));
    }
    catch (Exception ex)
    {
      return Out.Object(("vendor", vendor), ("adapter", name), ("accepted", false), ("effective", false), ("error", ex.Message));
    }
  }

  static int Bench(double seconds)
  {
    var results = new List<string>();
    foreach (var (vendorId, kind) in new[] { (VideoProcessor.VendorNvidia, VsrVendor.Nvidia), (VideoProcessor.VendorIntel, VsrVendor.Intel) })
    {
      using var adapter = VideoProcessor.FindAdapter(vendorId);
      if (adapter == null) continue;
      try
      {
        using var vp = new VideoProcessor(adapter, 854, 480, 1920, 1080);
        var input = SyntheticFrame(854, 480, 1);
        var output = new byte[vp.OutFrameBytes];
        bool accepted = vp.SetSuperResolution(kind, true);
        for (int i = 0; i < 5; i++) vp.Process(input, output);
        var sw = Stopwatch.StartNew();
        int frames = 0;
        while (sw.Elapsed.TotalSeconds < seconds) { vp.Process(input, output); frames++; }
        results.Add(Out.Object(("vendor", App.VendorName(vendorId)), ("accepted", accepted), ("fps", frames / sw.Elapsed.TotalSeconds)));
      }
      catch (Exception ex)
      {
        results.Add(Out.Object(("vendor", App.VendorName(vendorId)), ("accepted", false), ("error", ex.Message)));
      }
    }
    Out.Emit(("type", "bench"), ("results", new Raw("[" + string.Join(",", results) + "]")));
    return 0;
  }
}

public sealed class Opts
{
  readonly Dictionary<string, string> values = new(StringComparer.OrdinalIgnoreCase);

  public static Opts Parse(string[] args)
  {
    var o = new Opts();
    for (int i = 0; i < args.Length; i++)
    {
      if (!args[i].StartsWith("--")) continue;
      var key = args[i][2..];
      var value = i + 1 < args.Length && !args[i + 1].StartsWith("--") ? args[++i] : "true";
      o.values[key] = value;
    }
    return o;
  }

  public string? Str(string key) => values.TryGetValue(key, out var v) && v.Length > 0 ? v : null;
  public string Need(string key) => Str(key) ?? throw new ArgumentException($"Missing --{key}.");
  public int Int(string key, int fallback) => int.TryParse(Str(key), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : fallback;
  public double Double(string key, double fallback) => double.TryParse(Str(key), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : fallback;
}

public readonly record struct Raw(string Json);

public static class Out
{
  static readonly object Gate = new();

  public static void Emit(params (string Key, object? Value)[] fields)
  {
    var line = Object(fields);
    lock (Gate) { Console.Out.WriteLine(line); Console.Out.Flush(); }
  }

  public static string Object(params (string Key, object? Value)[] fields)
  {
    var sb = new StringBuilder("{");
    for (int i = 0; i < fields.Length; i++)
    {
      if (i > 0) sb.Append(',');
      Str(sb, fields[i].Key);
      sb.Append(':');
      Value(sb, fields[i].Value);
    }
    return sb.Append('}').ToString();
  }

  static void Value(StringBuilder sb, object? v)
  {
    switch (v)
    {
      case null: sb.Append("null"); break;
      case bool b: sb.Append(b ? "true" : "false"); break;
      case Raw r: sb.Append(r.Json); break;
      case string s: Str(sb, s); break;
      case int n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); break;
      case long n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); break;
      case double d: sb.Append(double.IsFinite(d) ? d.ToString("0.####", CultureInfo.InvariantCulture) : "null"); break;
      default: Str(sb, Convert.ToString(v, CultureInfo.InvariantCulture) ?? ""); break;
    }
  }

  static void Str(StringBuilder sb, string s)
  {
    sb.Append('"');
    foreach (var ch in s)
    {
      switch (ch)
      {
        case '"': sb.Append("\\\""); break;
        case '\\': sb.Append("\\\\"); break;
        case '\n': sb.Append("\\n"); break;
        case '\r': sb.Append("\\r"); break;
        case '\t': sb.Append("\\t"); break;
        default:
          if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4")); else sb.Append(ch);
          break;
      }
    }
    sb.Append('"');
  }
}
