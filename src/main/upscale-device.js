// Device side of the "Nâng cấp video" tab:
//   probe()  one-time capability check + quick benchmark, cached per GPU driver / app version:
//            adapters + driver super resolution (visubly-upscaler probe), hardware encoders, Vulkan,
//            super resolution speed (upscaler bench) and FFmpeg filter speed.
//   stats    live readings while the tab is open: GPU load / memory / temperature / power (nvidia-smi),
//            CPU %, RAM, free space per drive, battery.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROBE_VERSION = 3;

function runJsonLines(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => { if (!done) { try { child.kill(); } catch {} } }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => { done = true; clearTimeout(timer); resolve([]); });
    child.on("close", () => {
      done = true;
      clearTimeout(timer);
      resolve(out.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
    });
  });
}

function runQuiet(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(exe, args, { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve({ ok: false, ms: Date.now() - started }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, ms: Date.now() - started }); });
  });
}

class DeviceMonitor {
  /**
   * @param {object} o
   * @param {string} o.ffmpegPath
   * @param {string} o.upscalerPath
   * @param {string} o.cachePath  JSON cache file (userData)
   * @param {() => {gpu?: string, driver?: string}} o.gpuSummary  from app.getGPUInfo (video-enhance)
   * @param {() => boolean} o.onBattery  Electron powerMonitor.isOnBatteryPower
   * @param {string} o.appVersion
   */
  constructor(o) {
    this.o = o;
    this.device = null;
    this.probing = null;
    this.statsTimer = null;
    this.smi = null;
    this.latest = { gpu: null, cpu: null, ram: null, disks: [], battery: null };
    this.cpuSample = os.cpus();
    this.listeners = new Set();
    this.diskTick = 0;
  }

  cacheKey(summary) {
    return [PROBE_VERSION, this.o.appVersion, summary.gpu || "", summary.driver || "", this.o.upscalerPath ? "u" : "-"].join("|");
  }

  /** Capability check + benchmark. Uses the cache unless force or the GPU / driver / app changed. */
  probe(force = false) {
    if (this.probing) return this.probing;
    const summary = this.o.gpuSummary() || {};
    const key = this.cacheKey(summary);
    if (!force) {
      try {
        const cached = JSON.parse(fs.readFileSync(this.o.cachePath, "utf8"));
        if (cached && cached.key === key && Date.now() - cached.at < 30 * 24 * 3600 * 1000) {
          this.device = cached.device;
          return Promise.resolve(this.device);
        }
      } catch {}
    }
    this.probing = this.runProbe(summary)
      .then((device) => {
        this.device = device;
        try { fs.writeFileSync(this.o.cachePath, JSON.stringify({ key, at: Date.now(), device }, null, 2)); } catch {}
        return device;
      })
      .finally(() => { this.probing = null; });
    return this.probing;
  }

  async runProbe(summary) {
    const { ffmpegPath, upscalerPath } = this.o;
    const cpus = os.cpus();
    const device = {
      gpu: summary.gpu || "", driver: summary.driver || "",
      adapters: [], vsr: [], encoders: {}, vulkan: false, modernFfmpeg: false, bench: {},
      cpu: { model: (cpus[0] && cpus[0].model || "").trim(), threads: cpus.length },
      ramMb: Math.round(os.totalmem() / 1048576),
      helper: Boolean(upscalerPath), probedAt: new Date().toISOString()
    };

    if (upscalerPath) {
      const probe = (await runJsonLines(upscalerPath, ["probe"], 20000)).find((e) => e.type === "probe");
      if (probe) { device.adapters = probe.adapters || []; device.vsr = probe.vsr || []; }
    }
    if (!device.adapters.length && device.gpu) {
      const vendor = /nvidia/i.test(device.gpu) ? "nvidia" : /intel/i.test(device.gpu) ? "intel" : /amd|radeon/i.test(device.gpu) ? "amd" : "other";
      device.adapters = [{ name: device.gpu, vendor, vramMb: 0 }];
    }

    if (ffmpegPath) {
      device.modernFfmpeg = /[\\/](vendor|resources)[\\/]ffmpeg[\\/]/i.test(ffmpegPath);
      const tiny = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=256x144:d=0.2", "-frames:v", "2"];
      const encoders = ["hevc_nvenc", "hevc_amf", "hevc_qsv"];
      const encoderResults = await Promise.all(encoders.map((enc) => runQuiet(ffmpegPath, [...tiny, "-c:v", enc, "-f", "null", "-"], 15000)));
      encoders.forEach((enc, i) => { device.encoders[enc] = encoderResults[i].ok; });
      if (device.modernFfmpeg) {
        // Same filters and a real frame size as the plans use (tiny frames passed where 480p failed).
        device.vulkan = (await runQuiet(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-init_hw_device", "vulkan=vk", "-filter_hw_device", "vk",
          "-f", "lavfi", "-i", "testsrc2=s=854x480:r=30:d=0.3", "-frames:v", "6", "-vf",
          "format=yuv420p,hwupload,libplacebo=w=1920:h=1080:upscaler=ewa_lanczossharp:format=yuv420p,hwdownload,format=yuv420p",
          "-f", "null", "-"], 20000)).ok;
      }
    }

    // Quick benchmark (about 3 s): super resolution speed + FFmpeg filter/encode speed.
    if (upscalerPath && device.vsr.some((v) => v.effective)) {
      const bench = (await runJsonLines(upscalerPath, ["bench", "--seconds", "1.5"], 20000)).find((e) => e.type === "bench");
      const best = bench && (bench.results || []).filter((r) => r.accepted && r.fps).sort((a, b) => b.fps - a.fps)[0];
      if (best) device.bench.vsrFps = Math.round(best.fps);
    }
    if (ffmpegPath) {
      const enc = device.encoders.hevc_nvenc ? "hevc_nvenc" : device.encoders.hevc_amf ? "hevc_amf" : device.encoders.hevc_qsv ? "hevc_qsv" : "libx264";
      const frames = 90;
      const r = await runQuiet(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=s=854x480:r=30:d=${frames / 30}`,
        "-vf", "hqdn3d=1.5:1.5:6:6,scale=1920:1080:flags=lanczos,cas=0.5", "-c:v", enc, ...(enc === "libx264" ? ["-preset", "faster"] : []), "-f", "null", "-"], 60000);
      if (r.ok && r.ms > 0) device.bench.ffmpegFps = Math.round((frames * 1000) / r.ms);
    }
    return device;
  }

  // ---- live stats ------------------------------------------------------------------------------------

  subscribe(listener) {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.startStats();
    listener(this.latest);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stopStats();
    };
  }

  emit() {
    for (const l of this.listeners) { try { l(this.latest); } catch {} }
  }

  startStats() {
    this.cpuSample = os.cpus();
    this.sampleSlow(true);
    this.statsTimer = setInterval(() => { this.sampleFast(); this.emit(); }, 1000);
    this.startSmi();
  }

  stopStats() {
    clearInterval(this.statsTimer);
    this.statsTimer = null;
    if (this.smi) { try { this.smi.kill(); } catch {} this.smi = null; }
  }

  startSmi() {
    const hasNvidia = !this.device || (this.device.adapters || []).some((a) => a.vendor === "nvidia");
    if (!hasNvidia || process.platform !== "win32") return;
    let buffer = "";
    try {
      this.smi = spawn("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
        "--format=csv,noheader,nounits", "-lms", "1000"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      this.smi = null;
      return;
    }
    this.smi.on("error", () => { this.smi = null; });
    this.smi.stdout.on("data", (d) => {
      buffer += d;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      const last = lines.filter(Boolean).pop();
      if (!last) return;
      const [util, memUsed, memTotal, temp, power, powerLimit] = last.split(",").map((v) => Number(String(v).trim()));
      this.latest.gpu = {
        util: Number.isFinite(util) ? util : null,
        memUsedMb: Number.isFinite(memUsed) ? memUsed : null,
        memTotalMb: Number.isFinite(memTotal) ? memTotal : null,
        tempC: Number.isFinite(temp) ? temp : null,
        powerW: Number.isFinite(power) ? Math.round(power) : null,
        powerLimitW: Number.isFinite(powerLimit) ? Math.round(powerLimit) : null
      };
    });
  }

  sampleFast() {
    const now = os.cpus();
    let idle = 0, total = 0;
    now.forEach((c, i) => {
      const before = this.cpuSample[i] ? this.cpuSample[i].times : { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
      const t = c.times;
      const sum = (x) => x.user + x.nice + x.sys + x.idle + x.irq;
      total += sum(t) - sum(before);
      idle += t.idle - before.idle;
    });
    this.cpuSample = now;
    this.latest.cpu = { percent: total > 0 ? Math.round((1 - idle / total) * 100) : 0, threads: now.length };
    this.latest.ram = { usedMb: Math.round((os.totalmem() - os.freemem()) / 1048576), totalMb: Math.round(os.totalmem() / 1048576) };
    this.diskTick += 1;
    if (this.diskTick % 5 === 0) this.sampleSlow(this.diskTick % 60 === 0);
  }

  sampleSlow(withBattery) {
    const disks = [];
    if (process.platform === "win32") {
      for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
        const root = `${letter}:\\`;
        try {
          const s = fs.statfsSync(root);
          const total = Number(s.blocks) * Number(s.bsize);
          if (total > 0) disks.push({ root: `${letter}:`, free: Number(s.bavail) * Number(s.bsize), total });
        } catch {}
      }
    }
    this.latest.disks = disks;
    const onBattery = Boolean(this.o.onBattery && this.o.onBattery());
    if (withBattery || !this.latest.battery) this.readBattery(onBattery);
    else this.latest.battery = this.latest.battery && { ...this.latest.battery, onBattery };
  }

  readBattery(onBattery) {
    if (process.platform !== "win32") return;
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "$b = Get-CimInstance Win32_Battery | Select-Object -First 1; if ($b) { $b.EstimatedChargeRemaining }"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => {});
    child.on("close", () => {
      const pct = Number(String(out).trim());
      this.latest.battery = Number.isFinite(pct) && String(out).trim() !== "" ? { percent: pct, onBattery } : null;
    });
  }

  /** Free bytes on the drive that holds dir (walks up to an existing folder). */
  static freeBytesFor(dir) {
    let d = dir;
    while (d && !fs.existsSync(d)) {
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    try {
      const s = fs.statfsSync(d);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return 0;
    }
  }
}

module.exports = { DeviceMonitor };
