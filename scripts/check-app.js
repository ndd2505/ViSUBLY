const fs = require("node:fs");
const path = require("node:path");

const required = [
  "src/main/main.js",
  "src/main/preload.js",
  "src/renderer/index.html",
  "src/renderer/styles.css",
  "src/renderer/app.js"
];

const root = path.resolve(__dirname, "..");
const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));

if (missing.length) {
  console.error("Missing required files:");
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
const main = fs.readFileSync(path.join(root, "src/main/main.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "src/main/preload.js"), "utf8");

const checks = [
  ["renderer root", html.includes("app-root")],
  ["desktop bridge", js.includes("visublyDesktop")],
  ["download flow", js.includes("renderDownload")],
  ["download queue bridge", preload.includes("downloadApi")],
  ["download runner integration", main.includes("hls2mp4_runner.py")],
  ["capture confirm dialog", js.includes("renderCaptureDialog") && preload.includes("prepareManual")],
  ["settings screen", js.includes("renderSettings") && preload.includes("openExtensionFolder")],
  ["theme setting", main.includes("nativeTheme") && html.includes("theme-boot.js")],
  ["folder player screen", js.includes("renderFolderPlayer")],
  ["folder scan bridge", preload.includes("selectVideoFolder") && main.includes("scanVideoFolder")],
  ["subtitle decoding", preload.includes("readSubtitleText") && main.includes("decodeSubtitleBuffer")],
  ["system player fallback", preload.includes("openInSystemPlayer")],
  ["AirPlay stay-awake blocker", main.includes("powerSaveBlocker") && preload.includes("onPowerState")],
  ["no demo leftovers", !/flaggedSegments|sampleCurl|renderApprove|startDownloadSimulation|visubly-app-logo-concept/.test(js)]
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error("App checks failed:");
  for (const [name] of failed) console.error(`- ${name}`);
  process.exit(1);
}

console.log("Visubly desktop app checks passed.");
