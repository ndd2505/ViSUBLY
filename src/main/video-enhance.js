"use strict";

// Real-time video enhancement = the GPU's own video super resolution, applied by Chromium while a
// video is presented through a hardware (DirectComposition) overlay and drawn larger than its source.
//   NVIDIA RTX 20+  -> RTX Video Super Resolution (Chromium feature "NvidiaVpSuperResolution")
//   Intel Arc/Xe    -> Intel Video Super Resolution ("IntelVpSuperResolution")
// Nothing is pre-processed: unsupported devices simply play the original video.
// Pure helpers (no Electron imports) so scripts/test-video-enhance.js can test them with Node.

const fs = require("node:fs");
const path = require("node:path");

const VENDOR = { NVIDIA: 0x10de, INTEL: 0x8086, AMD: 0x1002 };
const FEATURES_ON = ["NvidiaVpSuperResolution", "IntelVpSuperResolution"];
const FEATURES_OFF = ["NvidiaVpSuperResolution", "NvidiaVpTrueHDR", "IntelVpSuperResolution"];
const MIN_NVIDIA_DRIVER = 531.18; // first driver with RTX Video Super Resolution

// Windows driver version "32.0.16.1088" -> NVIDIA version 610.88 (last five digits).
function nvidiaDriverVersion(windowsVersion) {
  const parts = String(windowsVersion || "").split(".");
  if (parts.length < 4 || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])) return null;
  const digits = (parts[2] + parts[3].padStart(4, "0")).slice(-5);
  const value = Number(digits) / 100;
  return Number.isFinite(value) && value > 0 ? value : null;
}

// "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x000024C7) Direct3D11 ...)" -> "NVIDIA GeForce RTX 3060"
function gpuNameFromRenderer(renderer) {
  const text = String(renderer || "");
  const match = /^ANGLE \([^,]+,\s*(.+?)(?:\s+\(0x[0-9a-f]+\))?\s+Direct3D/i.exec(text);
  return (match ? match[1] : text).trim();
}

function isHardware(status) {
  return typeof status === "string" && status.startsWith("enabled");
}

function unsupported(reason, extra = {}) {
  return { supported: false, tech: null, techLabel: "", reason, ...extra };
}

// Decide from Electron's app.getGPUInfo("complete") + app.getGPUFeatureStatus() output.
function detectEnhanceSupport({ platform, gpuInfo, featureStatus } = {}) {
  if (platform !== "win32") return unsupported("Nâng chất lượng khi phát hiện chỉ có trên Windows; video được phát ở chất lượng gốc.");
  const status = featureStatus || {};
  if (!isHardware(status.gpu_compositing) || !isHardware(status.video_decode)) {
    return unsupported("Tăng tốc phần cứng (GPU) đang tắt, nên ViSUBLY phát chất lượng gốc.");
  }
  const devices = Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice : [];
  const active = devices.find((device) => device && device.active) || devices[0];
  const renderer = String(gpuInfo?.auxAttributes?.glRenderer || "");
  const gpu = gpuNameFromRenderer(renderer);
  if (!active || !active.vendorId) return unsupported("Không nhận diện được card đồ họa, nên ViSUBLY phát chất lượng gốc.");

  if (active.vendorId === VENDOR.NVIDIA) {
    if (!/\bRTX\b/i.test(renderer)) {
      return unsupported("Cần card NVIDIA RTX (dòng 20 trở lên) để dùng RTX Video Super Resolution.", { gpu });
    }
    const driver = nvidiaDriverVersion(active.driverVersion);
    if (driver !== null && driver < MIN_NVIDIA_DRIVER) {
      return unsupported(`Driver NVIDIA ${driver.toFixed(2)} quá cũ; cần ${MIN_NVIDIA_DRIVER} trở lên.`, { gpu, driver });
    }
    return {
      supported: true,
      tech: "nvidia-vsr",
      techLabel: "NVIDIA RTX Video Super Resolution",
      shortLabel: "RTX",
      gpu,
      driver,
      reason: "",
      hint: "Bật RTX Video Enhancement → Super Resolution trong NVIDIA App (hoặc NVIDIA Control Panel)."
    };
  }
  if (active.vendorId === VENDOR.INTEL) {
    if (/\b(Arc|Iris\(R\) Xe|Iris Xe)\b/i.test(renderer)) {
      return {
        supported: true,
        tech: "intel-vsr",
        techLabel: "Intel Video Super Resolution (thử nghiệm)",
        shortLabel: "Intel",
        gpu,
        driver: null,
        reason: "",
        hint: "Cần driver Intel mới và bật Video Super Resolution trong Intel Graphics Software."
      };
    }
    return unsupported("Card Intel này chưa hỗ trợ Video Super Resolution (cần Intel Arc hoặc Iris Xe).", { gpu });
  }
  if (active.vendorId === VENDOR.AMD) {
    return unsupported("Card AMD chưa được hỗ trợ trong ViSUBLY; bạn có thể bật Video Upscale trong AMD Software.", { gpu });
  }
  return unsupported("Card đồ họa này chưa được hỗ trợ, nên ViSUBLY phát chất lượng gốc.", { gpu });
}

// Crash guard: "startupPending" is set while a launch with enhancement on is not yet known to be stable.
// If the next launch still finds it set, the previous one crashed -> start with enhancement off.
function readGuard(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { startupPending: Boolean(data.startupPending), disabledReason: String(data.disabledReason || "") };
  } catch {
    return { startupPending: false, disabledReason: "" };
  }
}

function writeGuard(file, guard) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ startupPending: Boolean(guard.startupPending), disabledReason: guard.disabledReason || "" }, null, 2), "utf8");
  } catch {
    // Best effort: the guard must never break startup.
  }
}

// Returns { enhanceOnLaunch, guard, disabledNow } for this launch; caller persists settings if disabledNow.
function planLaunch({ settingOn, guard }) {
  const next = { ...guard };
  let disabledNow = false;
  if (settingOn && guard.startupPending) {
    disabledNow = true;
    next.disabledReason = "startup-crash";
  }
  const enhanceOnLaunch = settingOn && !disabledNow;
  next.startupPending = enhanceOnLaunch;
  return { enhanceOnLaunch, guard: next, disabledNow };
}

const DISABLED_REASON_TEXT = {
  "startup-crash": "Đã tự tắt vì lần mở trước ViSUBLY bị lỗi khi đang nâng chất lượng.",
  "gpu-crash": "Đã tự tắt vì bộ xử lý đồ họa gặp lỗi khi nâng chất lượng.",
  stutter: "Đã tự tắt vì video bị giật khi nâng chất lượng trên máy này."
};

module.exports = {
  VENDOR,
  FEATURES_ON,
  FEATURES_OFF,
  MIN_NVIDIA_DRIVER,
  nvidiaDriverVersion,
  gpuNameFromRenderer,
  detectEnhanceSupport,
  readGuard,
  writeGuard,
  planLaunch,
  DISABLED_REASON_TEXT
};
