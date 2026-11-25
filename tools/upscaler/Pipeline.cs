// One upscale job. Two shapes:
//   --mode ffmpeg            a single FFmpeg process: decode -> --pre filter chain (incl. scaling) -> encode.
//   --mode nvidia|intel      FFmpeg decode (+ --pre, e.g. denoise) -> raw NV12 -> driver super resolution
//                            -> raw NV12 -> FFmpeg encode (+ --post, e.g. sharpen), audio copied from the source.
// Output goes to "<name>.part.<ext>" and is renamed when the encoder finishes cleanly.
// Children run below normal priority inside a kill-on-close job object, so they never outlive this helper.
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace Visubly.Upscaler;

public sealed class Pipeline
{
  readonly Opts o;
  readonly string input, output, partPath, ffmpeg, mode;
  readonly long totalFrames;
  readonly ChildJob job = new();
  readonly List<Process> children = new();
  readonly ManualResetEventSlim running = new(true);
  volatile bool cancelled;
  long frames;
  readonly Stopwatch clock = new();
  readonly Dictionary<Process, StringBuilder> stderrTails = new();

  public Pipeline(Opts opts)
  {
    o = opts;
    input = o.Need("input");
    output = o.Need("output");
    ffmpeg = o.Need("ffmpeg");
    mode = (o.Str("mode") ?? "ffmpeg").ToLowerInvariant();
    totalFrames = o.Int("total-frames", 0);
    var ext = Path.GetExtension(output);
    partPath = Path.Combine(Path.GetDirectoryName(output) ?? ".", Path.GetFileNameWithoutExtension(output) + ".part" + ext);
  }

  public int Run()
  {
    if (!File.Exists(input)) throw new FileNotFoundException("Input video not found.", input);
    try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
    new Thread(ReadCommands) { IsBackground = true, Name = "commands" }.Start();
    clock.Start();
    Out.Emit(("type", "started"), ("mode", mode), ("total", totalFrames));
    try
    {
      int code = mode == "ffmpeg" ? RunFfmpegOnly() : RunWithVsr(mode == "intel" ? VsrVendor.Intel : VsrVendor.Nvidia);
      if (cancelled) return Cancelled();
      if (code != 0) return Fail("ffmpeg", $"FFmpeg exited with code {code}.");
      File.Move(partPath, output, overwrite: true);
      Out.Emit(("type", "done"), ("output", output), ("frames", frames), ("seconds", clock.Elapsed.TotalSeconds));
      return 0;
    }
    catch (GpuException ex)
    {
      return cancelled ? Cancelled() : Fail("gpu", ex.Message);
    }
    catch (IOException) when (cancelled)
    {
      return Cancelled();
    }
    catch (Exception ex)
    {
      return cancelled ? Cancelled() : Fail("fatal", ex.Message);
    }
    finally
    {
      KillChildren();
    }
  }

  int Cancelled()
  {
    KillChildren();
    TryDelete(partPath);
    Out.Emit(("type", "cancelled"));
    return 3;
  }

  int Fail(string kind, string message)
  {
    KillChildren();
    TryDelete(partPath);
    var tail = string.Join(" | ", stderrTails.Values.Select(t => t.ToString().Trim()).Where(t => t.Length > 0));
    Out.Emit(("type", "error"), ("kind", kind), ("message", message), ("detail", tail.Length > 1500 ? tail[^1500..] : tail));
    return kind == "gpu" ? 4 : 5;
  }

  // ---- shapes ---------------------------------------------------------------------------------------

  int RunFfmpegOnly()
  {
    var args = new List<string> { "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats" };
    AddHwInit(args);
    AddInputWindow(args);
    args.AddRange(new[] { "-map", "0:v:0" });
    AddAudio(args, 0);
    var pre = o.Str("pre");
    if (pre != null) args.AddRange(new[] { "-vf", pre });
    AddEncoder(args);
    args.Add(partPath);
    var p = Start(args, redirectStdin: false);
    string? line;
    var lastEmit = 0L;
    while ((line = p.StandardOutput.ReadLine()) != null)
    {
      if (line.StartsWith("frame=") && long.TryParse(line.AsSpan(6), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n))
      {
        frames = n;
        if (clock.ElapsedMilliseconds - lastEmit >= 500) { lastEmit = clock.ElapsedMilliseconds; EmitProgress(); }
      }
    }
    p.WaitForExit();
    return p.ExitCode;
  }

  int RunWithVsr(VsrVendor vendor)
  {
    int decW = o.Int("dec-width", 0), decH = o.Int("dec-height", 0), outW = o.Int("width", 0), outH = o.Int("height", 0);
    int fpsNum = o.Int("fps-num", 30), fpsDen = o.Int("fps-den", 1);
    if (decW <= 0 || decH <= 0 || outW <= 0 || outH <= 0) throw new ArgumentException("--dec-width/--dec-height/--width/--height are required for super resolution.");

    using var adapter = VideoProcessor.FindAdapter(vendor == VsrVendor.Intel ? VideoProcessor.VendorIntel : VideoProcessor.VendorNvidia)
      ?? throw new GpuException("No matching GPU for super resolution.");
    using var vp = new VideoProcessor(adapter, decW, decH, outW, outH, fpsNum, fpsDen);
    if (!vp.SetSuperResolution(vendor, true)) throw new GpuException("The driver rejected super resolution.");

    var dec = new List<string> { "-hide_banner", "-nostdin", "-loglevel", "error" };
    AddHwInit(dec);
    AddInputWindow(dec);
    dec.AddRange(new[] { "-map", "0:v:0" });
    var pre = o.Str("pre");
    dec.AddRange(new[] { "-vf", (pre != null ? pre + "," : "") + $"scale={decW}:{decH},format=nv12" });
    // Constant frame rate matching the encoder's -framerate, so variable-rate sources stay in sync with the audio.
    dec.AddRange(new[] { "-fps_mode", "cfr", "-r", $"{fpsNum}/{fpsDen}", "-f", "rawvideo", "-pix_fmt", "nv12", "pipe:1" });

    var enc = new List<string> { "-hide_banner", "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "nv12", "-s", $"{outW}x{outH}", "-framerate", $"{fpsNum}/{fpsDen}", "-i", "pipe:0" };
    bool audio = (o.Str("audio") ?? "copy") != "none";
    if (audio) AddInputWindow(enc);
    enc.AddRange(new[] { "-map", "0:v:0" });
    if (audio) AddAudio(enc, 1); else enc.Add("-an");
    var post = o.Str("post");
    if (post != null) enc.AddRange(new[] { "-vf", post });
    AddEncoder(enc);
    enc.Add(partPath);

    var decoder = Start(dec, redirectStdin: false);
    var encoder = Start(enc, redirectStdin: true);
    var src = decoder.StandardOutput.BaseStream;
    var sink = encoder.StandardInput.BaseStream;
    var inBuf = new byte[vp.InFrameBytes];
    var outBuf = new byte[vp.OutFrameBytes];
    var lastEmit = 0L;
    while (!cancelled && ReadFull(src, inBuf))
    {
      running.Wait();
      if (cancelled) break;
      vp.Process(inBuf, outBuf);
      sink.Write(outBuf, 0, outBuf.Length);
      frames++;
      if (clock.ElapsedMilliseconds - lastEmit >= 500) { lastEmit = clock.ElapsedMilliseconds; EmitProgress(); }
    }
    if (cancelled) return 0;
    sink.Flush();
    sink.Close();
    decoder.WaitForExit();
    encoder.WaitForExit();
    if (decoder.ExitCode != 0) return decoder.ExitCode;
    return encoder.ExitCode;
  }

  // ---- ffmpeg argument pieces -------------------------------------------------------------------------

  /// <summary>--vulkan 1: GPU filters (nlmeans_vulkan, libplacebo) need a Vulkan device in that FFmpeg.</summary>
  void AddHwInit(List<string> args)
  {
    if (o.Str("vulkan") == "1") args.AddRange(new[] { "-init_hw_device", "vulkan=vk", "-filter_hw_device", "vk" });
  }

  void AddInputWindow(List<string> args)
  {
    var start = o.Str("start");
    if (start != null) args.AddRange(new[] { "-ss", start });
    args.AddRange(new[] { "-i", input });
    var duration = o.Str("duration");
    if (duration != null) args.AddRange(new[] { "-t", duration });
  }

  void AddAudio(List<string> args, int inputIndex)
  {
    if ((o.Str("audio") ?? "copy") == "none") { args.Add("-an"); return; }
    args.AddRange(new[] { "-map", $"{inputIndex}:a?", "-c:a", "copy" });
  }

  void AddEncoder(List<string> args)
  {
    args.AddRange(new[] { "-c:v", o.Str("vcodec") ?? "libx264" });
    var extra = o.Str("vargs");
    if (extra != null) args.AddRange(extra.Split(' ', StringSplitOptions.RemoveEmptyEntries));
    args.AddRange(new[] { "-movflags", "+faststart" });
  }

  // ---- processes ----------------------------------------------------------------------------------------

  Process Start(List<string> args, bool redirectStdin)
  {
    var psi = new ProcessStartInfo(ffmpeg)
    {
      UseShellExecute = false,
      CreateNoWindow = true,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
      RedirectStandardInput = redirectStdin,
      StandardErrorEncoding = Encoding.UTF8,
      StandardOutputEncoding = Encoding.UTF8
    };
    foreach (var a in args) psi.ArgumentList.Add(a);
    var p = Process.Start(psi) ?? throw new InvalidOperationException("Could not start FFmpeg.");
    job.Add(p);
    try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
    var tail = new StringBuilder();
    stderrTails[p] = tail;
    p.ErrorDataReceived += (_, e) => { if (e.Data == null) return; lock (tail) { tail.AppendLine(e.Data); if (tail.Length > 4000) tail.Remove(0, tail.Length - 4000); } };
    p.BeginErrorReadLine();
    children.Add(p);
    return p;
  }

  void KillChildren()
  {
    foreach (var p in children)
    {
      try { if (!p.HasExited) { Suspend.Resume(p); p.Kill(entireProcessTree: true); p.WaitForExit(3000); } } catch { }
    }
  }

  static bool ReadFull(Stream s, byte[] buf)
  {
    int off = 0;
    while (off < buf.Length)
    {
      int n = s.Read(buf, off, buf.Length - off);
      if (n <= 0) return false;
      off += n;
    }
    return true;
  }

  static void TryDelete(string path)
  {
    for (int i = 0; i < 10; i++)
    {
      try { if (File.Exists(path)) File.Delete(path); return; } catch { Thread.Sleep(200); }
    }
  }

  void EmitProgress()
  {
    var secs = clock.Elapsed.TotalSeconds;
    Out.Emit(("type", "progress"), ("frame", frames), ("total", totalFrames), ("fps", secs > 0 ? frames / secs : 0));
  }

  // ---- control channel (stdin) --------------------------------------------------------------------------

  void ReadCommands()
  {
    string? line;
    try
    {
      while ((line = Console.In.ReadLine()) != null)
      {
        switch (line.Trim().ToLowerInvariant())
        {
          case "pause":
            running.Reset();
            foreach (var p in children) Suspend.Pause(p);
            Out.Emit(("type", "paused"), ("frame", frames));
            break;
          case "resume":
            foreach (var p in children) Suspend.Resume(p);
            running.Set();
            Out.Emit(("type", "resumed"), ("frame", frames));
            break;
          case "cancel":
            Cancel();
            return;
        }
      }
    }
    catch { }
    // The app went away without saying cancel: stop instead of running orphaned.
    Cancel();
  }

  void Cancel()
  {
    if (cancelled) return;
    cancelled = true;
    running.Set();
    KillChildren();
  }
}

static class Suspend
{
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr handle);

  public static void Pause(Process p) { try { if (!p.HasExited) NtSuspendProcess(p.Handle); } catch { } }
  public static void Resume(Process p) { try { if (!p.HasExited) NtResumeProcess(p.Handle); } catch { } }
}

/// <summary>Job object with KILL_ON_JOB_CLOSE: children die with this helper even if it is killed.</summary>
sealed class ChildJob
{
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimit
  {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong Read, Write, Other, ReadBytes, WriteBytes, OtherBytes; }

  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimit
  {
    public BasicLimit Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string? name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, uint length);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  readonly IntPtr handle;

  public ChildJob()
  {
    handle = CreateJobObject(IntPtr.Zero, null);
    var info = new ExtendedLimit { Basic = new BasicLimit { LimitFlags = 0x2000 } };
    SetInformationJobObject(handle, 9, ref info, (uint)Marshal.SizeOf<ExtendedLimit>());
  }

  public void Add(Process p)
  {
    if (handle != IntPtr.Zero) AssignProcessToJobObject(handle, p.Handle);
  }
}
