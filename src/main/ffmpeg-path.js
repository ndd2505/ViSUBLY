// Where the bundled tools live.
//   Packaged (Windows): resources/ffmpeg/{ffmpeg,ffprobe}.exe and resources/upscaler/visubly-upscaler.exe
//                       (electron-builder extraResources from vendor/, see scripts/fetch-ffmpeg.ps1 and build-upscaler.ps1).
//   Development:        vendor/ffmpeg and vendor/upscaler in the project.
//   Fallback:           @ffmpeg-installer (old FFmpeg 4.x; still used by the macOS build until it gets its own).
const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..", "..");

function firstExisting(candidates) {
  return candidates.find((file) => {
    try {
      return Boolean(file) && fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }) || "";
}

function bundledCandidates(folder, file) {
  const list = [];
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, folder, file));
  list.push(path.join(projectRoot, "vendor", folder, file));
  return list;
}

function installerFfmpeg() {
  try {
    let binary = require("@ffmpeg-installer/ffmpeg").path;
    if (binary.includes("app.asar") && !binary.includes("app.asar.unpacked")) binary = binary.replace("app.asar", "app.asar.unpacked");
    return fs.existsSync(binary) ? binary : "";
  } catch {
    return "";
  }
}

function resolveFfmpegPath() {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return firstExisting(bundledCandidates("ffmpeg", exe)) || installerFfmpeg();
}

function resolveFfprobePath() {
  const exe = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  return firstExisting(bundledCandidates("ffmpeg", exe));
}

function resolveUpscalerPath() {
  if (process.platform !== "win32") return "";
  return firstExisting(bundledCandidates("upscaler", "visubly-upscaler.exe"));
}

/** True when ffmpeg is the bundled FFmpeg 8 build (libplacebo, cas, sr_amf...), not the old fallback. */
function isModernFfmpeg(ffmpegPath) {
  return Boolean(ffmpegPath) && /[\\/](vendor|resources)[\\/]ffmpeg[\\/]/i.test(ffmpegPath);
}

module.exports = { resolveFfmpegPath, resolveFfprobePath, resolveUpscalerPath, isModernFfmpeg };
