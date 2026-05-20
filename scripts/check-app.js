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

const checks = [
  ["renderer root", html.includes("app-root")],
  ["desktop bridge", js.includes("visublyDesktop")],
  ["download flow", js.includes("renderDownload")],
  ["subtitle flow", js.includes("renderSubtitle")],
  ["approval flow", js.includes("renderApprove")],
  ["ChatGPT option", js.includes("chatgpt")]
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error("App checks failed:");
  for (const [name] of failed) console.error(`- ${name}`);
  process.exit(1);
}

console.log("Visubly desktop app checks passed.");
