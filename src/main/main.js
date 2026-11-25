const { app, BrowserWindow, ipcMain, dialog, powerSaveBlocker, shell, Notification, nativeImage, nativeTheme } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const airplayServer = require("./airplay-server");

const projectRoot = path.resolve(__dirname, "..", "..");
// build/icon.* is shipped inside app.asar (see package.json build.files), so this works packaged and in dev.
const appIconPath = path.join(projectRoot, "build", process.platform === "win32" ? "icon.ico" : "icon.png");
const notificationIconPath = path.join(projectRoot, "build", "icon.png");

let mainWindow;
let airplayPowerBlockerId = null;
let airplayPowerBlockerStopTimer = null;
let appQuitting = false;

// Runtime data root: VISUBLY_RUNTIME_DIR > packaged userData (%APPDATA%\Visubly Studio) > <projectRoot>/.runtime (dev).
const runtimeRoot = path.resolve(
  process.env.VISUBLY_RUNTIME_DIR || (app.isPackaged ? app.getPath("userData") : path.join(projectRoot, ".runtime"))
);
const runtimePaths = {
  userData: path.join(runtimeRoot, "user-data"),
  sessionData: path.join(runtimeRoot, "session-data"),
  cache: path.join(runtimeRoot, "cache"),
  logs: path.join(runtimeRoot, "logs"),
  crashDumps: path.join(runtimeRoot, "crash-dumps"),
  temp: path.join(runtimeRoot, "temp")
};
const engineTempDir = path.join(runtimePaths.temp, "engine");
const settingsPath = path.join(runtimePaths.userData, "settings.json");
const mainLogPath = path.join(runtimePaths.logs, "main.log");
// Queue written by pre-1.0 dev builds; copied (never moved) into the new data dir on first run.
const legacyQueuePath =
  process.platform === "win32" ? path.join("D:\\", "Projects", "ViSUBLY", ".runtime", "user-data", "download-queue.json") : "";

// Downloader engine: packaged -> bundled PyInstaller exe in resources/engine; dev -> Python + engine/downloader.
const engineExecutableName = process.platform === "win32" ? "visubly-downloader.exe" : "visubly-downloader";
const bundledEnginePath = app.isPackaged ? path.join(process.resourcesPath, "engine", engineExecutableName) : "";
const devEngineDir =
  (!app.isPackaged && process.env.VISUBLY_EXTRACTING_VIDEO_DIR) || path.join(projectRoot, "engine", "downloader");
const runnerScript = path.join(devEngineDir, "hls2mp4_runner.py");
const legacyPythonPath = path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe");
const ffmpegPath = resolveFfmpegPath();
const runnerTimeoutMs = 120000;
let resolvedEngine = null;

const videoFolderExtensions = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".wmv",
  ".flv",
  ".ts",
  ".mts",
  ".m2ts"
]);
const subtitleFolderExtensions = new Set([".srt", ".vtt"]);
const maxFolderVideos = 1000;
const airplayPowerBlockerGraceMs = Math.max(0, Number(process.env.VISUBLY_AIRPLAY_AWAKE_GRACE_MS || 120000));
const airplayPowerBlockerMode =
  process.env.VISUBLY_AIRPLAY_KEEP_DISPLAY_AWAKE === "1" ? "prevent-display-sleep" : "prevent-app-suspension";
const downloadStatePath = path.join(runtimePaths.userData, "download-queue.json");
const maxParallelDownloadProcesses = 3;
const downloadStateFlushMs = 300;
const defaultSettings = Object.freeze({
  downloadDir: "",
  maxParallelDownloads: 2,
  segmentWorkers: 8,
  notifyOnComplete: true,
  captureBridgeEnabled: true,
  captureBridgePort: 47653,
  // Browser captures shorter than this (previews, ads) are hidden in the extension; 0 = off.
  ignoreShortVideosSec: 120,
  theme: "dark",
  // Start the iPhone Remote server with the app once at least one phone is trusted.
  remoteAutoStart: true
});
const themeModes = new Set(["dark", "light", "system"]);
const ignoreShortVideoChoices = new Set([0, 30, 60, 120, 300]);
const themeBackgrounds = { dark: "#0E0C12", light: "#F2EFE8" };
// Finished items stay listed until the user clears them; keep the newest ones only.
const maxKeptDoneItems = 200;
let settings = { ...defaultSettings };
const downloadQueue = {
  items: [],
  activeIds: new Set(),
  processes: new Map(),
  parallelItems: defaultSettings.maxParallelDownloads,
  localWorkers: defaultSettings.segmentWorkers
};
let downloadStateFlushTimer = null;
const activeNotifications = new Set();

// Browser capture bridge (src/main/capture-bridge.js is optional; the app runs without it).
const captureBridgeModulePath = path.join(__dirname, "capture-bridge.js");
const pendingCaptureTtlMs = 60 * 60 * 1000;
const pendingCaptures = new Map();
let captureBridge = null;
let captureBridgeError = "";
let captureBridgeTransition = Promise.resolve();

for (const dir of Object.values(runtimePaths)) {
  fs.mkdirSync(dir, { recursive: true });
}

for (const [name, dir] of Object.entries(runtimePaths)) {
  try {
    app.setPath(name, dir);
  } catch {
    // Some Electron versions/platforms do not allow overriding every path.
  }
}

// --- Files opened from Windows ("Open with", default app, drag onto the exe) ---
// Registered for these via build.fileAssociations; subtitles can be opened onto the current video.
const openableFileExtensions = new Set([".mp4", ".m4v", ".mkv", ".webm", ".mov", ".srt", ".vtt"]);
let pendingOpenFiles = [];
let openFilesRendererReady = false;
let openFilesFlushTimer = null;

function extractOpenPaths(argv = [], cwd = process.cwd()) {
  const paths = [];
  // argv[0] is the exe; in dev argv[1] is the app dir ("."), which fails the isFile check below.
  for (const raw of argv.slice(1)) {
    const arg = String(raw || "").trim().replace(/^"(.*)"$/, "$1");
    if (!arg || arg.startsWith("-")) continue;
    if (!openableFileExtensions.has(path.extname(arg).toLowerCase())) continue;
    const resolved = path.resolve(cwd || process.cwd(), arg);
    try {
      if (fs.statSync(resolved).isFile()) paths.push(resolved);
    } catch {
      // Not a file we can open.
    }
  }
  return paths;
}

// Explorer starts one process per selected file, so batch paths that arrive close together.
function queueOpenFiles(paths) {
  if (!paths || !paths.length) return;
  for (const p of paths) if (!pendingOpenFiles.includes(p)) pendingOpenFiles.push(p);
  if (!openFilesRendererReady) return; // The renderer pulls them with app:takeOpenFiles on boot.
  clearTimeout(openFilesFlushTimer);
  openFilesFlushTimer = setTimeout(() => {
    const batch = pendingOpenFiles;
    pendingOpenFiles = [];
    if (!sendToRenderer("app:open-files", { paths: batch })) pendingOpenFiles = batch;
  }, 350);
}

ipcMain.handle("app:takeOpenFiles", () => {
  openFilesRendererReady = true;
  const batch = pendingOpenFiles;
  pendingOpenFiles = [];
  return batch;
});

// Must run after app.setPath("userData") because the lock lives in the user data dir.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine, workingDirectory) => {
    focusMainWindow();
    queueOpenFiles(extractOpenPaths(commandLine, workingDirectory));
  });
  // macOS delivers files through open-file (also before ready); kept for the future Mac build.
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    queueOpenFiles(extractOpenPaths(["", filePath]));
    if (app.isReady()) focusMainWindow();
  });
  queueOpenFiles(extractOpenPaths(process.argv, process.cwd()));
  // Trusted phones are stored next to the other user data; the PNG icon is served to the phone page.
  airplayServer.configure({ dataDir: runtimePaths.userData, iconPath: path.join(projectRoot, "build", "icon.png") });
  const legacy = migrateLegacyQueue();
  settings = loadSettings(legacy);
  applySettingsToQueue();
  applyThemeSource();
  loadDownloadQueue();
}

// themeSource drives prefers-color-scheme in the renderer and native widgets (scrollbars, dialogs).
function applyThemeSource() {
  try {
    nativeTheme.themeSource = themeModes.has(settings.theme) ? settings.theme : "dark";
  } catch {
    // Older platforms may reject a theme source; the renderer still applies data-theme.
  }
}

function resolvedTheme() {
  if (settings.theme === "light") return "light";
  if (settings.theme === "system") return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  return "dark";
}

function syncWindowBackground() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(themeBackgrounds[resolvedTheme()]);
}

nativeTheme.on("updated", () => {
  if (settings.theme === "system") syncWindowBackground();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 720,
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    title: "ViSUBLY",
    icon: loadAppIcon(),
    backgroundColor: themeBackgrounds[resolvedTheme()],
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // A fresh renderer pulls pending files again (app:takeOpenFiles) once its handlers exist.
  openFilesRendererReady = false;
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
}

function loadAppIcon() {
  try {
    const image = nativeImage.createFromPath(appIconPath);
    return image.isEmpty() ? undefined : image;
  } catch {
    return undefined;
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady()) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  // Windows refuses focus() from a background app; a brief always-on-top bounce brings it forward.
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const contents = mainWindow.webContents;
  if (contents.isLoading()) {
    contents.once("did-finish-load", () => {
      if (!contents.isDestroyed()) contents.send(channel, payload);
    });
  } else {
    contents.send(channel, payload);
  }
  return true;
}

function logMain(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  if (!app.isPackaged) console.log(line);
  try {
    fs.appendFileSync(mainLogPath, `${line}\n`, "utf8");
  } catch {
    // Logging must never break the app.
  }
}

if (process.platform === "win32") app.setAppUserModelId("app.visubly.studio");

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    createWindow();
    startCaptureBridge();
    if (settings.remoteAutoStart && airplayServer.hasDevices()) {
      airplayServer.start().catch((error) => logMain("warn", `Remote auto-start failed: ${error.message}`));
    }
    setTimeout(cleanupStaleEngineTemp, 15000);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  appQuitting = true;
  stopAirplayPowerBlocker("App is quitting.");
  stopCaptureBridge();
  if (downloadStateFlushTimer) {
    clearTimeout(downloadStateFlushTimer);
    downloadStateFlushTimer = null;
  }
  if (!gotSingleInstanceLock) return;
  for (const [itemId, child] of downloadQueue.processes.entries()) {
    const item = getDownloadItem(itemId);
    if (item && item.status !== "done") {
      item.status = "queued";
      item.phase = "queued";
      appendDownloadLog(item, "App closed while this item was active; queued for retry.");
    }
    killProcessTree(child);
  }
  downloadQueue.activeIds.clear();
  downloadQueue.processes.clear();
  persistDownloadQueue();
});

// --- Settings & app info API ---
ipcMain.handle("settings:get", () => ({ ...settings }));

// Read synchronously by the preload so the first paint already uses the right theme.
ipcMain.on("app:bootInfoSync", (event) => {
  event.returnValue = { theme: settings.theme, resolvedTheme: resolvedTheme(), version: app.getVersion() };
});

ipcMain.handle("settings:update", async (_event, partial = {}) => updateSettings(partial));

ipcMain.handle("settings:selectDownloadDir", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Chọn thư mục lưu video",
    defaultPath: settings.downloadDir || undefined,
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true, settings: { ...settings } };
  const next = await updateSettings({ downloadDir: result.filePaths[0] });
  return { canceled: false, settings: next };
});

ipcMain.handle("app:getInfo", () => appInfo());

// --- Browser capture API ---
ipcMain.handle("capture:confirm", async (_event, payload = {}) => confirmCapture(payload));

ipcMain.handle("capture:dismiss", (_event, captureId) => {
  const removed = pendingCaptures.delete(String(captureId || ""));
  return { ok: true, removed };
});

ipcMain.handle("capture:createPairingCode", async () => {
  if (!captureBridge) return { ok: false, error: captureBridgeUnavailableMessage() };
  try {
    const pairing = await captureBridge.createPairingCode();
    return { ok: true, ...pairing };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("capture:info", () => captureBridgeInfo());

// A pasted URL/cURL goes through the same pending-capture path as a browser capture,
// so the renderer can show one confirm dialog for both.
ipcMain.handle("capture:prepareManual", async (_event, payload = {}) => {
  const source = String(payload.source || "").trim();
  if (!source) return { ok: false, error: "Paste a URL or full curl command first." };
  prunePendingCaptures();
  const type = guessSourceType(source);
  const prepareArgs = { source, type, noPreflight: true };
  let preparedItem;
  try {
    preparedItem = await prepareDownloadItem(prepareArgs);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const captureId = randomUUID();
  const host = preparedItem.host || hostFromUrl(preparedItem.url);
  const capture = {
    captureId,
    name: preparedItem.name || safeOutputStem(host || "video"),
    host,
    pageUrl: "",
    type,
    url: preparedItem.url,
    detectedAt: new Date().toISOString(),
    receivedAt: Date.now(),
    prepareArgs,
    preparedItem,
    variants: preparedItem.variants || [],
    error: "",
    origin: "manual"
  };
  pendingCaptures.set(captureId, capture);
  return { ok: true, capture: capturePayload(capture) };
});

ipcMain.handle("capture:revokeAll", async () => {
  if (!captureBridge) return { ok: false, error: captureBridgeUnavailableMessage() };
  try {
    await captureBridge.revokeAll();
    return { ok: true, info: captureBridgeInfo() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.handle("window:toggleMaximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});

ipcMain.handle("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle("dialog:selectVideo", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Chọn video",
    properties: ["openFile"],
    filters: [
      { name: "Video", extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v"] },
      { name: "Tất cả file", extensions: ["*"] }
    ]
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog:selectVideoFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Chọn thư mục video",
    properties: ["openDirectory"]
  });

  if (result.canceled || !result.filePaths.length) return null;
  const folderData = await scanVideoFolder(result.filePaths[0]);
  airplayServer.setFolder(folderData);
  return folderData;
});

ipcMain.handle("dialog:selectSubtitle", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Chọn file phụ đề",
    properties: ["openFile"],
    filters: [
      { name: "Phụ đề", extensions: ["srt", "vtt"] },
      { name: "Tất cả file", extensions: ["*"] }
    ]
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("file:readText", async (_event, filePath) => {
  if (!filePath || typeof filePath !== "string") return "";
  return fs.promises.readFile(filePath, "utf8");
});

ipcMain.handle("file:readSubtitleText", async (_event, filePath) => {
  if (!filePath || typeof filePath !== "string") return "";
  return decodeSubtitleBuffer(await fs.promises.readFile(filePath));
});

// Returns { [path]: boolean } so the renderer can hide recently played files that are gone.
ipcMain.handle("file:exists", async (_event, paths = []) => {
  const list = Array.isArray(paths) ? paths.filter((value) => typeof value === "string" && value).slice(0, 200) : [];
  const entries = await Promise.all(
    list.map(async (filePath) => {
      try {
        const stat = await fs.promises.stat(filePath);
        return [filePath, stat.isFile()];
      } catch {
        return [filePath, false];
      }
    })
  );
  return Object.fromEntries(entries);
});

ipcMain.handle("media:openInSystemPlayer", async (_event, filePath) => {
  if (!filePath || typeof filePath !== "string") return { ok: false, error: "No file to open." };
  if (!fs.existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };
  if (process.platform === "win32") {
    // ViSUBLY may itself be the default app for this type, so shell.openPath would just
    // reopen it. Show Windows' "How do you want to open this file?" picker instead.
    try {
      const child = spawn("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", filePath], {
        detached: true,
        stdio: "ignore",
        windowsHide: false
      });
      child.on("error", () => {});
      child.unref();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  const error = await shell.openPath(filePath);
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.handle("download:openDir", async () => {
  try {
    const dir = ensureDownloadDir();
    const error = await shell.openPath(dir);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("app:diskSpace", async () => {
  let dir = settings.downloadDir || "";
  if (!dir) return { ok: false, error: "No download folder." };
  // Walk up to an existing folder: statfs needs a real path.
  while (dir && !fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const stats = await fs.promises.statfs(dir);
    return {
      ok: true,
      root: path.parse(path.resolve(dir)).root,
      free: Number(stats.bavail) * Number(stats.bsize),
      total: Number(stats.blocks) * Number(stats.bsize)
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("app:openExtensionFolder", async () => {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, "browser-extension", "chrome")
    : path.join(projectRoot, "browser-extension", "chrome");
  if (!fs.existsSync(dir)) return { ok: false, error: `Extension folder not found: ${dir}`, path: dir };
  const error = await shell.openPath(dir);
  return error ? { ok: false, error, path: dir } : { ok: true, path: dir };
});

ipcMain.handle("media:toFileUrl", (_event, filePath) => {
  if (!filePath || typeof filePath !== "string") return "";
  return pathToFileURL(filePath).toString();
});

ipcMain.handle("media:scanVideoFolder", async (_event, folderPath, options = {}) => {
  const result = await scanVideoFolder(folderPath, options);
  airplayServer.setFolder(result);
  return result;
});

// --- AirPlay API ---
ipcMain.handle("airplay:start", async () => {
  return await airplayServer.start();
});

ipcMain.handle("airplay:stop", async () => {
  airplayServer.stop();
  stopAirplayPowerBlocker("AirPlay server stopped.");
  return { ok: true };
});

ipcMain.handle("airplay:info", async () => {
  return airplayServer.getServerInfo();
});

ipcMain.handle("airplay:respondPairing", (_event, payload = {}) => ({
  ok: airplayServer.respondPairing(String(payload.requestId || ""), Boolean(payload.allow))
}));
ipcMain.handle("airplay:listDevices", () => airplayServer.listDevices());
ipcMain.handle("airplay:revokeDevice", (_event, id) => ({ ok: airplayServer.revokeDevice(String(id || "")) }));
ipcMain.handle("airplay:revokeAllDevices", () => {
  airplayServer.revokeAllDevices();
  return { ok: true };
});

airplayServer.on("pairing_requested", (request) => {
  // { requestId, deviceName, pin }: the renderer asks "Cho phép / Từ chối"; the PIN is for old phone apps.
  focusMainWindow();
  sendToRenderer("airplay:pairing-requested", request);
});

airplayServer.on("pairing_resolved", (payload) => {
  sendToRenderer("airplay:pairing-resolved", payload);
});

airplayServer.on("pairing_success", (device) => {
  sendToRenderer("airplay:pairing-success", device || null);
});

airplayServer.on("devices_changed", (devices) => {
  sendToRenderer("airplay:devices-changed", devices);
});

airplayServer.on("activity_changed", (activity) => {
  if (activity.active) {
    startAirplayPowerBlocker(activity.reason || "AirPlay session active.");
  } else {
    scheduleAirplayPowerBlockerStop(activity.reason || "AirPlay session idle.");
  }
});

airplayServer.on("server_stopped", () => {
  stopAirplayPowerBlocker("AirPlay server stopped.");
});
// -------------------

function startAirplayPowerBlocker(reason) {
  if (airplayPowerBlockerStopTimer) {
    clearTimeout(airplayPowerBlockerStopTimer);
    airplayPowerBlockerStopTimer = null;
  }

  if (airplayPowerBlockerId !== null && powerSaveBlocker.isStarted(airplayPowerBlockerId)) {
    broadcastAirplayPowerState(reason);
    return;
  }

  airplayPowerBlockerId = powerSaveBlocker.start(airplayPowerBlockerMode);
  broadcastAirplayPowerState(reason);
}

function scheduleAirplayPowerBlockerStop(reason) {
  if (airplayPowerBlockerId === null) {
    broadcastAirplayPowerState(reason);
    return;
  }

  if (airplayPowerBlockerStopTimer) clearTimeout(airplayPowerBlockerStopTimer);
  airplayPowerBlockerStopTimer = setTimeout(() => {
    stopAirplayPowerBlocker(reason);
  }, airplayPowerBlockerGraceMs);

  broadcastAirplayPowerState(`${reason} Keeping PC awake during grace period.`);
}

function stopAirplayPowerBlocker(reason) {
  if (airplayPowerBlockerStopTimer) {
    clearTimeout(airplayPowerBlockerStopTimer);
    airplayPowerBlockerStopTimer = null;
  }

  if (airplayPowerBlockerId !== null) {
    powerSaveBlocker.stop(airplayPowerBlockerId);
    airplayPowerBlockerId = null;
  }

  broadcastAirplayPowerState(reason);
}

function airplayPowerSnapshot(reason) {
  return {
    active: airplayPowerBlockerId !== null && powerSaveBlocker.isStarted(airplayPowerBlockerId),
    reason,
    graceMs: airplayPowerBlockerGraceMs,
    mode: airplayPowerBlockerMode,
    displayMaySleep: airplayPowerBlockerMode === "prevent-app-suspension"
  };
}

function broadcastAirplayPowerState(reason) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("airplay:power-state", airplayPowerSnapshot(reason));
}

ipcMain.handle("media:findMatchingSubtitle", async (_event, videoPath) => {
  if (!videoPath || typeof videoPath !== "string") return null;
  return findMatchingSubtitleFile(videoPath);
});

// recursive:false = only this folder (used when a single file is opened from Windows,
// e.g. from E:\ root, where a recursive scan could walk the whole drive).
async function scanVideoFolder(folderPath, { recursive = true } = {}) {
  const rootPath = String(folderPath || "");
  if (!rootPath) throw new Error("Choose a folder first.");

  const rootStat = await fs.promises.stat(rootPath);
  if (!rootStat.isDirectory()) throw new Error("Selected path is not a folder.");

  const videos = [];
  const subtitles = [];
  const folders = [rootPath];
  let skippedFolders = 0;
  let truncated = false;

  while (folders.length && videos.length < maxFolderVideos) {
    const currentFolder = folders.pop();
    let entries = [];
    try {
      entries = await fs.promises.readdir(currentFolder, { withFileTypes: true });
    } catch {
      skippedFolders += 1;
      continue;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });

    for (const entry of entries) {
      const fullPath = path.join(currentFolder, entry.name);
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (recursive) folders.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (subtitleFolderExtensions.has(extension)) {
        subtitles.push({
          path: fullPath,
          name: entry.name,
          relativePath: path.relative(rootPath, fullPath),
          folder: path.relative(rootPath, path.dirname(fullPath))
        });
        continue;
      }
      if (!videoFolderExtensions.has(extension)) continue;

      let stat;
      try {
        stat = await fs.promises.stat(fullPath);
      } catch {
        continue;
      }

      videos.push({
        id: `folder-video-${videos.length}`,
        path: fullPath,
        url: pathToFileURL(fullPath).toString(),
        name: entry.name,
        relativePath: path.relative(rootPath, fullPath),
        folder: path.relative(rootPath, path.dirname(fullPath)),
        extension: extension.replace(".", "").toUpperCase(),
        hasSubtitleMarker: hasSubbedVideoMarker(entry.name),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });

      if (videos.length >= maxFolderVideos) {
        truncated = true;
        break;
      }
    }
  }

  videos.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: "base" }));
  const subtitleLookup = buildSubtitleLookup(subtitles);
  for (const video of videos) {
    const subtitle = findSubtitleFromLookup(video, subtitleLookup);
    if (!subtitle) continue;
    video.subtitlePath = subtitle.path;
    video.subtitleName = subtitle.name;
    video.subtitleUrl = pathToFileURL(subtitle.path).toString();
  }
  for (const video of videos) {
    video.hasSubtitle = Boolean(video.subtitlePath || video.hasSubtitleMarker);
    video.subtitleStatus = video.subtitlePath ? "file" : video.hasSubtitleMarker ? "name" : "none";
  }

  return {
    path: rootPath,
    name: path.basename(rootPath) || rootPath,
    videos,
    subtitleCount: subtitles.length,
    skippedFolders,
    truncated,
    scannedAt: new Date().toISOString()
  };
}

async function findMatchingSubtitleFile(videoPath) {
  const parsed = path.parse(videoPath);
  const searchDirs = uniquePaths([
    parsed.dir,
    path.join(parsed.dir, "subs"),
    path.join(parsed.dir, "Subs"),
    path.join(parsed.dir, "subtitles"),
    path.join(parsed.dir, "Subtitles"),
    path.join(parsed.dir, "subtitle"),
    path.join(parsed.dir, "Subtitle")
  ]);

  for (const dir of searchDirs) {
    for (const stem of subtitleStemVariants(parsed.name)) {
      for (const extension of subtitleFolderExtensions) {
        const candidate = path.join(dir, `${stem}${extension}`);
        try {
          await fs.promises.access(candidate, fs.constants.R_OK);
          return candidate;
        } catch {
          // Keep looking through common subtitle naming variants.
        }
      }
    }
  }

  const nearbySubtitles = [];
  for (const dir of searchDirs) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!subtitleFolderExtensions.has(extension)) continue;
      nearbySubtitles.push({
        path: path.join(dir, entry.name),
        name: entry.name,
        relativePath: entry.name,
        folder: dir
      });
    }
  }

  const match = findSubtitleFromLookup(
    {
      path: videoPath,
      name: parsed.base,
      relativePath: parsed.base,
      folder: ""
    },
    buildSubtitleLookup(nearbySubtitles)
  );
  return match?.path || null;
}

function subtitleStemVariants(stem) {
  const suffixes = ["", ".vi", ".vie", ".vn", ".en", ".eng", ".cc", ".sdh"];
  return suffixes.map((suffix) => `${stem}${suffix}`);
}

function buildSubtitleLookup(subtitles) {
  return subtitles
    .map((subtitle) => {
      const parsed = path.parse(subtitle.path);
      const cleanStem = stripSubtitleLanguageSuffix(parsed.name);
      return {
        ...subtitle,
        dir: path.dirname(subtitle.path),
        rawStem: parsed.name,
        cleanStem,
        key: normalizeMediaStem(cleanStem),
        rawKey: normalizeMediaStem(parsed.name)
      };
    })
    .filter((subtitle) => subtitle.key || subtitle.rawKey);
}

function findSubtitleFromLookup(video, subtitles) {
  const videoParsed = path.parse(video.path);
  const videoKey = normalizeMediaStem(videoParsed.name);
  const videoDir = path.dirname(video.path);
  let best = null;
  let bestScore = 0;

  for (const subtitle of subtitles) {
    let score = 0;
    if (subtitle.key === videoKey || subtitle.rawKey === videoKey) {
      score += 100;
    } else if (subtitle.key.startsWith(videoKey) || subtitle.rawKey.startsWith(videoKey)) {
      score += 58;
    } else if (videoKey.startsWith(subtitle.key) && subtitle.key.length >= Math.max(8, videoKey.length * 0.7)) {
      score += 42;
    } else {
      continue;
    }

    if (subtitle.dir === videoDir) score += 20;
    if (/\b(vi|vie|vn)\b/i.test(subtitle.rawStem)) score += 8;
    if (/\b(en|eng)\b/i.test(subtitle.rawStem)) score += 4;
    if (subtitle.relativePath && !subtitle.relativePath.includes(path.sep)) score += 3;

    if (score > bestScore) {
      best = subtitle;
      bestScore = score;
    }
  }

  return best;
}

function stripSubtitleLanguageSuffix(stem) {
  return String(stem || "").replace(
    /(?:[._\-\s](?:vi|vie|vn|en|eng|sub|subs|subtitle|captions|caption|cc|forced|sdh))+$/i,
    ""
  );
}

function hasSubbedVideoMarker(fileName) {
  const stem = path.parse(String(fileName || "")).name;
  return /(?:^|[-_.\s])vs(?:$|[-_.\s])/i.test(stem);
}

function normalizeMediaStem(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function uniquePaths(values) {
  return [...new Set(values.filter(Boolean))];
}

ipcMain.handle("download:getState", () => downloadSnapshot());

ipcMain.handle("download:prepare", async (_event, payload = {}) => {
  const item = await prepareDownloadItem(payload);
  return { ok: true, item, state: downloadSnapshot() };
});

ipcMain.handle("download:enqueue", async (_event, items = []) => {
  const list = Array.isArray(items) ? items : [items];
  const added = list.map((item) => addDownloadItem(item));
  persistAndBroadcastDownloadState();
  return { ok: true, items: added, state: downloadSnapshot() };
});

// options.parallelItems is accepted for compatibility but ignored: settings.maxParallelDownloads is authoritative.
ipcMain.handle("download:start", async (_event, _options = {}) => {
  pumpDownloadQueue();
  persistAndBroadcastDownloadState({ immediate: true });
  return { ok: true, state: downloadSnapshot() };
});

ipcMain.handle("download:cancel", async (_event, itemId) => {
  const item = getDownloadItem(itemId);
  if (!item) return { ok: false, error: "Download item not found." };
  item.cancelRequested = true;
  item.status = "canceled";
  item.phase = "canceled";
  appendDownloadLog(item, "Cancel requested.");
  const child = downloadQueue.processes.get(item.id);
  if (child) killProcessTree(child);
  downloadQueue.activeIds.delete(item.id);
  downloadQueue.processes.delete(item.id);
  persistAndBroadcastDownloadState({ immediate: true });
  pumpDownloadQueue();
  return { ok: true, state: downloadSnapshot() };
});

ipcMain.handle("download:retry", async (_event, itemId) => {
  const item = getDownloadItem(itemId);
  if (!item) return { ok: false, error: "Download item not found." };
  if (downloadQueue.processes.has(item.id)) return { ok: false, error: "Download item is already active." };
  item.status = "queued";
  item.phase = "queued";
  item.progress = 0;
  item.error = "";
  item.cancelRequested = false;
  appendDownloadLog(item, "Queued for retry.");
  persistAndBroadcastDownloadState();
  pumpDownloadQueue();
  return { ok: true, state: downloadSnapshot() };
});

ipcMain.handle("download:remove", async (_event, itemId) => {
  const item = getDownloadItem(itemId);
  if (!item) return { ok: false, error: "Download item not found." };
  const child = downloadQueue.processes.get(item.id);
  if (child) killProcessTree(child);
  downloadQueue.activeIds.delete(item.id);
  downloadQueue.processes.delete(item.id);
  downloadQueue.items = downloadQueue.items.filter((entry) => entry.id !== item.id);
  persistAndBroadcastDownloadState({ immediate: true });
  return { ok: true, state: downloadSnapshot() };
});

ipcMain.handle("download:clearCompleted", async () => {
  downloadQueue.items = downloadQueue.items.filter((item) => item.status !== "done");
  persistAndBroadcastDownloadState({ immediate: true });
  return { ok: true, state: downloadSnapshot() };
});

ipcMain.handle("download:openOutput", async (_event, itemId) => {
  const outputPath = downloadOutputPath(itemId);
  if (!outputPath) return { ok: false, error: "Output file is not available yet." };
  if (!fs.existsSync(outputPath)) return { ok: false, error: `Output file was not found: ${outputPath}` };
  const error = await shell.openPath(outputPath);
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.handle("download:revealOutput", (_event, itemId) => {
  const outputPath = downloadOutputPath(itemId);
  if (!outputPath) return { ok: false, error: "Output file is not available yet." };
  if (!fs.existsSync(outputPath)) return { ok: false, error: `Output file was not found: ${outputPath}` };
  shell.showItemInFolder(outputPath);
  return { ok: true };
});

async function prepareDownloadItem(payload, { timeoutMs = runnerTimeoutMs } = {}) {
  const source = String(payload.source || payload.curl || payload.url || "").trim();
  if (!source && !payload.itemFile) throw new Error("Paste a URL or full curl command first.");

  const name = String(payload.name || "").trim();
  // Always give the runner an explicit output so its built-in default folder is never used.
  const output = resolveDownloadOutput({ name, source, output: payload.output, unique: !payload.overwrite });
  const args = [
    "prepare",
    "--source-stdin",
    "--type",
    payload.type || "m3u8",
    "--target-quality",
    qualityToResolution(payload.quality || payload.targetQuality || "1080"),
    "--workers",
    String(clampInt(payload.workers, 1, 32, downloadQueue.localWorkers || 8)),
    "-o",
    output
  ];
  if (name) args.push("-n", name);
  if (payload.referer) args.push("--referer", String(payload.referer));
  if (payload.userAgent !== undefined) args.push("--user-agent", String(payload.userAgent || ""));
  for (const header of normalizeHeaderLines(payload.headers)) args.push("--header", header);
  if (payload.selectedUrl) args.push("--selected-url", String(payload.selectedUrl));
  if (payload.selectedQuality) args.push("--selected-quality", String(payload.selectedQuality));
  if (payload.overwrite) args.push("--overwrite");
  if (payload.noPreflight) args.push("--no-preflight");
  pushFfmpegArg(args);

  const result = await runRunnerJson(args, source, timeoutMs);
  const preparedEvent = [...result.events].reverse().find((event) => event.event === "prepared");
  if (!preparedEvent?.item) {
    const errorEvent = [...result.events].reverse().find((event) => event.event === "error");
    throw new Error(errorEvent?.message || "Download parser did not return a prepared item.");
  }
  const item = normalizeDownloadItem(preparedEvent.item, {
    name,
    sourceText: source,
    quality: payload.quality || qualityFromResolution(preparedEvent.item.selected_quality)
  });
  for (const event of result.events) {
    if (event.event === "warning" || event.event === "log") {
      appendDownloadLog(item, event.message || event.phase || event.event);
    }
  }
  return item;
}

function runRunnerJson(args, stdinText = "", timeoutMs = runnerTimeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnEngine(args, ["pipe", "pipe", "pipe"]);
    } catch (error) {
      reject(error);
      return;
    }

    const events = [];
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(new Error(`Download runner timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBuffer = parseJsonLines(stdoutBuffer + chunk.toString(), (event) => events.push(event));
    });
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
    });
    child.stdin.on("error", () => {
      // The runner may exit before reading stdin; the close handler reports the real error.
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      parseJsonLines(stdoutBuffer + "\n", (event) => events.push(event));
      if (code === 0) {
        finish(null, { events });
        return;
      }
      const errorEvent = [...events].reverse().find((event) => event.event === "error");
      finish(new Error(errorEvent?.message || stderrBuffer.trim() || `Download runner exited with code ${code}.`));
    });
    child.stdin.end(stdinText || "");
  });
}

function startDownloadProcess(item) {
  let child;
  let outputExistedAtStart = false;
  const itemPath = path.join(runtimePaths.temp, `download-${item.id}-${Date.now()}.json`);
  const eventLogPath = path.join(runtimePaths.logs, `download-${safeFilePart(item.name)}-${item.id}.jsonl`);
  try {
    // Re-check the target right before starting: another item or an older file may now own the name.
    const desired = item.output || "";
    item.output = resolveDownloadOutput({ name: item.name, output: desired, unique: !item.overwrite }, item.id);
    if (desired && path.resolve(desired) !== path.resolve(item.output)) {
      appendDownloadLog(item, `Output already exists; saving as ${item.output}`);
    }
    outputExistedAtStart = fs.existsSync(item.output);
    item.outputClaimed = !outputExistedAtStart;
    fs.writeFileSync(itemPath, JSON.stringify(itemToRunnerJson(item), null, 2), "utf8");
    const args = ["download", "--item-file", itemPath, "--event-log-file", eventLogPath, "-o", item.output];
    pushFfmpegArg(args);
    child = spawnEngine(args, ["ignore", "pipe", "pipe"]);
  } catch (error) {
    item.status = "failed";
    item.phase = "failed";
    item.error = error.message;
    item.outputClaimed = false;
    appendDownloadLog(item, item.error);
    persistAndBroadcastDownloadState();
    return;
  }

  item.status = "active";
  item.phase = "starting";
  item.pid = child.pid;
  item.logPath = eventLogPath;
  item.updatedAt = new Date().toISOString();
  item.cancelRequested = false;
  appendDownloadLog(item, `Started runner process ${child.pid}.`);

  downloadQueue.activeIds.add(item.id);
  downloadQueue.processes.set(item.id, child);
  broadcastDownloadEvent({ event: "item-started", itemId: item.id, pid: child.pid });
  persistAndBroadcastDownloadState();

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer = parseJsonLines(stdoutBuffer + chunk.toString(), (event) => applyRunnerEvent(item.id, event));
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      appendDownloadLog(item, text);
      persistAndBroadcastDownloadState({ deferred: true });
    }
  });
  const runOutput = item.output;
  let finished = false;
  const finish = (code, spawnError) => {
    if (finished) return;
    finished = true;
    fs.promises.rm(itemPath, { force: true }).catch(() => {});
    if (appQuitting) return; // before-quit already re-queued and persisted this item.
    const currentChild = downloadQueue.processes.get(item.id);
    if (currentChild && currentChild !== child) {
      // A newer run (cancel then quick retry) owns this item now; only tidy up our own partial file.
      if (!outputExistedAtStart && path.resolve(runOutput) !== path.resolve(item.output || "")) removeFileWithRetry(runOutput);
      return;
    }
    if (spawnError) item.error = spawnError.message;
    else parseJsonLines(stdoutBuffer + "\n", (event) => applyRunnerEvent(item.id, event));
    const itemStillTracked = downloadQueue.items.some((entry) => entry.id === item.id);
    downloadQueue.activeIds.delete(item.id);
    downloadQueue.processes.delete(item.id);
    delete item.pid;
    if (!itemStillTracked) {
      removePartialOutput(item);
      pumpDownloadQueue();
      return;
    }
    if (item.status === "canceled" || item.cancelRequested) {
      item.status = "canceled";
      item.phase = "canceled";
      appendDownloadLog(item, "Runner stopped after cancel.");
      removePartialOutput(item);
    } else if (code === 0 && !spawnError) {
      markDownloadDone(item);
      appendDownloadLog(item, "Download completed.");
      notifyDownloadFinished(item, true);
    } else {
      item.status = "failed";
      item.phase = "failed";
      item.error = item.error || `Runner exited with code ${code}.`;
      appendDownloadLog(item, item.error);
      removePartialOutput(item);
      notifyDownloadFinished(item, false);
    }
    item.updatedAt = new Date().toISOString();
    persistAndBroadcastDownloadState();
    pumpDownloadQueue();
  };
  child.on("error", (error) => finish(null, error));
  child.on("close", (code) => finish(code, null));
}

// Deletes an unfinished output file, but only when this app created it (outputClaimed).
function removePartialOutput(item) {
  if (!item?.outputClaimed || !item.output) return;
  item.outputClaimed = false;
  removeFileWithRetry(item.output);
}

function removeFileWithRetry(target, attempt = 0) {
  if (!target) return;
  fs.promises.rm(target, { force: true }).catch((error) => {
    // ffmpeg may still hold the file for a moment after taskkill.
    if (attempt < 3) setTimeout(() => removeFileWithRetry(target, attempt + 1), 1500);
    else logMain("warn", `Could not remove partial output ${target}: ${error.message}`);
  });
}

function notifyDownloadFinished(item, ok) {
  if (!settings.notifyOnComplete) return;
  try {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: ok ? "Tải xong" : "Tải không thành công",
      body: ok ? item.name : `${item.name}: ${item.error || "Lỗi không rõ"}`.slice(0, 240),
      icon: fs.existsSync(notificationIconPath) ? notificationIconPath : undefined
    });
    const output = item.output;
    activeNotifications.add(notification);
    const release = () => activeNotifications.delete(notification);
    notification.on("click", () => {
      release();
      focusMainWindow();
      if (ok && output && fs.existsSync(output)) shell.showItemInFolder(output);
    });
    notification.on("close", release);
    notification.on("failed", release);
    notification.show();
    setTimeout(release, 5 * 60 * 1000);
  } catch (error) {
    logMain("warn", `Notification failed: ${error.message}`);
  }
}

function pumpDownloadQueue() {
  while (downloadQueue.activeIds.size < downloadQueue.parallelItems) {
    const next = downloadQueue.items.find((item) => item.status === "queued");
    if (!next) return;
    startDownloadProcess(next);
  }
}

function applyRunnerEvent(itemId, event) {
  const item = getDownloadItem(itemId);
  if (!item) return;
  item.updatedAt = new Date().toISOString();
  broadcastDownloadEvent({ ...event, itemId });

  if (event.event === "prepared" && event.item) {
    mergePreparedFields(item, event.item);
  } else if (event.event === "phase") {
    item.phase = event.phase || item.phase;
    if (event.status === "started") item.status = statusForPhase(event.phase);
    appendDownloadLog(item, `${event.phase || "phase"} ${event.status || ""}`.trim());
  } else if (event.event === "progress") {
    item.phase = event.phase || item.phase;
    item.status = statusForPhase(event.phase);
    item.progress = normalizeProgress(event.phase, event.percent, item.progress);
    item.speed = event.speed || item.speed || "";
    item.eta = event.eta ?? item.eta ?? null;
    item.elapsed = event.elapsed ?? item.elapsed ?? null;
    item.completedSegments = event.completed_segments ?? item.completedSegments;
    item.totalSegments = event.total_segments ?? item.totalSegments;
  } else if (event.event === "log") {
    appendDownloadLog(item, event.message || "");
  } else if (event.event === "warning") {
    appendDownloadLog(item, `Warning: ${event.message || ""}`);
  } else if (event.event === "ffmpeg_output") {
    for (const line of event.lines || []) appendDownloadLog(item, line);
  } else if (event.event === "error") {
    item.error = event.message || "Download runner error.";
    appendDownloadLog(item, item.error);
  } else if (event.event === "done") {
    item.output = event.output || item.output;
    markDownloadDone(item);
  } else if (event.event === "failed") {
    item.status = "failed";
    item.phase = "failed";
    item.error = item.error || `Runner failed with code ${event.exit_code ?? "unknown"}.`;
  }

  persistAndBroadcastDownloadState({ deferred: isNoisyDownloadEvent(event) });
}

function markDownloadDone(item) {
  item.status = "done";
  item.phase = "done";
  item.progress = 100;
  item.outputClaimed = false;
  item.error = "";
  item.speed = "";
  item.eta = null;
  if (!item.finishedAt) item.finishedAt = new Date().toISOString();
  try {
    if (item.output) item.fileSize = fs.statSync(item.output).size;
  } catch {
    // The size is informational only.
  }
}

function trimDoneItems() {
  const done = downloadQueue.items.filter((item) => item.status === "done");
  if (done.length <= maxKeptDoneItems) return;
  const keep = new Set(
    done
      .sort((a, b) => String(b.finishedAt || b.updatedAt).localeCompare(String(a.finishedAt || a.updatedAt)))
      .slice(0, maxKeptDoneItems)
      .map((item) => item.id)
  );
  downloadQueue.items = downloadQueue.items.filter((item) => item.status !== "done" || keep.has(item.id));
}

function guessSourceType(source) {
  const match = String(source || "").match(/https?:\/\/[^\s'"\\]+/i);
  if (!match) return "m3u8";
  try {
    const pathname = new URL(match[0]).pathname.toLowerCase();
    if (/\.(mp4|m4v|mov|webm)$/.test(pathname)) return "mp4";
    if (/\.mpd$/.test(pathname)) return "dash";
  } catch {
    // Fall through to HLS.
  }
  return "m3u8";
}

// Subtitle files come in many encodings; Vietnamese ones are often UTF-16 or Windows-1258.
function decodeSubtitleBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not valid UTF-8: try legacy Windows code pages.
  }
  for (const label of ["windows-1258", "windows-1252"]) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Label not supported by this ICU build; try the next one.
    }
  }
  return Buffer.from(bytes).toString("latin1");
}

function addDownloadItem(raw) {
  const item = normalizeDownloadItem(raw);
  const existingIndex = downloadQueue.items.findIndex((entry) => entry.id === item.id);
  if (existingIndex >= 0) {
    downloadQueue.items[existingIndex] = { ...downloadQueue.items[existingIndex], ...item, status: item.status || "queued" };
    return downloadQueue.items[existingIndex];
  }
  downloadQueue.items.push(item);
  return item;
}

function normalizeDownloadItem(raw = {}, overrides = {}) {
  const now = new Date().toISOString();
  const output = String(raw.output || overrides.output || "");
  const selectedQuality = raw.selected_quality || raw.selectedQuality || raw.selectedQualityLabel || raw.qualityLabel || null;
  const url = String(raw.url || overrides.url || "");
  const selectedUrl = String(raw.selected_url || raw.selectedUrl || raw.selectedUrl || url);
  const name = String(overrides.name || raw.name || (output ? path.basename(output, path.extname(output)) : "video"));
  return {
    id: String(raw.id || overrides.id || randomUUID()),
    name,
    type: String(raw.link_type || raw.type || overrides.type || "m3u8"),
    sourceText: String(raw.sourceText || overrides.sourceText || ""),
    url,
    headers: Array.isArray(raw.headers) ? raw.headers.map(String) : [],
    selectedUrl,
    selectedQuality,
    quality: String(raw.quality || overrides.quality || qualityFromResolution(selectedQuality) || "1080"),
    output,
    host: String(raw.host || overrides.host || hostFromUrl(url || selectedUrl)),
    workers: Math.max(1, Number(raw.workers || overrides.workers || downloadQueue.localWorkers || 8)),
    overwrite: Boolean(raw.overwrite || overrides.overwrite),
    outputClaimed: Boolean(raw.outputClaimed),
    status: String(raw.status || overrides.status || "queued"),
    phase: String(raw.phase || overrides.phase || "queued"),
    progress: Number(raw.progress || 0),
    speed: raw.speed || "",
    eta: raw.eta ?? null,
    elapsed: raw.elapsed ?? null,
    error: raw.error || "",
    logs: Array.isArray(raw.logs) ? raw.logs.slice(-300) : [],
    logPath: raw.logPath || "",
    variants: Array.isArray(raw.variants) ? raw.variants : [],
    segmentCount: Number(raw.segment_count || raw.segmentCount || 0),
    estimatedDuration: raw.estimated_duration ?? raw.estimatedDuration ?? null,
    kind: String(raw.kind || overrides.kind || ""),
    durationSec: Math.max(0, Number(raw.duration_sec ?? raw.durationSec) || 0),
    isLive: Boolean(raw.is_live ?? raw.isLive),
    renditions: Array.isArray(raw.renditions) ? raw.renditions.map(String) : [],
    pageUrl: String(raw.pageUrl || overrides.pageUrl || ""),
    fileSize: Number(raw.fileSize || 0) || 0,
    finishedAt: raw.finishedAt || "",
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now
  };
}

function mergePreparedFields(item, prepared) {
  item.url = prepared.url || item.url;
  item.headers = Array.isArray(prepared.headers) ? prepared.headers.map(String) : item.headers;
  item.selectedUrl = prepared.selected_url || prepared.selectedUrl || item.selectedUrl;
  item.selectedQuality = prepared.selected_quality || prepared.selectedQuality || item.selectedQuality;
  item.output = prepared.output || item.output;
  item.variants = Array.isArray(prepared.variants) ? prepared.variants : item.variants;
  item.segmentCount = Number(prepared.segment_count || prepared.segmentCount || item.segmentCount || 0);
  item.estimatedDuration = prepared.estimated_duration ?? prepared.estimatedDuration ?? item.estimatedDuration;
  item.quality = qualityFromResolution(item.selectedQuality) || item.quality;
}

function normalizeProgress(phase, percent, current) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return current || 0;
  if (phase === "download_segments") return Math.max(current || 0, Math.min(80, value * 0.8));
  if (phase === "combine_segments") return Math.max(current || 0, 82);
  if (phase === "mux_ts_to_mp4") return Math.max(current || 0, Math.min(100, 80 + value * 0.2));
  return Math.max(0, Math.min(100, value));
}

function statusForPhase(phase) {
  if (phase === "preflight" || phase === "starting") return "preparing";
  if (phase === "mux_ts_to_mp4" || phase === "combine_segments") return "muxing";
  if (phase === "done") return "done";
  if (phase === "failed") return "failed";
  return "active";
}

function isNoisyDownloadEvent(event = {}) {
  return ["progress", "log", "ffmpeg_output", "warning"].includes(event.event);
}

function normalizeDownloadParallel(value) {
  return clampInt(value, 1, maxParallelDownloadProcesses, defaultSettings.maxParallelDownloads);
}

function clampInt(value, min, max, fallback) {
  const next = Math.round(Number(value));
  if (value === null || value === undefined || value === "" || !Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function appendDownloadLog(item, message) {
  const text = String(message || "").trim();
  if (!text) return;
  item.logs = Array.isArray(item.logs) ? item.logs : [];
  item.logs.push(`[${new Date().toLocaleTimeString()}] ${text}`);
  if (item.logs.length > 300) item.logs = item.logs.slice(-300);
}

function getDownloadItem(itemId) {
  return downloadQueue.items.find((item) => item.id === itemId);
}

function downloadOutputPath(itemId) {
  const item = getDownloadItem(itemId);
  return item?.output ? path.resolve(item.output) : "";
}

function downloadSnapshot() {
  trimDoneItems();
  return {
    items: downloadQueue.items.map((item) => {
      const copy = { ...item };
      delete copy.cancelRequested;
      return copy;
    }),
    parallelItems: downloadQueue.parallelItems,
    localWorkers: downloadQueue.localWorkers,
    runnerPath: app.isPackaged ? bundledEnginePath : runnerScript,
    downloadDir: settings.downloadDir
  };
}

function persistAndBroadcastDownloadState(options = {}) {
  if (!options.deferred || options.immediate) {
    flushDownloadState();
    return;
  }

  if (downloadStateFlushTimer) return;
  downloadStateFlushTimer = setTimeout(() => {
    downloadStateFlushTimer = null;
    flushDownloadState();
  }, downloadStateFlushMs);
}

function flushDownloadState() {
  if (downloadStateFlushTimer) {
    clearTimeout(downloadStateFlushTimer);
    downloadStateFlushTimer = null;
  }
  persistDownloadQueue();
  broadcastDownloadState();
}

function persistDownloadQueue() {
  const data = downloadSnapshot();
  fs.writeFileSync(downloadStatePath, JSON.stringify(data, null, 2), "utf8");
}

function loadDownloadQueue() {
  try {
    if (!fs.existsSync(downloadStatePath)) return;
    // Parallelism and workers now come from settings.json; only items are restored here.
    const data = JSON.parse(fs.readFileSync(downloadStatePath, "utf8"));
    downloadQueue.items = Array.isArray(data.items)
      ? data.items.map((item) => {
          const normalized = normalizeDownloadItem(item);
          if (["active", "preparing", "muxing"].includes(normalized.status)) {
            normalized.status = "queued";
            normalized.phase = "queued";
            normalized.progress = 0;
            appendDownloadLog(normalized, "Recovered from previous app session.");
          }
          // An interrupted run leaves a partial file that this app created; drop it so the retry reuses the name.
          if (normalized.status !== "done") removePartialOutput(normalized);
          return normalized;
        })
      : [];
  } catch (error) {
    logMain("warn", `Could not load download queue: ${error.message}`);
    downloadQueue.items = [];
  }
}

function broadcastDownloadState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("download:state", downloadSnapshot());
}

function broadcastDownloadEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("download:event", event);
}

function itemToRunnerJson(item) {
  return {
    id: item.id,
    name: item.name,
    link_type: item.type,
    url: item.url,
    headers: item.headers,
    selected_url: item.selectedUrl,
    selected_quality: item.selectedQuality,
    output: item.output,
    workers: item.workers,
    overwrite: item.overwrite
  };
}

function parseJsonLines(text, onEvent) {
  const lines = text.split(/\r?\n/);
  const rest = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      onEvent(JSON.parse(trimmed));
    } catch {
      onEvent({ event: "log", message: trimmed });
    }
  }
  return rest;
}

// --- Downloader engine ---
function resolveEngine() {
  if (resolvedEngine?.ok) return resolvedEngine;
  if (app.isPackaged) {
    const ok = fs.existsSync(bundledEnginePath);
    resolvedEngine = {
      kind: "bundled",
      path: bundledEnginePath,
      command: bundledEnginePath,
      args: [],
      cwd: path.dirname(bundledEnginePath),
      ok,
      error: ok ? "" : `Downloader engine not found: ${bundledEnginePath}`
    };
    return resolvedEngine;
  }

  // Dev: python + hls2mp4_runner.py from engine/downloader (or VISUBLY_EXTRACTING_VIDEO_DIR).
  const python = resolvePython();
  const scriptOk = fs.existsSync(runnerScript);
  resolvedEngine = {
    kind: "python",
    path: runnerScript,
    command: python.command,
    args: [...python.args, runnerScript],
    cwd: devEngineDir,
    python: [python.command, ...python.args].join(" "),
    ok: scriptOk && python.ok,
    error: !scriptOk
      ? `Download runner not found: ${runnerScript}`
      : python.ok
        ? ""
        : "Python 3.10+ was not found. Install Python or set VISUBLY_PYTHON."
  };
  return resolvedEngine;
}

function resolvePython() {
  if (process.env.VISUBLY_PYTHON) return { command: process.env.VISUBLY_PYTHON, args: [], ok: true };
  const candidates =
    process.platform === "win32"
      ? [["py", ["-3"]], ["python", []], [legacyPythonPath, []]]
      : [["python3", []], ["python", []]];
  for (const [command, args] of candidates) {
    if (probePython(command, args)) return { command, args, ok: true };
  }
  return { command: process.platform === "win32" ? "python" : "python3", args: [], ok: false };
}

function probePython(command, args) {
  try {
    const result = spawnSync(command, [...args, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
      windowsHide: true,
      timeout: 10000,
      encoding: "utf8"
    });
    if (result.status !== 0) return false;
    const [major, minor] = String(result.stdout || "").trim().split(".").map(Number);
    return major === 3 && minor >= 10;
  } catch {
    return false;
  }
}

function spawnEngine(args, stdio) {
  const engine = resolveEngine();
  if (!engine.ok) throw new Error(engine.error || "Downloader engine is not available.");
  fs.mkdirSync(engineTempDir, { recursive: true });
  return spawn(engine.command, [...engine.args, ...args], {
    cwd: engine.cwd,
    windowsHide: true,
    stdio,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      // Keeps PyInstaller's _MEI extraction dirs in our own temp folder so stale ones can be cleaned safely.
      TEMP: engineTempDir,
      TMP: engineTempDir
    }
  });
}

function resolveFfmpegPath() {
  try {
    let binary = require("@ffmpeg-installer/ffmpeg").path;
    if (binary.includes("app.asar") && !binary.includes("app.asar.unpacked")) {
      binary = binary.replace("app.asar", "app.asar.unpacked");
    }
    return binary;
  } catch {
    return "";
  }
}

function pushFfmpegArg(args) {
  if (ffmpegPath && fs.existsSync(ffmpegPath)) args.push("--ffmpeg", ffmpegPath);
}

async function cleanupStaleEngineTemp() {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  let entries = [];
  try {
    entries = await fs.promises.readdir(engineTempDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("_MEI")) continue;
    const fullPath = path.join(engineTempDir, entry.name);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.mtimeMs < cutoff) await fs.promises.rm(fullPath, { recursive: true, force: true });
    } catch {
      // In use or already gone.
    }
  }
}

// --- Output paths ---
// fs.mkdirSync(<drive root>, { recursive: true }) throws EPERM on Windows even
// when the drive exists (e.g. "E:\"), so only create folders that are missing.
function ensureDirectory(dir) {
  try {
    if (fs.statSync(dir).isDirectory()) return;
  } catch {
    // Missing: create it below.
  }
  fs.mkdirSync(dir, { recursive: true });
}

function ensureDownloadDir() {
  const dir = settings.downloadDir || defaultDownloadDir({});
  try {
    ensureDirectory(dir);
  } catch (error) {
    throw new Error(`Download folder is not available: ${dir} (${error.message})`);
  }
  return dir;
}

function resolveDownloadOutput({ name = "", source = "", output = "", unique = true } = {}, excludeItemId = "") {
  let target = String(output || "").trim();
  if (!target || !path.isAbsolute(target)) {
    target = path.join(ensureDownloadDir(), `${safeOutputStem(name || nameFromSource(source))}.mp4`);
  } else if (!path.extname(target)) {
    target += ".mp4";
  }
  try {
    ensureDirectory(path.dirname(target));
  } catch (error) {
    throw new Error(`Download folder is not available: ${path.dirname(target)} (${error.message})`);
  }
  return unique ? uniqueOutputPath(target, excludeItemId) : target;
}

function uniqueOutputPath(target, excludeItemId = "") {
  const dir = path.dirname(target);
  const ext = path.extname(target) || ".mp4";
  const stem = path.basename(target, ext);
  const key = (value) => path.resolve(value).toLowerCase();
  const reserved = new Set(
    downloadQueue.items
      .filter((item) => item.id !== excludeItemId && item.output && item.status !== "done")
      .map((item) => key(item.output))
  );
  for (let index = 0; index < 10000; index += 1) {
    const candidate = path.join(dir, index ? `${stem} (${index})${ext}` : `${stem}${ext}`);
    if (!reserved.has(key(candidate)) && !fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem} ${Date.now()}${ext}`);
}

function safeOutputStem(value) {
  let stem = String(value || "")
    .normalize("NFC")
    .replace(/\.(mp4|m4v|mkv|mov|webm|ts)$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/_+/g, "_")
    .replace(/^[ ._]+|[ ._]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `${stem}_video`;
  return stem.slice(0, 100).replace(/[ .]+$/, "") || "video";
}

function nameFromSource(source) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(
    now.getMinutes()
  )}${pad(now.getSeconds())}`;
  const match = String(source || "").match(/https?:\/\/[^\s'"\\]+/i);
  if (!match) return `video_${stamp}`;
  try {
    const url = new URL(match[0]);
    const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    let stem = last.replace(/\.[^.]+$/, "");
    if (!stem || /^(index|master|playlist|manifest|chunklist.*|prog_index|main|video|media|stream|output)$/i.test(stem)) {
      stem = url.hostname.replace(/^www\./, "");
    }
    return `${stem}_${stamp}`;
  } catch {
    return `video_${stamp}`;
  }
}

function normalizeHeaderLines(headers) {
  if (!Array.isArray(headers)) return [];
  return headers
    .map((header) => String(header || "").replace(/[\r\n]+/g, " ").trim())
    .filter((header) => /^[A-Za-z0-9-]+\s*:/.test(header));
}

// --- Settings ---
function migrateLegacyQueue() {
  const result = { legacyFound: false, migrated: false };
  if (!legacyQueuePath || !fs.existsSync(legacyQueuePath)) return result;
  result.legacyFound = true;
  if (path.resolve(legacyQueuePath).toLowerCase() === path.resolve(downloadStatePath).toLowerCase()) return result;
  if (fs.existsSync(downloadStatePath)) return result;
  try {
    fs.copyFileSync(legacyQueuePath, downloadStatePath, fs.constants.COPYFILE_EXCL);
    result.migrated = true;
    logMain("info", `Copied legacy download queue from ${legacyQueuePath}`);
  } catch (error) {
    logMain("warn", `Legacy queue migration failed: ${error.message}`);
  }
  return result;
}

function defaultDownloadDir(legacy = {}) {
  // Keep this PC's existing behavior (downloads on E:\) when upgrading from the dev build.
  if ((legacy.legacyFound || legacy.migrated) && process.platform === "win32" && fs.existsSync("E:\\")) return "E:\\";
  let videos;
  try {
    videos = app.getPath("videos");
  } catch {
    videos = path.join(os.homedir(), "Videos");
  }
  return path.join(videos, "ViSUBLY");
}

function sanitizeSettings(input = {}, base = defaultSettings) {
  const next = { ...defaultSettings, ...base };
  const dir = typeof input.downloadDir === "string" ? input.downloadDir.trim() : "";
  if (dir && path.isAbsolute(dir)) next.downloadDir = path.normalize(dir);
  next.maxParallelDownloads = clampInt(input.maxParallelDownloads, 1, maxParallelDownloadProcesses, next.maxParallelDownloads);
  next.segmentWorkers = clampInt(input.segmentWorkers, 1, 32, next.segmentWorkers);
  if (typeof input.notifyOnComplete === "boolean") next.notifyOnComplete = input.notifyOnComplete;
  if (typeof input.captureBridgeEnabled === "boolean") next.captureBridgeEnabled = input.captureBridgeEnabled;
  next.captureBridgePort = clampInt(input.captureBridgePort, 1024, 65535, next.captureBridgePort);
  if (ignoreShortVideoChoices.has(Number(input.ignoreShortVideosSec))) next.ignoreShortVideosSec = Number(input.ignoreShortVideosSec);
  if (themeModes.has(input.theme)) next.theme = input.theme;
  if (typeof input.remoteAutoStart === "boolean") next.remoteAutoStart = input.remoteAutoStart;
  return next;
}

function loadSettings(legacy) {
  let stored = null;
  try {
    if (fs.existsSync(settingsPath)) stored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (error) {
    logMain("warn", `settings.json is unreadable; using defaults: ${error.message}`);
    try {
      fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
    } catch {
      // Best effort.
    }
  }
  const next = sanitizeSettings(stored && typeof stored === "object" ? stored : {}, defaultSettings);
  if (!next.downloadDir) next.downloadDir = defaultDownloadDir(legacy);
  if (!stored || JSON.stringify(stored) !== JSON.stringify(next)) writeSettingsFile(next);
  return next;
}

function writeSettingsFile(value) {
  try {
    const tempPath = `${settingsPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tempPath, settingsPath);
  } catch (error) {
    logMain("error", `Could not save settings: ${error.message}`);
  }
}

function applySettingsToQueue() {
  downloadQueue.parallelItems = normalizeDownloadParallel(settings.maxParallelDownloads);
  downloadQueue.localWorkers = settings.segmentWorkers;
}

async function updateSettings(partial = {}) {
  const previous = settings;
  const changes = partial && typeof partial === "object" ? partial : {};
  const next = sanitizeSettings({ ...previous, ...changes }, previous);
  if (next.downloadDir !== previous.downloadDir) {
    try {
      ensureDirectory(next.downloadDir);
    } catch (error) {
      throw new Error(`Cannot use download folder ${next.downloadDir}: ${error.message}`);
    }
  }
  settings = next;
  writeSettingsFile(next);
  applySettingsToQueue();
  if (next.theme !== previous.theme) {
    applyThemeSource();
    syncWindowBackground();
  }
  if (next.maxParallelDownloads > previous.maxParallelDownloads && downloadQueue.activeIds.size) pumpDownloadQueue();
  if (
    next.captureBridgeEnabled !== previous.captureBridgeEnabled ||
    next.captureBridgePort !== previous.captureBridgePort
  ) {
    await restartCaptureBridge();
  }
  sendToRenderer("settings:changed", { ...settings });
  broadcastDownloadState();
  return { ...settings };
}

function appInfo() {
  const engine = resolveEngine();
  return {
    version: app.getVersion(),
    dataDir: runtimeRoot,
    downloadDir: settings.downloadDir,
    engine: {
      kind: engine.kind,
      path: engine.path,
      ok: engine.ok,
      ...(engine.python ? { python: engine.python } : {}),
      ...(engine.error ? { error: engine.error } : {})
    },
    ffmpeg: { path: ffmpegPath, ok: Boolean(ffmpegPath) && fs.existsSync(ffmpegPath) },
    captureBridge: captureBridgeInfo()
  };
}

// --- Browser capture bridge ---
function loadCaptureBridgeFactory() {
  if (!fs.existsSync(captureBridgeModulePath)) {
    captureBridgeError = "Capture bridge module is not installed.";
    return null;
  }
  try {
    const { createCaptureBridge } = require("./capture-bridge");
    if (typeof createCaptureBridge !== "function") throw new Error("createCaptureBridge export is missing.");
    return createCaptureBridge;
  } catch (error) {
    captureBridgeError = `Capture bridge failed to load: ${error.message}`;
    logMain("error", captureBridgeError);
    return null;
  }
}

function startCaptureBridge() {
  captureBridgeTransition = captureBridgeTransition.then(async () => {
    if (!settings.captureBridgeEnabled || captureBridge) return;
    const createCaptureBridge = loadCaptureBridgeFactory();
    if (!createCaptureBridge) return;
    let bridge = null;
    try {
      bridge = createCaptureBridge({
        port: settings.captureBridgePort,
        dataDir: runtimePaths.userData,
        onCapture: handleCapturedMedia,
        onProbe: probeMedia,
        logger: captureBridgeLogger
      });
      const started = await bridge.start();
      captureBridge = bridge;
      captureBridgeError = "";
      logMain("info", `Capture bridge listening on port ${started?.port ?? settings.captureBridgePort}`);
    } catch (error) {
      captureBridgeError = `Capture bridge could not start: ${error.message}`;
      logMain("error", captureBridgeError);
      try {
        await bridge?.stop();
      } catch {
        // Ignore cleanup errors.
      }
    }
  });
  return captureBridgeTransition;
}

function stopCaptureBridge() {
  captureBridgeTransition = captureBridgeTransition.then(async () => {
    const bridge = captureBridge;
    captureBridge = null;
    if (!bridge) return;
    try {
      await bridge.stop();
    } catch (error) {
      logMain("warn", `Capture bridge stop failed: ${error.message}`);
    }
  });
  return captureBridgeTransition;
}

async function restartCaptureBridge() {
  await stopCaptureBridge();
  if (!settings.captureBridgeEnabled) captureBridgeError = "";
  await startCaptureBridge();
}

const captureBridgeLogger = {
  debug: (...args) => {
    if (!app.isPackaged) console.debug("[capture-bridge]", ...args);
  },
  info: (...args) => logMain("info", `[capture-bridge] ${args.join(" ")}`),
  warn: (...args) => logMain("warn", `[capture-bridge] ${args.join(" ")}`),
  error: (...args) => logMain("error", `[capture-bridge] ${args.join(" ")}`),
  log: (...args) => logMain("info", `[capture-bridge] ${args.join(" ")}`)
};

function captureBridgeUnavailableMessage() {
  if (!settings.captureBridgeEnabled) return "Browser capture is turned off in settings.";
  return captureBridgeError || "Browser capture bridge is not running.";
}

function captureBridgeInfo() {
  let info = { running: false, port: settings.captureBridgePort, pairedClients: 0 };
  if (captureBridge) {
    try {
      info = { ...info, ...captureBridge.info() };
    } catch (error) {
      info.error = error.message;
    }
  }
  return {
    ...info,
    enabled: settings.captureBridgeEnabled,
    available: fs.existsSync(captureBridgeModulePath),
    ...(captureBridgeError && !info.running ? { error: captureBridgeError } : {})
  };
}

const engineLinkTypes = { hls: "m3u8", dash: "dash", mp4: "mp4" };

// prepare args for a stream the extension saw, replaying the browser's referer/origin/UA/cookie.
function browserPrepareArgs({ url, type, headers, pageUrl = "", name }) {
  const h = headers && typeof headers === "object" ? headers : {};
  const extraHeaders = [];
  if (h.origin) extraHeaders.push(`Origin: ${h.origin}`);
  if (h.cookie) extraHeaders.push(`Cookie: ${h.cookie}`);
  return {
    source: url,
    type,
    name,
    referer: h.referer || pageUrl || undefined,
    ...(h.userAgent ? { userAgent: String(h.userAgent) } : {}),
    headers: extraHeaders,
    noPreflight: true
  };
}

// --- Stream probing for the extension (quality list, duration, preview detection) ---
const probeCacheTtlMs = 10 * 60 * 1000;
const probeTimeoutMs = 30000;
const maxConcurrentProbes = 2;
const maxProbeCacheEntries = 300;
const probeCache = new Map(); // url -> { at, result }
const probeInflight = new Map(); // url -> Promise<result>
const probeWaiters = [];
let activeProbes = 0;

async function probeMedia(payload = {}) {
  const url = String(payload.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "Only http(s) media URLs can be probed." };
  const type = engineLinkTypes[String(payload.type || "").toLowerCase()] || "m3u8";
  const cached = probeCache.get(url);
  let raw;
  if (cached && Date.now() - cached.at < probeCacheTtlMs) {
    raw = cached.result;
  } else {
    if (!probeInflight.has(url)) {
      const job = runProbe({ url, type, headers: payload.headers }).finally(() => probeInflight.delete(url));
      probeInflight.set(url, job);
    }
    raw = await probeInflight.get(url);
  }
  return withShortFlag(raw);
}

// isShort uses the current setting, so changing it applies to cached results too.
function withShortFlag(raw) {
  if (!raw.ok) return { ...raw };
  const limit = Number(settings.ignoreShortVideosSec) || 0;
  const isShort = !raw.isLive && limit > 0 && raw.durationSec > 0 && raw.durationSec < limit;
  return { ...raw, isShort };
}

async function runProbe({ url, type, headers }) {
  if (type === "mp4") {
    // Nothing to read without downloading the file; the extension judges mp4 by its size.
    return { ok: true, kind: "mp4", variants: [], durationSec: 0, isLive: false, renditions: [] };
  }
  await acquireProbeSlot();
  let result;
  try {
    const item = await prepareDownloadItem(
      {
        ...browserPrepareArgs({ url, type, headers, name: "probe" }),
        // Never touches the download folder: prepare only needs a syntactically valid output.
        output: path.join(engineTempDir, "probe.mp4"),
        overwrite: true
      },
      { timeoutMs: probeTimeoutMs }
    );
    const isLive = Boolean(item.isLive);
    const durationSec = isLive ? 0 : Math.round((Number(item.durationSec) || 0) * 10) / 10;
    const variants = (Array.isArray(item.variants) ? item.variants : [])
      .filter((variant) => variant && variant.url)
      .map((variant) => {
        const bandwidth = Math.max(0, Number(variant.bandwidth) || 0);
        const out = {
          url: String(variant.url),
          height: Math.max(0, Number(variant.height) || 0),
          resolution: String(variant.resolution || ""),
          bandwidth
        };
        if (bandwidth && durationSec) out.estBytes = Math.round((bandwidth * durationSec) / 8);
        return out;
      })
      .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
    result = {
      ok: true,
      kind: item.kind || (variants.length ? "master" : type === "dash" ? "dash" : "media"),
      variants,
      durationSec,
      isLive,
      renditions: item.renditions || []
    };
    probeCache.set(url, { at: Date.now(), result });
    if (probeCache.size > maxProbeCacheEntries) probeCache.delete(probeCache.keys().next().value);
  } catch (error) {
    // Failures are not cached: the next popup open may succeed (cookie refreshed, network back).
    result = { ok: false, error: String(error?.message || error).slice(0, 300) };
    logMain("warn", `Probe failed for ${hostFromUrl(url)}: ${result.error}`);
  } finally {
    releaseProbeSlot();
  }
  return result;
}

function acquireProbeSlot() {
  if (activeProbes < maxConcurrentProbes) {
    activeProbes += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => probeWaiters.push(resolve));
}

function releaseProbeSlot() {
  const next = probeWaiters.shift();
  if (next) next(); // hand the slot over directly
  else activeProbes = Math.max(0, activeProbes - 1);
}

async function handleCapturedMedia(payload = {}) {
  const url = String(payload.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: "Only http(s) media URLs can be captured." };
  prunePendingCaptures();

  const type = engineLinkTypes[String(payload.type || "").toLowerCase()] || "m3u8";
  const pageUrl = String(payload.pageUrl || "");
  const host = hostFromUrl(pageUrl) || hostFromUrl(url);
  const title = String(payload.pageTitle || "").trim();
  const name = safeOutputStem(title || host || "video");
  const prepareArgs = browserPrepareArgs({ url, type, headers: payload.headers, pageUrl, name });

  const captureId = randomUUID();
  const capture = {
    captureId,
    name,
    pageTitle: title,
    host,
    pageUrl,
    type,
    url,
    detectedAt: payload.detectedAt || new Date().toISOString(),
    receivedAt: Date.now(),
    prepareArgs,
    preparedItem: null,
    variants: [],
    preferredVariantUrl: /^https?:\/\//i.test(String(payload.preferredVariantUrl || "")) ? String(payload.preferredVariantUrl) : "",
    preferredHeight: clampInt(payload.preferredHeight, 0, 10000, 0),
    error: ""
  };
  try {
    capture.preparedItem = await prepareDownloadItem(prepareArgs);
    capture.variants = capture.preparedItem.variants || [];
  } catch (error) {
    capture.error = error.message;
    logMain("warn", `Capture prepare failed for ${host}: ${error.message}`);
  }
  capture.origin = "browser";
  pendingCaptures.set(captureId, capture);

  focusMainWindow();
  sendToRenderer("capture:incoming", capturePayload(capture));
  return { ok: true };
}

function capturePayload(capture) {
  return {
    captureId: capture.captureId,
    name: capture.name,
    pageTitle: capture.pageTitle || "",
    host: capture.host,
    pageUrl: capture.pageUrl,
    type: capture.type,
    origin: capture.origin || "browser",
    detectedAt: capture.detectedAt,
    variants: capture.variants,
    preparedItem: capture.preparedItem,
    durationSec: capture.preparedItem?.durationSec || 0,
    isLive: Boolean(capture.preparedItem?.isLive),
    preferredVariantUrl: capture.preferredVariantUrl || "",
    preferredHeight: capture.preferredHeight || 0,
    downloadDir: settings.downloadDir,
    ...(capture.error ? { error: capture.error } : {})
  };
}

async function confirmCapture(payload = {}) {
  const captureId = String(payload.captureId || "");
  const capture = pendingCaptures.get(captureId);
  if (!capture) return { ok: false, error: "This capture has expired or was already handled." };

  const name = safeOutputStem(String(payload.name || "").trim() || capture.name);
  const quality = String(payload.quality || "").trim();
  let prepared = capture.preparedItem;
  try {
    if (!prepared) {
      // The first prepare failed (e.g. network hiccup); try once more with the user's choices.
      prepared = await prepareDownloadItem({ ...capture.prepareArgs, name, ...(quality ? { quality } : {}) });
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const variant = pickVariant(prepared.variants, quality);
  const item = normalizeDownloadItem(
    {
      ...prepared,
      id: randomUUID(),
      name,
      output: "",
      status: "queued",
      phase: "queued",
      progress: 0,
      workers: settings.segmentWorkers,
      quality: (variant && qualityFromResolution(variant.resolution)) || quality || prepared.quality,
      ...(variant ? { selectedUrl: variant.url, selectedQuality: variant.resolution || null } : {})
    },
    { name }
  );
  try {
    item.output = resolveDownloadOutput({ name });
  } catch (error) {
    return { ok: false, error: error.message };
  }
  item.pageUrl = capture.pageUrl || "";
  item.host = capture.host || item.host;
  appendDownloadLog(
    item,
    capture.origin === "manual" ? "Added from a pasted link." : `Captured from ${capture.pageUrl || capture.host}.`
  );
  const added = addDownloadItem(item);
  pendingCaptures.delete(captureId);
  // "Thêm vào hàng đợi" passes start:false; the item then waits for the queue to run.
  if (payload.start !== false) pumpDownloadQueue();
  persistAndBroadcastDownloadState({ immediate: true });
  return { ok: true, item: added, state: downloadSnapshot() };
}

function pickVariant(variants, quality) {
  if (!Array.isArray(variants) || !variants.length || !quality) return null;
  const wanted = String(quality).toLowerCase();
  const wantedHeight = qualityFromResolution(qualityToResolution(wanted)) || wanted.replace(/p$/, "");
  return (
    variants.find((variant) => String(variant.resolution || "").toLowerCase() === wanted) ||
    variants.find((variant) => String(variant.url || "") === quality) ||
    variants.find((variant) => qualityFromResolution(variant.resolution) === wantedHeight) ||
    null
  );
}

function prunePendingCaptures() {
  const cutoff = Date.now() - pendingCaptureTtlMs;
  for (const [captureId, capture] of pendingCaptures) {
    if (capture.receivedAt < cutoff) pendingCaptures.delete(captureId);
  }
}

function qualityToResolution(quality) {
  const value = String(quality || "").toLowerCase();
  const map = {
    "2160": "3840x2160",
    "2160p": "3840x2160",
    "1440": "2560x1440",
    "1440p": "2560x1440",
    "1080": "1920x1080",
    "1080p": "1920x1080",
    "720": "1280x720",
    "720p": "1280x720",
    "480": "854x480",
    "480p": "854x480"
  };
  return map[value] || String(quality || "1920x1080");
}

function qualityFromResolution(resolution) {
  const value = String(resolution || "");
  if (value.includes("2160")) return "2160";
  if (value.includes("1440")) return "1440";
  if (value.includes("1080")) return "1080";
  if (value.includes("720")) return "720";
  if (value.includes("480")) return "480";
  return "";
}

function hostFromUrl(value) {
  try {
    return new URL(String(value || "")).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function safeFilePart(value) {
  const safe = String(value || "video")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[ ._]+|[ ._]+$/g, "");
  return safe.slice(0, 80) || "video";
}

function killProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  child.kill("SIGTERM");
}
