// Runs the "Nâng cấp video" work through visubly-upscaler (one video at a time):
//   start()    the real job: progress / ETA, pause / resume / cancel, safety pauses (GPU too hot,
//              output drive nearly full), automatic switch to the FFmpeg plan if the GPU path fails,
//              and copies the video's subtitle files next to the new video.
//   compare()  "Thử & so sánh": a short window through several plans + before/after still frames.
"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const SUBTITLE_EXTS = [".srt", ".vtt", ".ass", ".ssa"];
const HOT_C = 85;
const COOL_C = 75;
const MIN_FREE_BYTES = 5 * 1024 ** 3;

function parseRate(rate) {
  const [n, d] = String(rate || "").split("/").map(Number);
  if (!n || !d) return null;
  return { num: n, den: d, fps: n / d };
}

/** "<dir>/<base>_<target>.mp4", adding " (2)", " (3)"… if that name is taken. */
function uniqueOutputPath(dir, base, target) {
  const clean = String(base).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "video";
  let candidate = path.join(dir, `${clean}_${target}.mp4`);
  for (let i = 2; fs.existsSync(candidate) || fs.existsSync(candidate.replace(/\.mp4$/, ".part.mp4")); i += 1) {
    candidate = path.join(dir, `${clean}_${target} (${i}).mp4`);
  }
  return candidate;
}

/** Subtitle files that belong to a video: "name.srt", "name.vi.srt", "name.en.ass"… */
function siblingSubtitles(videoPath) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries
    .filter((name) => SUBTITLE_EXTS.includes(path.extname(name).toLowerCase()))
    .filter((name) => {
      const stem = name.slice(0, -path.extname(name).length).toLowerCase();
      return stem === base || (stem.startsWith(base + ".") && stem.length - base.length <= 12);
    })
    .map((name) => path.join(dir, name));
}

function copySubtitles(videoPath, outputPath) {
  const srcBase = path.basename(videoPath, path.extname(videoPath));
  const outBase = path.basename(outputPath, path.extname(outputPath));
  const copied = [];
  for (const file of siblingSubtitles(videoPath)) {
    const suffix = path.basename(file).slice(srcBase.length); // ".vi.srt"
    const target = path.join(path.dirname(outputPath), outBase + suffix);
    try {
      if (!fs.existsSync(target)) { fs.copyFileSync(file, target); copied.push(target); }
    } catch {}
  }
  return copied;
}

function helperArgs({ input, output, ffmpegPath, plan, video, start, duration, audio }) {
  const rate = video.rate || { num: Math.round((video.fps || 30) * 1000), den: 1000 };
  const window = duration != null ? duration : video.duration || 0;
  const args = ["run", "--input", input, "--output", output, "--ffmpeg", ffmpegPath, "--mode", plan.mode,
    "--vcodec", plan.encoder.vcodec, "--vargs", plan.encoder.vargs,
    "--fps-num", String(rate.num), "--fps-den", String(rate.den),
    "--total-frames", String(Math.max(1, Math.round(window * (rate.num / rate.den))))];
  if (plan.pre) args.push("--pre", plan.pre);
  if (plan.post) args.push("--post", plan.post);
  if (plan.mode !== "ffmpeg") args.push("--dec-width", String(plan.decWidth), "--dec-height", String(plan.decHeight), "--width", String(plan.width), "--height", String(plan.height));
  if (plan.vulkan) args.push("--vulkan", "1");
  if (start != null) args.push("--start", String(start));
  if (duration != null) args.push("--duration", String(duration));
  if (audio === false || !video.hasAudio) args.push("--audio", "none");
  return args;
}

function runHelper(exe, args, onEvent) {
  const child = spawn(exe, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let lastError = null;
  child.stdout.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "error") lastError = event;
      try { onEvent(event); } catch {}
    }
  });
  child.stderr.on("data", () => {});
  const done = new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: -1, lastError: { kind: "fatal", message: error.message } }));
    child.on("close", (code) => resolve({ code, lastError }));
  });
  return { child, done, send: (cmd) => { try { child.stdin.write(cmd + "\n"); } catch {} } };
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args], { windowsHide: true, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

class UpscaleJob extends EventEmitter {
  constructor({ upscalerPath, ffmpegPath, ffprobePath, tempRoot }) {
    super();
    this.o = { upscalerPath, ffmpegPath, ffprobePath, tempRoot };
    this.state = { status: "idle" };
    this.run = null;
    this.samples = [];
    this.compareRun = null;
    this.compareCancelled = false;
  }

  isActive() {
    return ["starting", "running", "paused"].includes(this.state.status);
  }

  isComparing() {
    return Boolean(this.compareRun);
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("update", this.state);
  }

  async probeVideo(file) {
    const { ffprobePath } = this.o;
    const stat = fs.statSync(file);
    const base = { path: file, name: path.basename(file), sizeBytes: stat.size };
    if (!ffprobePath) return { ...base, width: 0, height: 0, fps: 30, duration: 0, hasAudio: true, error: "ffprobe-missing" };
    const json = await new Promise((resolve) => {
      let out = "";
      const child = spawn(ffprobePath, ["-v", "error", "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:stream_disposition=attached_pic",
        "-of", "json", file], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.on("data", (d) => (out += d));
      child.on("error", () => resolve(null));
      child.on("close", () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    });
    if (!json) return { ...base, width: 0, height: 0, fps: 30, duration: 0, hasAudio: false, error: "unreadable" };
    const streams = json.streams || [];
    const v = streams.find((s) => s.codec_type === "video" && !(s.disposition && s.disposition.attached_pic));
    const avg = parseRate(v && v.avg_frame_rate);
    const raw = parseRate(v && v.r_frame_rate);
    const rate = avg && avg.fps > 1 && avg.fps <= 120 ? avg : raw && raw.fps > 1 && raw.fps <= 120 ? raw : { num: 30, den: 1, fps: 30 };
    return {
      ...base,
      width: (v && v.width) || 0,
      height: (v && v.height) || 0,
      videoCodec: (v && v.codec_name) || "",
      fps: Math.round(rate.fps * 1000) / 1000,
      rate: { num: rate.num, den: rate.den },
      duration: Number(json.format && json.format.duration) || 0,
      hasAudio: streams.some((s) => s.codec_type === "audio"),
      error: v ? null : "no-video"
    };
  }

  /** Starts the job. fallbackPlan (FFmpeg only) is used once if the first plan fails. */
  start({ input, output, video, plan, fallbackPlan, label }) {
    if (this.isActive()) throw new Error("Đang có một video được nâng cấp.");
    if (!this.o.upscalerPath) throw new Error("Thiếu bộ xử lý nâng cấp (visubly-upscaler).");
    this.samples = [];
    this.update({
      status: "starting", input, output, name: path.basename(input), label: label || plan.label, plan, video,
      frame: 0, total: Math.max(1, Math.round((video.duration || 0) * (video.fps || 30))), percent: 0,
      fps: 0, etaSec: null, startedAt: Date.now(), pausedReason: null, notice: null, error: null, subtitles: []
    });
    this.launch(plan, fallbackPlan);
    return this.state;
  }

  launch(plan, fallbackPlan) {
    const { input, output, video } = this.state;
    const args = helperArgs({ input, output, ffmpegPath: this.o.ffmpegPath, plan, video });
    const run = runHelper(this.o.upscalerPath, args, (e) => this.onEvent(e));
    this.run = run;
    run.done.then(({ code, lastError }) => {
      if (this.run !== run) return;
      this.run = null;
      if (code === 0 && fs.existsSync(output)) {
        const subtitles = copySubtitles(input, output);
        let sizeBytes = 0;
        try { sizeBytes = fs.statSync(output).size; } catch {}
        this.update({ status: "done", percent: 100, frame: this.state.total, etaSec: 0, finishedAt: Date.now(), sizeBytes, subtitles, pausedReason: null });
        return;
      }
      if (this.state.status === "cancelling" || code === 3) {
        this.update({ status: "cancelled", pausedReason: null });
        return;
      }
      if (fallbackPlan && plan !== fallbackPlan) {
        const why = lastError && lastError.kind === "gpu" ? "Card đồ hoạ gặp lỗi" : "Cách xử lý đã chọn gặp lỗi";
        this.samples = [];
        this.update({ status: "starting", plan: fallbackPlan, label: fallbackPlan.label, frame: 0, percent: 0, etaSec: null,
          notice: `${why}, ViSUBLY đã chuyển sang bộ lọc FFmpeg và chạy lại từ đầu.` });
        this.launch(fallbackPlan, null);
        return;
      }
      this.update({ status: "error", error: (lastError && lastError.message) || `Bộ xử lý dừng với mã ${code}.`, errorDetail: lastError && lastError.detail, pausedReason: null });
    });
  }

  onEvent(e) {
    if (e.type === "started") this.update({ status: this.state.status === "paused" ? "paused" : "running" });
    else if (e.type === "progress") {
      const now = Date.now();
      this.samples.push([now, e.frame]);
      while (this.samples.length > 2 && now - this.samples[0][0] > 15000) this.samples.shift();
      const [t0, f0] = this.samples[0];
      const fps = now > t0 && e.frame > f0 ? ((e.frame - f0) * 1000) / (now - t0) : e.fps || 0;
      const total = e.total || this.state.total;
      this.update({
        status: this.state.status === "paused" ? "paused" : "running",
        frame: e.frame, total, percent: Math.min(99.9, (e.frame / total) * 100),
        fps: Math.round(fps * 10) / 10, etaSec: fps > 0 ? Math.round((total - e.frame) / fps) : null
      });
    } else if (e.type === "paused") this.update({ status: "paused" });
    else if (e.type === "resumed") { this.samples = []; this.update({ status: "running", pausedReason: null }); }
  }

  pause(reason = "user") {
    if (!this.run || this.state.status !== "running") return this.state;
    this.run.send("pause");
    this.update({ status: "paused", pausedReason: reason });
    return this.state;
  }

  resume() {
    if (!this.run || this.state.status !== "paused") return this.state;
    this.run.send("resume");
    this.samples = [];
    this.update({ status: "running", pausedReason: null });
    return this.state;
  }

  cancel() {
    if (!this.run) return Promise.resolve(this.state);
    const run = this.run;
    this.update({ status: "cancelling" });
    run.send("cancel");
    const timer = setTimeout(() => { try { run.child.kill(); } catch {} }, 5000);
    return run.done.then(() => { clearTimeout(timer); return this.state; });
  }

  /** Called with live device stats: pause when the GPU is too hot or the output drive is nearly full. */
  checkSafety(stats) {
    if (!this.isActive() || !stats) return;
    const temp = stats.gpu && stats.gpu.tempC;
    if (this.state.status === "running" && Number.isFinite(temp) && temp >= HOT_C) {
      this.pause("hot");
      this.update({ notice: `Card đồ hoạ lên ${temp}°C nên ViSUBLY tạm dừng để máy nguội. Sẽ tự chạy tiếp khi dưới ${COOL_C}°C.` });
      return;
    }
    if (this.state.status === "paused" && this.state.pausedReason === "hot" && Number.isFinite(temp) && temp <= COOL_C) {
      this.resume();
      this.update({ notice: "Máy đã nguội, tiếp tục nâng cấp." });
      return;
    }
    const root = path.parse(path.resolve(this.state.output || ".")).root.replace(/\\$/, "").toUpperCase();
    const disk = (stats.disks || []).find((d) => d.root.toUpperCase() === root);
    if (this.state.status === "running" && disk && disk.free < MIN_FREE_BYTES) {
      this.pause("disk");
      this.update({ notice: `Ổ ${disk.root} sắp hết chỗ trống nên ViSUBLY tạm dừng. Dọn bớt rồi bấm Tiếp tục.` });
    }
  }

  // ---- Thử & so sánh -------------------------------------------------------------------------------

  /**
   * variants: [{ key, label, plan }]; runs each over [start, start+seconds) without audio, then extracts
   * three still frames per variant and the matching "before" frames (source scaled plainly to the same size).
   */
  async compare({ input, video, start, seconds, variants }, onProgress = () => {}) {
    if (this.isActive()) throw new Error("Đang nâng cấp một video, thử lại sau khi xong.");
    if (this.compareRun) throw new Error("Đang thử một đoạn khác.");
    this.compareCancelled = false;
    const dir = fs.mkdtempSync(path.join(this.o.tempRoot, "compare-"));
    const results = [];
    try {
      for (let i = 0; i < variants.length; i += 1) {
        if (this.compareCancelled) break;
        const v = variants[i];
        onProgress({ step: i + 1, steps: variants.length, label: v.label, phase: "process" });
        const out = path.join(dir, `${v.key}.mp4`);
        const started = Date.now();
        const run = runHelper(this.o.upscalerPath, helperArgs({ input, output: out, ffmpegPath: this.o.ffmpegPath, plan: v.plan, video, start, duration: seconds, audio: false }), () => {});
        this.compareRun = run;
        const { code, lastError } = await run.done;
        this.compareRun = null;
        const secs = (Date.now() - started) / 1000;
        const frames = Math.round(seconds * (video.fps || 30));
        results.push({ key: v.key, label: v.label, ok: code === 0 && fs.existsSync(out), file: out,
          fps: secs > 0 ? Math.round(frames / secs) : 0, seconds: Math.round(secs * 10) / 10,
          error: code === 0 ? null : (lastError && lastError.message) || `code ${code}` });
      }
      if (this.compareCancelled) throw new Error("cancelled");
      onProgress({ step: variants.length, steps: variants.length, phase: "frames" });
      const first = variants[0].plan;
      const times = [0.2, 0.5, 0.8].map((f) => Math.round(seconds * f * 10) / 10);
      const frames = [];
      for (let i = 0; i < times.length; i += 1) {
        const t = times[i];
        const before = path.join(dir, `before-${i}.png`);
        await runFfmpeg(this.o.ffmpegPath, ["-ss", String(start + t), "-i", input, "-frames:v", "1", "-vf", `scale=${first.width}:${first.height}:flags=bilinear`, before]);
        const after = {};
        for (const r of results) {
          if (!r.ok) continue;
          const png = path.join(dir, `after-${r.key}-${i}.png`);
          if (await runFfmpeg(this.o.ffmpegPath, ["-ss", String(t), "-i", r.file, "-frames:v", "1", png])) after[r.key] = png;
        }
        frames.push({ time: start + t, before: fs.existsSync(before) ? before : null, after });
      }
      return { dir, start, seconds, frames, results };
    } catch (error) {
      if (this.compareCancelled) { this.cleanupCompare(dir); return { cancelled: true }; }
      throw error;
    }
  }

  cancelCompare() {
    this.compareCancelled = true;
    if (this.compareRun) this.compareRun.send("cancel");
  }

  cleanupCompare(dir) {
    if (!dir || !this.o.tempRoot || !path.resolve(dir).startsWith(path.resolve(this.o.tempRoot))) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  /** App is quitting: stop everything right away. */
  kill() {
    this.cancelCompare();
    if (this.run) { try { this.run.send("cancel"); this.run.child.kill(); } catch {} }
  }
}

module.exports = { UpscaleJob, uniqueOutputPath, siblingSubtitles, copySubtitles, helperArgs, parseRate };
