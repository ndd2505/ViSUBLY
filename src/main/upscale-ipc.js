// Wires the "Nâng cấp video" tab into the app: IPC, the close confirmation while a video is being
// upscaled, keep-awake + taskbar progress during a job, and safety checks even when the tab is closed.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const presets = require("./upscale-presets");
const { DeviceMonitor } = require("./upscale-device");
const { UpscaleJob, uniqueOutputPath } = require("./upscale-job");

function setupUpscale(ctx) {
  const { ipcMain, dialog, shell, screen, powerMonitor, powerSaveBlocker, Notification, app } = ctx;
  const tempRoot = path.join(ctx.tempDir, "upscale");
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(tempRoot, { recursive: true });

  const monitor = new DeviceMonitor({
    ffmpegPath: ctx.ffmpegPath,
    upscalerPath: ctx.upscalerPath,
    cachePath: path.join(ctx.userDataDir, "upscale-device.json"),
    gpuSummary: ctx.gpuSummary,
    onBattery: () => { try { return powerMonitor.isOnBatteryPower(); } catch { return false; } },
    appVersion: app.getVersion()
  });
  const job = new UpscaleJob({ upscalerPath: ctx.upscalerPath, ffmpegPath: ctx.ffmpegPath, ffprobePath: ctx.ffprobePath, tempRoot });

  let device = null;
  let deviceStatus = "idle";
  let deviceError = null;
  let video = null;
  let compareDir = null;
  let rendererStats = null;
  let safetyStats = null;
  let blockerId = null;
  let closeConfirmed = false;
  let lastStats = null;

  const send = (channel, payload) => ctx.sendToRenderer(channel, payload);
  const win = () => ctx.getMainWindow();

  function screenHeight() {
    try {
      const d = screen.getPrimaryDisplay();
      return Math.round(d.size.height * (d.scaleFactor || 1));
    } catch {
      return 1080;
    }
  }

  function outputDirFor(file) {
    const dir = path.dirname(file);
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      return ctx.getDownloadDir() || dir;
    }
  }

  function planningDevice() {
    const dir = video ? outputDirFor(video.path) : "";
    return {
      ...(device || { adapters: [], vsr: [], encoders: {}, bench: {} }),
      screenHeight: screenHeight(),
      onBattery: Boolean(lastStats && lastStats.battery && lastStats.battery.onBattery),
      outputFreeBytes: dir ? DeviceMonitor.freeBytesFor(dir) : 0
    };
  }

  function publicState() {
    return {
      helper: Boolean(ctx.upscalerPath), ffmpeg: Boolean(ctx.ffmpegPath),
      deviceStatus, deviceError, device, video, job: job.state, stats: lastStats
    };
  }

  async function ensureDevice(force = false) {
    if (deviceStatus === "probing") return monitor.probe(false);
    deviceStatus = "probing";
    send("upscale:device", { status: deviceStatus, device });
    // The GPU name / driver come from app.getGPUInfo, which finishes shortly after startup; they key the cache.
    for (let i = 0; i < 30 && !(ctx.gpuSummary() || {}).gpu; i += 1) await new Promise((r) => setTimeout(r, 200));
    try {
      device = await monitor.probe(force);
      deviceStatus = "ready";
      deviceError = null;
    } catch (error) {
      deviceStatus = "error";
      deviceError = error.message;
    }
    send("upscale:device", { status: deviceStatus, device, error: deviceError });
    return device;
  }

  function thumbnailFor(info) {
    return new Promise((resolve) => {
      if (!ctx.ffmpegPath || !info.duration) return resolve(null);
      const out = path.join(tempRoot, `thumb-${Date.now()}.jpg`);
      const child = spawn(ctx.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(Math.min(info.duration * 0.1, 60)),
        "-i", info.path, "-frames:v", "1", "-vf", "scale=256:-2", out], { windowsHide: true, stdio: "ignore" });
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code === 0 && fs.existsSync(out) ? pathToFileURL(out).href : null));
    });
  }

  async function setVideo(file) {
    if (!file || !fs.existsSync(file)) return { ok: false, error: "Không tìm thấy file video." };
    if (job.isActive()) return { ok: false, error: "Đang nâng cấp một video. Chờ xong hoặc hủy rồi chọn video khác." };
    const info = await job.probeVideo(file);
    if (info.error === "no-video" || info.error === "unreadable" || !info.width) return { ok: false, error: "Không đọc được hình của file này. Hãy chọn một file video khác." };
    info.thumbnail = await thumbnailFor(info);
    info.outputDir = outputDirFor(file);
    video = info;
    return { ok: true, video };
  }

  function choicePlan(choice) {
    return presets.plan(planningDevice(), video, choice || {});
  }

  function fallbackPlanFor(choice, plan) {
    if (plan.mode === "ffmpeg" && !plan.vulkan) return null;
    const dev = { ...planningDevice(), vulkan: false, vsr: [] };
    return presets.plan(dev, video, { ...choice, preset: plan.preset, target: plan.target, engine: "ffmpeg" });
  }

  // ---- job side effects ------------------------------------------------------------------------------

  job.on("update", (state) => {
    send("upscale:job", state);
    const w = win();
    const active = job.isActive();
    if (w && !w.isDestroyed()) {
      if (state.status === "running") w.setProgressBar(Math.max(0.01, (state.percent || 0) / 100));
      else if (state.status === "paused") w.setProgressBar(Math.max(0.01, (state.percent || 0) / 100), { mode: "paused" });
      else if (state.status === "error") w.setProgressBar(1, { mode: "error" });
      else w.setProgressBar(-1);
    }
    if (active && blockerId === null) blockerId = powerSaveBlocker.start("prevent-app-suspension");
    if (!active && blockerId !== null) { try { powerSaveBlocker.stop(blockerId); } catch {} blockerId = null; }
    if (active && !safetyStats) safetyStats = monitor.subscribe((s) => { lastStats = s; job.checkSafety(s); });
    if (!active && safetyStats) { safetyStats(); safetyStats = null; }
    if (state.status === "done" && Notification.isSupported() && (!w || !w.isFocused())) {
      try { new Notification({ title: "Đã nâng cấp xong", body: `${state.name} → ${path.basename(state.output)}` }).show(); } catch {}
    }
  });

  // ---- IPC ---------------------------------------------------------------------------------------------

  ipcMain.handle("upscale:getState", () => publicState());
  ipcMain.handle("upscale:probe", async (_e, force) => { await ensureDevice(Boolean(force)); return publicState(); });
  ipcMain.handle("upscale:watchStats", (_e, on) => {
    if (on && !rendererStats) rendererStats = monitor.subscribe((s) => { lastStats = s; send("upscale:stats", s); });
    if (!on && rendererStats) { rendererStats(); rendererStats = null; }
    return true;
  });
  ipcMain.handle("upscale:selectVideo", async () => {
    const result = await dialog.showOpenDialog(win(), {
      title: "Chọn video cần nâng cấp",
      properties: ["openFile"],
      filters: [{ name: "Video", extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v", "ts", "flv", "wmv"] }, { name: "Tất cả file", extensions: ["*"] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    return setVideo(result.filePaths[0]);
  });
  ipcMain.handle("upscale:setVideo", (_e, file) => setVideo(file));
  ipcMain.handle("upscale:clearVideo", () => { if (!job.isActive()) video = null; return publicState(); });
  ipcMain.handle("upscale:describe", (_e, choice) => {
    const d = presets.describe(planningDevice(), video, choice || {});
    if (video && d.plan) {
      const dir = outputDirFor(video.path);
      d.output = { dir, file: uniqueOutputPath(dir, path.basename(video.path, path.extname(video.path)), d.plan.target), freeBytes: DeviceMonitor.freeBytesFor(dir) };
    }
    return d;
  });
  ipcMain.handle("upscale:start", (_e, choice) => {
    if (!video) return { ok: false, error: "Chưa chọn video." };
    if (job.isComparing()) return { ok: false, error: "Đang thử một đoạn, chờ xong rồi bắt đầu." };
    try {
      const plan = choicePlan(choice);
      const dir = outputDirFor(video.path);
      const output = uniqueOutputPath(dir, path.basename(video.path, path.extname(video.path)), plan.target);
      const state = job.start({ input: video.path, output, video, plan, fallbackPlan: fallbackPlanFor(choice, plan) });
      return { ok: true, state };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("upscale:pause", () => job.pause("user"));
  ipcMain.handle("upscale:resume", () => job.resume());
  ipcMain.handle("upscale:cancel", () => job.cancel());
  ipcMain.handle("upscale:dismiss", () => { if (!job.isActive()) job.update({ status: "idle", notice: null, error: null }); return job.state; });
  ipcMain.handle("upscale:reveal", (_e, file) => { if (file && fs.existsSync(file)) shell.showItemInFolder(file); return true; });

  ipcMain.handle("upscale:compare", async (_e, { choice, start, seconds } = {}) => {
    if (!video) return { ok: false, error: "Chưa chọn video." };
    const plan = choicePlan(choice);
    const caps = presets.capabilities(planningDevice());
    const variants = [{ key: "chosen", label: choice && choice.preset && choice.preset !== "auto" ? "Cấu hình đã chọn" : "Tự động (đề xuất)", plan, apply: null }];
    const fastEngine = ["rtx", "intel", "amd"].find((id) => caps.engines[id] && caps.engines[id].available);
    if (fastEngine) {
      const p = presets.plan(planningDevice(), video, { preset: "fast", engine: fastEngine, target: plan.target, size: plan.size });
      variants.push({ key: "fast", label: `Chỉ ${p.steps[0]}`, plan: p, apply: { preset: "fast", engine: fastEngine } });
    }
    variants.push({ key: "ffmpeg", label: "Bộ lọc FFmpeg", plan: presets.plan(planningDevice(), video, { preset: "balanced", engine: "ffmpeg", target: plan.target, size: plan.size }), apply: { preset: "balanced", engine: "ffmpeg" } });
    const unique = variants.filter((v, i) => variants.findIndex((x) => x.plan.label === v.plan.label && x.plan.mode === v.plan.mode) === i);
    const secs = [5, 10, 20].includes(Number(seconds)) ? Number(seconds) : 10;
    const at = Math.max(0, Math.min(Number(start) || video.duration * 0.15, Math.max(0, video.duration - secs - 1)));
    if (compareDir) { job.cleanupCompare(compareDir); compareDir = null; }
    try {
      const result = await job.compare({ input: video.path, video, start: at, seconds: secs, variants: unique }, (p) => send("upscale:compare-progress", p));
      if (result.cancelled) return { ok: false, cancelled: true };
      compareDir = result.dir;
      const url = (f) => (f ? pathToFileURL(f).href : null);
      return {
        ok: true, start: result.start, seconds: result.seconds, width: plan.width, height: plan.height,
        variants: unique.map((v) => {
          const r = result.results.find((x) => x.key === v.key) || {};
          const sizeBytes = r.ok ? (() => { try { return fs.statSync(r.file).size; } catch { return 0; } })() : 0;
          return { key: v.key, label: v.label, steps: v.plan.label, apply: v.apply, ok: Boolean(r.ok), error: r.error || null, fps: r.fps || 0,
            seconds: r.seconds || 0, wholeSeconds: r.fps ? Math.round(((video.duration * video.fps) / r.fps) * 1.05) : 0,
            wholeBytes: sizeBytes && video.duration ? Math.round((sizeBytes / secs) * video.duration) : 0 };
        }),
        frames: result.frames.map((f) => ({ time: f.time, before: url(f.before), after: Object.fromEntries(Object.entries(f.after).map(([k, v]) => [k, url(v)])) })),
        realtime: video.fps
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("upscale:compareCancel", () => { job.cancelCompare(); return true; });
  ipcMain.handle("upscale:compareClose", () => { if (compareDir) { job.cleanupCompare(compareDir); compareDir = null; } return true; });

  // ---- closing the app while a video is being upscaled --------------------------------------------------

  ipcMain.handle("app:confirmClose", async (_e, choice) => {
    if (choice !== "quit") return false;
    closeConfirmed = true;
    await job.cancel();
    const w = win();
    if (w && !w.isDestroyed()) w.close();
    return true;
  });

  return {
    attachWindow(w) {
      w.on("close", (event) => {
        if (closeConfirmed || !job.isActive()) return;
        event.preventDefault();
        send("app:close-request", { name: job.state.name, percent: Math.floor(job.state.percent || 0), etaSec: job.state.etaSec });
        if (w.isMinimized()) w.restore();
        w.focus();
      });
    },
    isBusy: () => job.isActive(),
    shutdown() {
      job.kill();
      if (rendererStats) rendererStats();
      if (safetyStats) safetyStats();
      monitor.stopStats();
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    }
  };
}

module.exports = { setupUpscale };
