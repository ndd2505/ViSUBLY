// Generates neutral demo media for README screenshots (no user content):
// 3 episodes with a Vietnamese .srt, and a 3-rendition HLS stream for the capture flow.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const FF = path.join(__dirname, "..", "..", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const demo = path.join(__dirname, "demo"); // generated, gitignored
const lib = path.join(demo, "Wild Coast");
const hls = path.join(demo, "hls");
fs.mkdirSync(lib, { recursive: true });
fs.mkdirSync(hls, { recursive: true });
fs.mkdirSync(path.join(demo, "Downloads"), { recursive: true });

const font = "C\\:/Windows/Fonts/segoeuib.ttf";
const ff = (args) => execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
const scene = (seconds, hue, title) => [
  "-f", "lavfi", "-i", `mandelbrot=s=640x360:rate=25:end_pts=${seconds * 25}`,
  "-f", "lavfi", "-i", "sine=frequency=196:sample_rate=44100",
  "-filter_complex",
  `[0:v]scale=1280:720,hue=h=${hue},drawtext=fontfile='${font}':text='${title}':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=56:box=1:boxcolor=black@0.45:boxborderw=22[v];[1:a]volume=0.04[a]`,
  "-map", "[v]", "-map", "[a]", "-t", String(seconds)
];

for (let i = 1; i <= 3; i += 1) {
  const out = path.join(lib, `Wild Coast - Ep 0${i}.mp4`);
  if (!fs.existsSync(out)) ff([...scene(20, i * 70, `WILD COAST  -  EP 0${i}`), "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", out]);
}
const cues = ["Sóng vỗ vào ghềnh đá suốt đêm.", "Chúng ta đi tiếp về phía ngọn hải đăng.", "Trời sắp sáng rồi, nhìn kìa!", "Đây là bờ biển hoang sơ nhất tôi từng thấy.", "Ghi lại khoảnh khắc này đi."];
const t = (s) => `00:00:${String(Math.floor(s)).padStart(2, "0")},${String(Math.round((s % 1) * 1000)).padStart(3, "0")}`;
fs.writeFileSync(path.join(lib, "Wild Coast - Ep 01.srt"), cues.map((c, i) => `${i + 1}\n${t(1 + i * 3.6)} --> ${t(1 + i * 3.6 + 3.2)}\n${c}\n`).join("\n"), "utf8");

const source = path.join(hls, "source.mp4");
if (!fs.existsSync(source)) ff([...scene(40, 200, "WILD COAST  -  EP 04"), "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", source]);
const renditions = [[720, 1280, 2500000], [480, 854, 1200000], [360, 640, 700000]];
for (const [h, w, bw] of renditions) {
  const dir = path.join(hls, `${h}p`);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, "index.m3u8"))) {
    ff(["-i", source, "-vf", `scale=${w}:${h}`, "-c:v", "libx264", "-preset", "veryfast", "-b:v", String(Math.round(bw * 0.85)), "-c:a", "aac", "-b:a", "96k",
      "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", "-hls_segment_filename", path.join(dir, "seg%03d.ts"), path.join(dir, "index.m3u8")]);
  }
}
fs.writeFileSync(path.join(hls, "master.m3u8"), ["#EXTM3U", ...renditions.flatMap(([h, w, bw]) => [`#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${w}x${h}`, `${h}p/index.m3u8`])].join("\n") + "\n");
console.log("demo media ready:", fs.readdirSync(lib).join(", "), "| hls:", fs.readdirSync(hls).join(", "));
