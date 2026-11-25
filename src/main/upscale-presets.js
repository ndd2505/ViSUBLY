// Pure planning logic for the "Nâng cấp video" tab (no Electron, unit-tested by scripts/test-upscale-presets.js).
// Input: what the device can do (probe + quick benchmark) and the chosen video.
// Output: which choices are available (with a reason when not), the FFmpeg / super resolution pipeline,
// speed / time / size estimates, how heavy it is for this device, and the automatic choice.
"use strict";

const TARGETS = { "720p": 720, "1080p": 1080, "1440p": 1440, "4K": 2160 };
const SIZES = {
  small: { quality: 28, gbPerHour1080: 0.8 },
  balanced: { quality: 25, gbPerHour1080: 1.4 },
  high: { quality: 22, gbPerHour1080: 2.4 }
};
const PRESET_ORDER = ["best", "balanced", "fast"]; // auto tries these, best first
const PHASE2 = "Có ở bản cập nhật sau (1.3.0).";

// End-to-end speed (frames/s) measured on the reference machine (RTX 3060, 852x480 -> 1920x1080, HEVC NVENC).
// A device's own quick benchmark scales these (see speedFactors).
// "best" with super resolution is CPU-bound (NLMeans denoise on the CPU), so it scales with the slower factor.
const REF_FPS = {
  vsr: { fast: 94, balanced: 65, best: 28 },
  ffmpeg: { fast: 100, balanced: 70, best: 50 }
};
const REF_BENCH = { vsr: 185, ffmpeg: 64 }; // measured by DeviceMonitor.probe() on the reference machine

const ENGINE_NAMES = {
  rtx: "RTX Video",
  intel: "Intel AI",
  amd: "AMD FSR",
  onnx: "AI mọi card (ONNX)",
  cugan: "Real-CUGAN",
  ffmpeg: "FFmpeg"
};
const EXTRA_NAMES = { smooth: "Làm mượt chuyển động", anime: "Video hoạt hình", deblock: "Khử vỡ khối mạnh (AI)" };

function even(n) {
  const v = Math.round(n);
  return v % 2 === 0 ? v : v + 1;
}

function hasVendor(device, vendor) {
  return (device.adapters || []).some((a) => a.vendor === vendor);
}

function vsrState(device, vendor) {
  return (device.vsr || []).find((v) => v.vendor === vendor) || null;
}

function gpuLabel(device) {
  return (device.adapters && device.adapters[0] && device.adapters[0].name) || device.gpu || "card đồ hoạ hiện tại";
}

/** Availability of every engine and extra for this device: { id: { available, reason, experimental } }. */
function capabilities(device) {
  const nvidia = hasVendor(device, "nvidia");
  const nv = vsrState(device, "nvidia");
  const it = vsrState(device, "intel");
  const engines = {};

  if (nv && nv.effective) engines.rtx = { available: true };
  else if (nv && nv.accepted) engines.rtx = { available: false, reason: "RTX Video đang tắt trong NVIDIA App. Bật RTX Video Enhancement → Super Resolution rồi mở lại tab này." };
  else if (nvidia) engines.rtx = { available: false, reason: "Card NVIDIA này không hỗ trợ RTX Video. Cần GeForce RTX 20 trở lên và driver 531.18 mới hơn." };
  else engines.rtx = { available: false, reason: `Cần card NVIDIA GeForce RTX 20 trở lên. Máy này dùng ${gpuLabel(device)}.` };

  if (it && it.effective) engines.intel = { available: true, experimental: true };
  else if (hasVendor(device, "intel")) engines.intel = { available: false, reason: "Card Intel này chưa hỗ trợ nâng nét AI. Cần Intel Arc hoặc Iris Xe với driver mới." };
  else engines.intel = { available: false, reason: "Máy này không có card Intel Arc / Iris Xe." };

  engines.amd = hasVendor(device, "amd") && device.modernFfmpeg
    ? { available: true, experimental: true }
    : { available: false, reason: hasVendor(device, "amd") ? "Cần bản FFmpeg mới đi kèm ViSUBLY." : "Máy này không có card AMD Radeon." };

  engines.onnx = { available: false, reason: PHASE2 };
  engines.cugan = { available: false, reason: nvidia ? PHASE2 : "Cần card NVIDIA RTX để chạy TensorRT." };
  engines.ffmpeg = { available: true };

  const extras = {
    smooth: { available: false, reason: PHASE2 },
    anime: { available: true },
    deblock: { available: false, reason: nvidia ? PHASE2 : "Cần card NVIDIA RTX để chạy TensorRT." }
  };
  return { engines, extras };
}

function fastestEngine(caps) {
  return ["rtx", "intel", "amd", "ffmpeg"].find((id) => caps.engines[id] && caps.engines[id].available) || "ffmpeg";
}

/** Speed of this device relative to the reference machine, from its quick benchmark. */
function speedFactors(device) {
  const bench = device.bench || {};
  const clamp = (v) => Math.min(3, Math.max(0.15, v));
  return {
    vsr: bench.vsrFps ? clamp(bench.vsrFps / REF_BENCH.vsr) : 1,
    ffmpeg: bench.ffmpegFps ? clamp(bench.ffmpegFps / REF_BENCH.ffmpeg) : 1
  };
}

/** Targets above the source height (upscaling only). */
function availableTargets(video) {
  const h = (video && video.height) || 480;
  return Object.keys(TARGETS).filter((k) => TARGETS[k] > h);
}

function autoTargetFor(device, video) {
  const options = availableTargets(video);
  if (!options.length) return null;
  const screen = device.screenHeight || 1080;
  const cap = Math.max(Math.min(screen, ((video && video.height) || 480) * 3), TARGETS[options[0]]);
  const fitting = options.filter((k) => TARGETS[k] <= cap);
  return fitting.length ? fitting[fitting.length - 1] : options[0];
}

function outputSize(video, target) {
  const srcW = (video && video.width) || 854;
  const srcH = (video && video.height) || 480;
  const outH = TARGETS[target];
  return { width: even((outH * srcW) / srcH), height: outH };
}

function encoderFor(device, size) {
  const q = (SIZES[size] || SIZES.balanced).quality;
  const enc = device.encoders || {};
  if (enc.hevc_nvenc) return { vcodec: "hevc_nvenc", vargs: `-preset p5 -cq ${q} -tag:v hvc1` };
  if (enc.hevc_amf) return { vcodec: "hevc_amf", vargs: `-quality quality -rc cqp -qp_i ${q} -qp_p ${q} -tag:v hvc1` };
  if (enc.hevc_qsv) return { vcodec: "hevc_qsv", vargs: `-global_quality ${q} -tag:v hvc1` };
  return { vcodec: "libx264", vargs: `-preset faster -crf ${q - 6} -pix_fmt yuv420p` };
}

/**
 * Builds the processing plan for one set of choices.
 * choice: { preset: auto|fast|balanced|best, engine: default|<id>, extras: {anime?:bool,...}, target: auto|720p|..., size }
 */
function plan(device, video, choice = {}) {
  const caps = capabilities(device);
  const auto = autoChoice(device, video);
  const presetKey = choice.preset && choice.preset !== "auto" ? choice.preset : (auto ? auto.preset : "balanced");
  const target = choice.target && choice.target !== "auto" && TARGETS[choice.target] ? choice.target : (auto ? auto.target : autoTargetFor(device, video));
  return buildPlan(device, video, caps, { ...choice, preset: presetKey, target, auto: !choice.preset || choice.preset === "auto" });
}

function buildPlan(device, video, caps, choice) {
  const size = SIZES[choice.size] ? choice.size : "balanced";
  const preset = ["fast", "balanced", "best"].includes(choice.preset) ? choice.preset : "balanced";
  const anime = Boolean(choice.extras && choice.extras.anime);
  const vulkan = Boolean(device.vulkan);
  const wanted = choice.engine && choice.engine !== "default" ? choice.engine : null;
  const engine = wanted && caps.engines[wanted] && caps.engines[wanted].available ? wanted : fastestEngine(caps);
  const target = choice.target && TARGETS[choice.target] ? choice.target : autoTargetFor(device, video) || "1080p";
  const out = outputSize(video, target);
  const steps = [];
  const pre = [];
  const post = [];

  if (preset === "balanced") { pre.push(anime ? "hqdn3d=1:1:4:4" : "hqdn3d=1.5:1.5:6:6"); steps.push("Khử nhiễu"); }
  // nlmeans_vulkan was dropped: it fails with "Cannot allocate memory" depending on what else uses the GPU.
  const vsrEngine = engine === "rtx" || engine === "intel";
  if (preset === "best") {
    pre.push(vsrEngine ? (anime ? "nlmeans=s=1.5:p=5:r=5" : "nlmeans=s=2:p=5:r=5") : "hqdn3d=3:3:8:8");
    steps.push("Khử nhiễu kỹ");
  }
  steps.push(ENGINE_NAMES[engine]);
  const sharpen = preset === "fast" ? 0 : anime ? 0.6 : preset === "best" ? 0.5 : 0.4;

  let mode = "ffmpeg";
  if (engine === "rtx" || engine === "intel") {
    mode = engine === "rtx" ? "nvidia" : "intel";
    if (sharpen) post.push(`cas=${sharpen}`);
  } else {
    if (engine === "amd") pre.push(`sr_amf=w=${out.width}:h=${out.height}:algorithm=sr1-1,format=yuv420p`);
    // Upload explicitly: libplacebo's own upload of software frames fails at 480p in this FFmpeg build ("No slab").
    else if (vulkan) pre.push(`format=yuv420p,hwupload,libplacebo=w=${out.width}:h=${out.height}:upscaler=ewa_lanczossharp:format=yuv420p,hwdownload,format=yuv420p`);
    else pre.push(`scale=${out.width}:${out.height}:flags=lanczos`);
    if (sharpen) pre.push(`cas=${sharpen + 0.1}`);
  }
  if (sharpen) steps.push("Làm nét");

  // Speed: reference fps for this shape, scaled by the device benchmark and the output pixel count.
  const factors = speedFactors(device);
  const family = mode === "ffmpeg" ? "ffmpeg" : "vsr";
  const pixelRatio = (out.width * out.height) / (1920 * 1080);
  const factor = family === "vsr" && preset === "best" ? Math.min(factors.vsr, factors.ffmpeg) : factors[family];
  const estFps = (REF_FPS[family][preset] * factor) / Math.pow(pixelRatio, 0.85);
  const fps = (video && video.fps) || 30;
  const duration = (video && video.duration) || 0;
  const frames = Math.round(duration * fps);
  const seconds = estFps > 0 ? (frames / estFps) * 1.05 : 0;
  // Sharpening adds fine detail the encoder has to keep: Best + "Chất lượng cao" on the 17-min test clip came out
  // at 3.77 GB/h (vs 2.4 GB/h without sharpening), so scale the size by the sharpen strength.
  const sizeBytes = (SIZES[size].gbPerHour1080 * (duration / 3600) * Math.pow(pixelRatio, 0.75) * (1 + sharpen)) * 1024 ** 3;

  // How heavy for this device: speed relative to real time, plus graphics memory and battery.
  const realtime = estFps / fps;
  const vramNeedMb = 350 + (mode === "ffmpeg" && vulkan ? 300 : 0) + pixelRatio * 120;
  // Integrated GPUs report a tiny dedicated size (they share system RAM): only check discrete cards.
  const dedicated = (device.adapters && device.adapters[0] && device.adapters[0].vramMb) || 0;
  const vramMb = dedicated >= 1024 ? dedicated : 0;
  let fit = realtime >= 1 ? "ok" : realtime >= 0.35 ? "heavy" : "over";
  if (vramMb && vramNeedMb > vramMb * 0.9) fit = "over";
  else if (vramMb && vramNeedMb > vramMb * 0.7 && fit === "ok") fit = "heavy";
  if (device.onBattery && fit === "ok" && realtime < 2) fit = "heavy";

  const freeBytes = device.outputFreeBytes || 0;
  const diskShort = freeBytes > 0 && freeBytes < sizeBytes * 1.3 + 2 * 1024 ** 3;

  return {
    preset, target, size, engine, mode, anime, auto: Boolean(choice.auto),
    steps, label: `${steps.join(" → ")} · ${target}`,
    width: out.width, height: out.height,
    decWidth: even((video && video.width) || 854), decHeight: even((video && video.height) || 480),
    pre: pre.join(",") || null, post: post.join(",") || null, vulkan: vulkan && mode === "ffmpeg" && engine === "ffmpeg",
    encoder: encoderFor(device, size),
    estFps: Math.round(estFps), frames, seconds: Math.round(seconds), sizeBytes: Math.round(sizeBytes),
    fit, realtime: Math.round(realtime * 100) / 100, diskShort,
    experimental: Boolean(caps.engines[engine] && caps.engines[engine].experimental)
  };
}

/** Best preset + target that stays "ok" for this device (falls back to the lightest one). */
function autoChoice(device, video) {
  const caps = capabilities(device);
  const options = availableTargets(video);
  if (!options.length) return null;
  const first = autoTargetFor(device, video);
  const targets = options.slice(0, options.indexOf(first) + 1).reverse();
  for (const target of targets) {
    for (const preset of PRESET_ORDER) {
      const p = buildPlan(device, video, caps, { preset, target, size: "balanced" });
      if (p.fit === "ok") return { preset, target };
    }
  }
  return { preset: "fast", target: options[0] };
}

/** Everything the screen needs for one set of choices. */
function describe(device, video, choice = {}) {
  const caps = capabilities(device);
  const auto = video ? autoChoice(device, video) : null;
  const current = video ? plan(device, video, choice) : null;
  const presets = {};
  if (video) {
    for (const key of ["fast", "balanced", "best"]) {
      presets[key] = buildPlan(device, video, caps, { ...choice, preset: key, target: current.target }).fit;
    }
    presets.auto = auto ? buildPlan(device, video, caps, { ...choice, preset: auto.preset, target: auto.target }).fit : "ok";
  }
  return {
    capabilities: caps,
    engineNames: ENGINE_NAMES,
    extraNames: EXTRA_NAMES,
    targets: video ? availableTargets(video) : [],
    auto, presets, plan: current
  };
}

module.exports = { TARGETS, SIZES, capabilities, availableTargets, autoTargetFor, autoChoice, plan, describe, outputSize, encoderFor, speedFactors };
