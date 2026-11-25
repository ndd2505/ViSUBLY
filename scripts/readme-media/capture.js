// Drives the packaged app with demo data (isolated runtime) to capture README screenshots/GIFs,
// and checks the iPhone pairing end to end with a headless mobile Chrome.
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const FF = path.join(__dirname, "..", "..", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const EXE = path.join(__dirname, "..", "..", "dist", "win-unpacked", "Visubly Studio.exe");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = path.join(__dirname, "..", "..", "docs", "media");
const W = __dirname;
const demo = path.join(W, "demo");
const lib = path.join(demo, "Wild Coast");
const hlsDir = path.join(demo, "hls");
// Clean, user-neutral paths for what the screenshots display (removed after the run).
const demoRoot = "D:\\ViSUBLY Demo";
const rt = path.join(demoRoot, "AppData");
const downloadsDir = path.join(demoRoot, "Downloads");
const APP_DBG = 9566, PHONE_DBG = 9567, REMOTE_PORT = 3597, HLS_PORT = 47700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const checks = [];
const check = (name, ok, detail = "") => { checks.push(`${ok ? "PASS" : "FAIL"} - ${name}${detail ? "  " + detail : ""}`); };

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(demoRoot, { recursive: true, force: true });
fs.mkdirSync(downloadsDir, { recursive: true });
fs.mkdirSync(path.join(rt, "user-data"), { recursive: true });
// An existing (empty) queue + settings stop the app from migrating this PC's real download history.
fs.writeFileSync(path.join(rt, "user-data", "download-queue.json"), JSON.stringify({ items: [] }));
fs.writeFileSync(path.join(rt, "user-data", "settings.json"), JSON.stringify({
  downloadDir: downloadsDir, maxParallelDownloads: 2, segmentWorkers: 2, notifyOnComplete: false,
  captureBridgeEnabled: true, captureBridgePort: 47690, ignoreShortVideosSec: 0, theme: "dark", remoteAutoStart: true
}));

// Local HLS server, throttled so progress is visible.
const hlsServer = http.createServer((req, res) => {
  const file = path.join(hlsDir, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(hlsDir) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const send = () => { res.writeHead(200, { "content-type": file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t" }); fs.createReadStream(file).pipe(res); };
  if (file.endsWith(".ts")) setTimeout(send, hlsServer.delay || 0); else send();
}).listen(HLS_PORT, "127.0.0.1");
hlsServer.delay = 700;

function cdp(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    let id = 0; const pend = new Map(); const listeners = []; const errors = [];
    ws.on("message", (m) => {
      const x = JSON.parse(m);
      if (x.id && pend.has(x.id)) { pend.get(x.id)(x.result || x); pend.delete(x.id); return; }
      if (x.method === "Runtime.exceptionThrown") errors.push(x.params.exceptionDetails.exception?.description || x.params.exceptionDetails.text);
      listeners.forEach((fn) => fn(x));
    });
    const api = {
      errors,
      on: (fn) => listeners.push(fn),
      send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }),
      evaluate: async (expression) => (await api.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value,
      shot: async (name) => { const s = await api.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64")); log("shot", name); },
      close: () => ws.close()
    };
    ws.on("open", () => resolve(api));
  });
}
const getJson = (port, p, method = "GET") => new Promise((ok, ko) => {
  const r = http.request({ host: "127.0.0.1", port, path: p, method }, (s) => { let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => { try { ok(JSON.parse(d)); } catch (e) { ko(e); } }); });
  r.on("error", ko); r.end();
});
async function pageTarget(port, match = () => true) {
  for (let i = 0; i < 80; i += 1) {
    try { const t = (await getJson(port, "/json/list")).find((x) => x.type === "page" && match(x)); if (t) return t; } catch {}
    await sleep(250);
  }
  throw new Error("no page target on " + port);
}
function post(port, p, body, headers = {}) {
  return new Promise((ok, ko) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } }, (s) => {
      let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => { try { ok({ status: s.statusCode, json: JSON.parse(d || "{}") }); } catch { ok({ status: s.statusCode, json: {} }); } });
    });
    r.on("error", ko); r.end(data);
  });
}

// Screencast -> GIF.
async function record(page, name, fn, { width = 960, fps = 12, colors = 128 } = {}) {
  const dir = path.join(W, "frames", name); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  page.on((x) => {
    if (x.method !== "Page.screencastFrame" || !page.recording) return;
    const file = path.join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(x.params.data, "base64"));
    frames.push({ file, t: x.params.metadata.timestamp });
    page.send("Page.screencastFrameAck", { sessionId: x.params.sessionId });
  });
  page.recording = true;
  await page.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 1280, maxHeight: 800 });
  await fn();
  await sleep(600);
  await page.send("Page.stopScreencast");
  page.recording = false;
  const list = frames.map((f, i) => `file '${f.file.replaceAll("\\", "/")}'\nduration ${Math.max(0.04, ((frames[i + 1]?.t ?? f.t + 1.2) - f.t)).toFixed(3)}`).join("\n") + `\nfile '${frames[frames.length - 1].file.replaceAll("\\", "/")}'\n`;
  fs.writeFileSync(path.join(dir, "list.txt"), list);
  execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", path.join(dir, "list.txt"),
    "-vf", `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    "-loop", "0", path.join(OUT, name + ".gif")]);
  log("gif", name, frames.length, "frames", Math.round(fs.statSync(path.join(OUT, name + ".gif")).size / 1024) + " KB");
}

(async () => {
  const app = spawn(EXE, [`--remote-debugging-port=${APP_DBG}`], { env: { ...process.env, VISUBLY_RUNTIME_DIR: rt, VISUBLY_REMOTE_PORT: String(REMOTE_PORT) }, stdio: "ignore" });
  let phoneChrome = null;
  try {
    const page = await cdp((await pageTarget(APP_DBG, (t) => t.url.includes("index.html"))).webSocketDebuggerUrl);
    await page.send("Runtime.enable"); await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(2500);
    await page.evaluate("dismissIntro(); setScreen('home')");
    await sleep(800);

    // ---- Chrome capture flow (bridge pairing as the extension would) ----
    const bridge = await page.evaluate("desktop.capture.info()");
    const code = (await page.evaluate("desktop.capture.createPairingCode()")).code;
    const origin = { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" };
    const paired = await post(bridge.port, "/v1/pair", { code, clientName: "Chrome" }, origin);
    const bt = paired.json.token;
    check("extension bridge pairing", Boolean(bt), `port ${bridge.port}`);
    if (!bt) throw new Error(`bridge pairing failed: info=${JSON.stringify(bridge)} code=${code} -> ${paired.status} ${JSON.stringify(paired.json)}`);
    const capturePayload = (title, url) => ({ url, type: "hls", headers: { userAgent: "Mozilla/5.0" }, pageUrl: "https://video.example.com/wild-coast", pageTitle: title, detectedAt: Date.now() });
    await page.evaluate("setScreen('download')");
    await sleep(600);
    await record(page, "capture", async () => {
      await sleep(800);
      post(bridge.port, "/v1/capture", capturePayload("Wild Coast – Ep 04", `http://127.0.0.1:${HLS_PORT}/master.m3u8`), { ...origin, "x-visubly-token": bt });
      for (let i = 0; i < 40 && !(await page.evaluate("state.capture.queue.length")); i += 1) await sleep(250);
      await sleep(1800);
      await page.shot("capture-dialog.png");
      await page.evaluate("document.querySelectorAll('[data-action=pick-quality]')[1]?.click()");
      await sleep(1200);
      await page.evaluate("document.querySelector('[data-action=capture-now]')?.click()");
      for (let i = 0; i < 90; i += 1) { if (await page.evaluate("state.download.items.some(x => x.status === 'done')")) break; await sleep(500); }
      await sleep(1500);
    });
    check("capture -> download finished", await page.evaluate("state.download.items.some(x => x.status === 'done')"));

    // Second download caught mid-progress for the Downloads screenshot.
    hlsServer.delay = 1400;
    post(bridge.port, "/v1/capture", capturePayload("Wild Coast – Behind the scenes", `http://127.0.0.1:${HLS_PORT}/master.m3u8`), { ...origin, "x-visubly-token": bt });
    for (let i = 0; i < 40 && !(await page.evaluate("state.capture.queue.length")); i += 1) await sleep(250);
    await sleep(800);
    await page.evaluate("document.querySelector('[data-action=capture-now]')?.click()");
    for (let i = 0; i < 60; i += 1) { const p = await page.evaluate("Math.max(0, ...state.download.items.filter(x => x.status === 'active').map(x => x.progress || 0))"); if (p > 25) break; await sleep(500); }
    await page.shot("downloads.png");
    for (let i = 0; i < 120; i += 1) { if (await page.evaluate("state.download.items.filter(x => x.status === 'done').length >= 2")) break; await sleep(500); }

    // ---- Player ----
    const ep1 = path.join(lib, "Wild Coast - Ep 01.mp4");
    await page.evaluate(`openVideosFromSystem([${JSON.stringify(ep1)}])`);
    await sleep(2500);
    await page.evaluate("(() => { const v = document.getElementById('mainPlayerVideo'); if (v) { v.currentTime = 4.6; v.play(); } })()");
    await sleep(1500);
    check("player opened with folder + subtitles", await page.evaluate("state.screen === 'player' && state.folder.videos.length === 3 && !!state.player.srtPath"));
    await page.shot("player.png");
    await record(page, "player", async () => {
      await sleep(800);
      await page.evaluate("toggleTheaterMode()"); await sleep(1600);
      await page.evaluate("togglePlayerFullscreen()"); await sleep(1200);
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 400 }); await sleep(800);
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 660, y: 420 }); await sleep(3400);
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 700 }); await sleep(900);
      await page.evaluate("stepFolderVideo(1)"); await sleep(2200);
      await page.evaluate("document.fullscreenElement && document.exitFullscreen()"); await sleep(1000);
      await page.evaluate("state.player.theater && toggleTheaterMode()"); await sleep(1000);
    }, { width: 720, fps: 7, colors: 64 });
    await page.evaluate("document.getElementById('mainPlayerVideo')?.pause()");

    // ---- Home ----
    await page.evaluate("setScreen('home')"); await sleep(1200);
    await page.shot("home.png");

    // ---- iPhone Remote: approve-on-PC pairing from a headless mobile Chrome ----
    await page.evaluate("startRemote()"); await sleep(1800);
    await page.shot("remote-qr.png");
    await page.evaluate("closeRemoteModal()"); await sleep(400);
    phoneChrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PHONE_DBG}`, `--user-data-dir=${path.join(W, "phone-profile")}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    const phone = await cdp((await pageTarget(PHONE_DBG)).webSocketDebuggerUrl);
    await phone.send("Runtime.enable"); await phone.send("Page.enable");
    await phone.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await phone.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
    await phone.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await phone.send("Page.navigate", { url: `http://127.0.0.1:${REMOTE_PORT}/` }); await sleep(1800);
    check("phone sees connect page", await phone.evaluate("document.body.innerText.includes('Kết nối với ViSUBLY')"));
    await phone.shot("phone-connect.png");
    await phone.evaluate("document.getElementById('connect').click()"); await sleep(1500);
    check("PC shows approval dialog with device name", await page.evaluate("state.remote.pairingActive && state.remote.pairingDevice === 'iPhone'"));
    await page.shot("pair-dialog.png");
    await phone.shot("phone-waiting.png");
    await page.evaluate("document.querySelector('[data-action=remote-allow]').click()");
    await sleep(3500);
    check("phone gets the library after approval", await phone.evaluate("location.pathname === '/' && document.querySelectorAll('.video-item').length === 3"));
    await phone.shot("phone-library.png");
    await phone.evaluate("document.querySelector('.video-item')?.click()"); await sleep(2500);
    await phone.shot("phone-details.png");
    // Reload = what happens next time: no pairing needed.
    await phone.send("Page.reload"); await sleep(2000);
    check("phone reconnects without pairing (cookie)", await phone.evaluate("document.querySelectorAll('.video-item').length === 3"));
    check("device listed on PC", (await page.evaluate("desktop.airplay.listDevices()")).length === 1);

    // ---- Settings + theme ----
    await page.evaluate("setScreen('settings')"); await sleep(1500);
    await page.shot("settings.png");
    await record(page, "theme", async () => {
      await sleep(700);
      await page.evaluate("document.querySelector('[data-action=set-theme][data-value=light]').click()"); await sleep(1600);
      await page.evaluate("setScreen('download')"); await sleep(1600);
      await page.shot("downloads-light.png");
      await page.evaluate("setScreen('home')"); await sleep(1400);
      await page.evaluate("setScreen('settings')"); await sleep(900);
      await page.evaluate("document.querySelector('[data-action=set-theme][data-value=dark]').click()"); await sleep(1500);
    }, { width: 880, fps: 8, colors: 96 });

    check("no renderer errors", page.errors.length === 0, page.errors.slice(0, 2).join(" | "));
    phone.close(); page.close();
  } catch (error) {
    console.error("CAPTURE FAILED", error);
  } finally {
    console.log(checks.join("\n"));
    try { execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    if (phoneChrome) { try { execFileSync("taskkill", ["/PID", String(phoneChrome.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
    hlsServer.close();
    setTimeout(() => { try { fs.rmSync(demoRoot, { recursive: true, force: true }); } catch {} process.exit(0); }, 1500);
  }
})();
