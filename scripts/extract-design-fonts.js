const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const htmlPath = path.join(root, "Subly Studio.html");
const fontDir = path.join(root, "src", "renderer", "assets", "fonts");
const fontsCssPath = path.join(root, "src", "renderer", "fonts.css");

const html = fs.readFileSync(htmlPath, "utf8");
const manifest = JSON.parse(
  html.match(/<script type="__bundler\/manifest">\s*([\s\S]*?)\s*<\/script>/)[1]
);
const template = JSON.parse(
  html.match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/)[1]
);

fs.mkdirSync(fontDir, { recursive: true });

let count = 0;
for (const [id, entry] of Object.entries(manifest)) {
  if (entry.mime !== "font/woff2") continue;
  fs.writeFileSync(path.join(fontDir, `${id}.woff2`), Buffer.from(entry.data, "base64"));
  count += 1;
}

let css = template.match(/<style>([\s\S]*?)<\/style>/)[1];
css = css.split("  html, body")[0];
css = css.replace(/url\("([^"]+)"\)/g, 'url("./assets/fonts/$1.woff2")');
fs.writeFileSync(fontsCssPath, css, "utf8");

console.log(`Extracted ${count} font files.`);
