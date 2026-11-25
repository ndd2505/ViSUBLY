// Unit tests for src/main/upscale-presets.js (pure planning logic of the "Nâng cấp video" tab).
// Run: node scripts/test-upscale-presets.js
const presets = require("../src/main/upscale-presets");

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "ok  " : "FAIL"} - ${name}${!ok && detail ? "  -> " + detail : ""}`);

const video480 = { width: 852, height: 480, fps: 30, duration: 1020 };
const devices = {
  rtx3060: {
    adapters: [{ name: "NVIDIA GeForce RTX 3060", vendor: "nvidia", vramMb: 8030 }],
    vsr: [{ vendor: "nvidia", accepted: true, effective: true }],
    bench: { vsrFps: 185, ffmpegFps: 64 }, vulkan: true, modernFfmpeg: true,
    encoders: { hevc_nvenc: true }, screenHeight: 1080, outputFreeBytes: 214 * 1024 ** 3
  },
  rtxOff: {
    adapters: [{ name: "NVIDIA GeForce RTX 3060", vendor: "nvidia", vramMb: 8030 }],
    vsr: [{ vendor: "nvidia", accepted: true, effective: false }],
    bench: { ffmpegFps: 64 }, vulkan: true, modernFfmpeg: true, encoders: { hevc_nvenc: true }, screenHeight: 1080
  },
  gtx: {
    adapters: [{ name: "NVIDIA GeForce GTX 1660", vendor: "nvidia", vramMb: 6144 }],
    vsr: [{ vendor: "nvidia", accepted: false, effective: false }],
    bench: { ffmpegFps: 120 }, vulkan: true, modernFfmpeg: true, encoders: { hevc_nvenc: true }, screenHeight: 1080
  },
  intelXe: {
    adapters: [{ name: "Intel(R) Iris(R) Xe Graphics", vendor: "intel", vramMb: 128 }],
    vsr: [{ vendor: "intel", accepted: true, effective: true }],
    bench: { vsrFps: 60, ffmpegFps: 50 }, vulkan: true, modernFfmpeg: true, encoders: { hevc_qsv: true }, screenHeight: 1080
  },
  amd: {
    adapters: [{ name: "AMD Radeon RX 6700 XT", vendor: "amd", vramMb: 12272 }],
    vsr: [], bench: { ffmpegFps: 150 }, vulkan: true, modernFfmpeg: true, encoders: { hevc_amf: true }, screenHeight: 1440
  },
  bare: { adapters: [{ name: "Microsoft Basic Display Adapter", vendor: "other", vramMb: 0 }], vsr: [], bench: { ffmpegFps: 40 }, vulkan: false, modernFfmpeg: true, encoders: {}, screenHeight: 1080 }
};

// --- capabilities -------------------------------------------------------------------------------------
const c3060 = presets.capabilities(devices.rtx3060);
check("RTX 3060: RTX Video available", c3060.engines.rtx.available);
check("RTX 3060: Intel / AMD locked with reasons", !c3060.engines.intel.available && !c3060.engines.amd.available && /Intel/.test(c3060.engines.intel.reason) && /AMD/.test(c3060.engines.amd.reason));
check("phase 2 items locked with 'bản cập nhật sau'", ["onnx", "cugan"].every((k) => /1\.3\.0/.test(c3060.engines[k].reason)) && /1\.3\.0/.test(c3060.extras.smooth.reason) && /1\.3\.0/.test(c3060.extras.deblock.reason));
check("anime extra available", c3060.extras.anime.available);
const cOff = presets.capabilities(devices.rtxOff);
check("RTX switched off in NVIDIA App -> locked, says how to turn it on", !cOff.engines.rtx.available && /NVIDIA App/.test(cOff.engines.rtx.reason));
const cGtx = presets.capabilities(devices.gtx);
check("GTX -> RTX locked (needs RTX 20+)", !cGtx.engines.rtx.available && /RTX 20/.test(cGtx.engines.rtx.reason));
const cXe = presets.capabilities(devices.intelXe);
check("Iris Xe -> RTX locked naming the Intel card", !cXe.engines.rtx.available && /Iris/.test(cXe.engines.rtx.reason));
check("Iris Xe -> Intel AI available (experimental)", cXe.engines.intel.available && cXe.engines.intel.experimental);
check("Iris Xe -> Real-CUGAN / deblock need NVIDIA", /NVIDIA/.test(cXe.engines.cugan.reason) && /NVIDIA/.test(cXe.extras.deblock.reason));
const cAmd = presets.capabilities(devices.amd);
check("AMD -> AMD FSR available (experimental)", cAmd.engines.amd.available && cAmd.engines.amd.experimental);

// --- targets ------------------------------------------------------------------------------------------
check("480p source -> 720p..4K offered", JSON.stringify(presets.availableTargets(video480)) === JSON.stringify(["720p", "1080p", "1440p", "4K"]));
check("1080p source -> only 1440p / 4K", JSON.stringify(presets.availableTargets({ width: 1920, height: 1080 })) === JSON.stringify(["1440p", "4K"]));
check("480p on a 1080p screen -> auto target 1080p", presets.autoTargetFor(devices.rtx3060, video480) === "1080p");
check("1080p source on a 1080p screen -> auto target 1440p", presets.autoTargetFor(devices.rtx3060, { width: 1920, height: 1080 }) === "1440p");
check("360p on a 1440p screen -> 1080p (3x cap)", presets.autoTargetFor(devices.amd, { width: 640, height: 360 }) === "1080p");
const size = presets.outputSize(video480, "1080p");
check("output keeps aspect with even width", size.height === 1080 && size.width % 2 === 0 && Math.abs(size.width - 1917) <= 1, JSON.stringify(size));

// --- automatic choice ---------------------------------------------------------------------------------
const a3060 = presets.autoChoice(devices.rtx3060, video480);
check("RTX 3060 + i3 + 480p -> auto picks Cân bằng at 1080p (Đẹp nhất is CPU-heavy)", a3060.preset === "balanced" && a3060.target === "1080p", JSON.stringify(a3060));
const p3060 = presets.plan(devices.rtx3060, video480, { preset: "auto" });
check("auto plan: denoise -> RTX Video -> sharpen", p3060.mode === "nvidia" && /hqdn3d=1\.5/.test(p3060.pre) && p3060.post === "cas=0.4" && p3060.fit === "ok" && !p3060.vulkan, JSON.stringify({ mode: p3060.mode, pre: p3060.pre, post: p3060.post, fit: p3060.fit }));
check("auto plan label reads well", p3060.label === "Khử nhiễu → RTX Video → Làm nét · 1080p", p3060.label);
const pBest = presets.plan(devices.rtx3060, video480, { preset: "best", target: "1080p" });
check("Đẹp nhất on RTX: CPU NLMeans -> RTX Video -> stronger sharpen, marked heavy", /^nlmeans=s=2:p=5:r=5$/.test(pBest.pre) && pBest.post === "cas=0.5" && pBest.fit === "heavy" && pBest.label === "Khử nhiễu kỹ → RTX Video → Làm nét · 1080p", JSON.stringify({ pre: pBest.pre, fit: pBest.fit, label: pBest.label }));
const pFfBest = presets.plan(devices.rtxOff, video480, { preset: "best", target: "1080p" });
check("Đẹp nhất without VSR: strong hqdn3d (NLMeans is too slow there)", /hqdn3d=3:3:8:8/.test(pFfBest.pre) && !/nlmeans/.test(pFfBest.pre), pFfBest.pre);
check("no nlmeans_vulkan anywhere (unreliable)", ![p3060, pBest, pFfBest].some((p) => /nlmeans_vulkan/.test(p.pre || "")));
check("NVENC HEVC encoder with quality 25", p3060.encoder.vcodec === "hevc_nvenc" && / -cq 25 /.test(` ${p3060.encoder.vargs} `));
check("17-min clip estimate: 5-15 min, ~0.3-0.6 GB", p3060.seconds > 300 && p3060.seconds < 900 && p3060.sizeBytes > 0.3 * 1024 ** 3 && p3060.sizeBytes < 0.6 * 1024 ** 3, JSON.stringify({ s: p3060.seconds, gb: (p3060.sizeBytes / 1024 ** 3).toFixed(2) }));
const aXe = presets.autoChoice(devices.intelXe, video480);
check("Iris Xe -> auto stays 'ok' (light preset or lower target)", presets.plan(devices.intelXe, video480, { preset: "auto" }).fit === "ok", JSON.stringify(aXe));
const pXeBest4k = presets.plan(devices.intelXe, video480, { preset: "best", target: "4K" });
check("Iris Xe + Đẹp nhất + 4K -> 'over' (warn)", pXeBest4k.fit === "over", pXeBest4k.fit);
const p4k = presets.plan(devices.rtx3060, video480, { preset: "best", target: "4K" });
check("RTX 3060 + 4K -> heavier than ok", p4k.fit !== "ok", p4k.fit);

// --- engines and fallbacks ----------------------------------------------------------------------------
const pOff = presets.plan(devices.rtxOff, video480, { preset: "balanced" });
check("RTX off -> FFmpeg path with libplacebo + cas", pOff.mode === "ffmpeg" && /libplacebo=w=1918:h=1080/.test(pOff.pre) && /cas=0\.5/.test(pOff.pre), pOff.pre);
const pWanted = presets.plan(devices.rtx3060, video480, { preset: "balanced", engine: "ffmpeg" });
check("choosing FFmpeg on an RTX machine is honoured", pWanted.mode === "ffmpeg" && pWanted.engine === "ffmpeg");
const pLocked = presets.plan(devices.intelXe, video480, { preset: "balanced", engine: "rtx" });
check("choosing a locked engine falls back to an available one", pLocked.engine === "intel" && pLocked.mode === "intel");
const pAmd = presets.plan(devices.amd, video480, { preset: "fast", target: "1080p" });
check("AMD -> sr_amf filter + AMF encoder", /sr_amf=w=1918:h=1080/.test(pAmd.pre) && pAmd.encoder.vcodec === "hevc_amf", JSON.stringify({ pre: pAmd.pre, enc: pAmd.encoder.vcodec }));
const pBare = presets.plan(devices.bare, video480, { preset: "balanced", target: "1080p" });
check("no GPU features -> CPU lanczos + libx264", /scale=1918:1080:flags=lanczos/.test(pBare.pre) && pBare.encoder.vcodec === "libx264" && !pBare.vulkan, JSON.stringify({ pre: pBare.pre, enc: pBare.encoder.vcodec }));
const pFast = presets.plan(devices.rtx3060, video480, { preset: "fast", target: "1080p" });
check("Nhanh = RTX Video only (no denoise / sharpen)", pFast.pre === null && pFast.post === null && pFast.label === "RTX Video · 1080p", pFast.label);
const pAnime = presets.plan(devices.rtx3060, video480, { preset: "balanced", target: "1080p", extras: { anime: true } });
check("anime: lighter denoise, stronger sharpen", /hqdn3d=1:1:4:4/.test(pAnime.pre) && pAnime.post === "cas=0.6");

// --- size, disk, battery ------------------------------------------------------------------------------
const small = presets.plan(devices.rtx3060, video480, { preset: "fast", target: "1080p", size: "small" });
const high = presets.plan(devices.rtx3060, video480, { preset: "fast", target: "1080p", size: "high" });
check("Nhỏ gọn < Vừa < Chất lượng cao (size + quality value)", small.sizeBytes < pFast.sizeBytes && pFast.sizeBytes < high.sizeBytes && / -cq 28 /.test(` ${small.encoder.vargs} `) && / -cq 22 /.test(` ${high.encoder.vargs} `));
const tight = presets.plan({ ...devices.rtx3060, outputFreeBytes: 1.5 * 1024 ** 3 }, video480, { preset: "fast", target: "1080p" });
check("not enough free space -> diskShort", tight.diskShort && !pFast.diskShort);
const battery = presets.plan({ ...devices.rtx3060, onBattery: true, bench: { vsrFps: 70, ffmpegFps: 60 } }, video480, { preset: "best", target: "1080p" });
check("on battery, borderline speed -> heavy", battery.fit === "heavy", battery.fit);

// --- describe -----------------------------------------------------------------------------------------
const d = presets.describe(devices.rtx3060, video480, { preset: "auto" });
check("describe: preset fits + plan + targets", d.presets.auto === "ok" && ["fast", "balanced", "best"].every((k) => typeof d.presets[k] === "string") && d.plan && d.targets.length === 4);
check("describe without a video", presets.describe(devices.rtx3060, null, {}).plan === null);

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `${failed} FAILED` : `ALL PASSED (${results.length})`);
process.exit(failed ? 1 : 0);
