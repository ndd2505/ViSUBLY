const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const airplayServer = require("./airplay-server");

let mainWindow;

const runtimeRoot = process.env.VISUBLY_RUNTIME_DIR || path.join("D:\\", "Projects", "ViSUBLY", ".runtime");
const runtimePaths = {
  userData: path.join(runtimeRoot, "user-data"),
  sessionData: path.join(runtimeRoot, "session-data"),
  cache: path.join(runtimeRoot, "cache"),
  logs: path.join(runtimeRoot, "logs"),
  crashDumps: path.join(runtimeRoot, "crash-dumps"),
  temp: path.join(runtimeRoot, "temp")
};

const extractingVideoDir = process.env.VISUBLY_EXTRACTING_VIDEO_DIR || path.join("D:\\", "Projects", "Extracting Video");
const runnerScript = path.join(extractingVideoDir, "hls2mp4_runner.py");
const defaultPythonPath = path.join(
  "C:\\",
  "Users",
  "ADMIN",
  "AppData",
  "Local",
  "Programs",
  "Python",
  "Python312",
  "python.exe"
);
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
const downloadStatePath = path.join(runtimePaths.userData, "download-queue.json");
const downloadQueue = {
  items: [],
  activeIds: new Set(),
  processes: new Map(),
  parallelItems: 2,
  localWorkers: 8
};

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

loadDownloadQueue();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 720,
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    backgroundColor: "#f0eee9",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
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
    title: "Choose a video",
    properties: ["openFile"],
    filters: [
      { name: "Video files", extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v"] },
      { name: "All files", extensions: ["*"] }
    ]
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog:selectVideoFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a video folder",
    properties: ["openDirectory"]
  });

  if (result.canceled || !result.filePaths.length) return null;
  const folderData = await scanVideoFolder(result.filePaths[0]);
  airplayServer.setFolder(folderData);
  return folderData;
});

ipcMain.handle("dialog:selectSubtitle", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a subtitle file",
    properties: ["openFile"],
    filters: [
      { name: "Subtitle files", extensions: ["srt", "vtt"] },
      { name: "All files", extensions: ["*"] }
    ]
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("file:readText", async (_event, filePath) => {
  if (!filePath || typeof filePath !== "string") return "";
  return fs.promises.readFile(filePath, "utf8");
});

ipcMain.handle("media:toFileUrl", (_event, filePath) => {
  if (!filePath || typeof filePath !== "string") return "";
  return pathToFileURL(filePath).toString();
});

ipcMain.handle("media:scanVideoFolder", async (_event, folderPath) => {
  const result = await scanVideoFolder(folderPath);
  airplayServer.setFolder(result);
  return result;
});

// --- AirPlay API ---
ipcMain.handle("airplay:start", async () => {
  return await airplayServer.start();
});

ipcMain.handle("airplay:stop", async () => {
  airplayServer.stop();
  return { ok: true };
});

ipcMain.handle("airplay:info", async () => {
  return airplayServer.getServerInfo();
});

airplayServer.on("pairing_requested", (pin) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("airplay:pairing-requested", pin);
  }
});

airplayServer.on("pairing_success", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("airplay:pairing-success");
  }
});
// -------------------

ipcMain.handle("media:findMatchingSubtitle", async (_event, videoPath) => {
  if (!videoPath || typeof videoPath !== "string") return null;
  return findMatchingSubtitleFile(videoPath);
});

async function scanVideoFolder(folderPath) {
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
        folders.push(fullPath);
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

ipcMain.handle("download:start", async (_event, options = {}) => {
  if (Number.isFinite(Number(options.parallelItems))) {
    downloadQueue.parallelItems = Math.max(1, Math.min(6, Number(options.parallelItems)));
  }
  pumpDownloadQueue();
  persistAndBroadcastDownloadState();
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
  persistAndBroadcastDownloadState();
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
  persistAndBroadcastDownloadState();
  pumpDownloadQueue();
  return { ok: true, state: downloadSnapshot() };
});

ipcMain.handle("download:clearCompleted", async () => {
  downloadQueue.items = downloadQueue.items.filter((item) => !["done", "failed", "canceled"].includes(item.status));
  persistAndBroadcastDownloadState();
  return { ok: true, state: downloadSnapshot() };
});

async function prepareDownloadItem(payload) {
  const source = String(payload.source || payload.curl || payload.url || "").trim();
  if (!source && !payload.itemFile) throw new Error("Paste a URL or full curl command first.");

  const args = [
    "prepare",
    "--source-stdin",
    "--type",
    payload.type || "m3u8",
    "--target-quality",
    qualityToResolution(payload.quality || payload.targetQuality || "1080"),
    "--workers",
    String(Math.max(1, Number(payload.workers || downloadQueue.localWorkers || 8)))
  ];
  if (payload.name) args.push("-n", String(payload.name));
  if (payload.output) args.push("-o", String(payload.output));
  if (payload.referer) args.push("--referer", String(payload.referer));
  if (payload.userAgent !== undefined) args.push("--user-agent", String(payload.userAgent || ""));
  if (payload.selectedUrl) args.push("--selected-url", String(payload.selectedUrl));
  if (payload.selectedQuality) args.push("--selected-quality", String(payload.selectedQuality));
  if (payload.overwrite) args.push("--overwrite");
  if (payload.noPreflight) args.push("--no-preflight");

  const result = await runRunnerJson(args, source);
  const preparedEvent = [...result.events].reverse().find((event) => event.event === "prepared");
  if (!preparedEvent?.item) {
    const errorEvent = [...result.events].reverse().find((event) => event.event === "error");
    throw new Error(errorEvent?.message || "Download parser did not return a prepared item.");
  }
  const item = normalizeDownloadItem(preparedEvent.item, {
    name: String(payload.name || "").trim(),
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

function runRunnerJson(args, stdinText = "") {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(runnerScript)) {
      reject(new Error(`Download runner not found: ${runnerScript}`));
      return;
    }

    const child = spawn(resolvePython(), [runnerScript, ...args], {
      cwd: extractingVideoDir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const events = [];
    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuffer = parseJsonLines(stdoutBuffer + chunk.toString(), (event) => events.push(event));
    });
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      parseJsonLines(stdoutBuffer + "\n", (event) => events.push(event));
      if (code === 0) {
        resolve({ events });
        return;
      }
      const errorEvent = [...events].reverse().find((event) => event.event === "error");
      reject(new Error(errorEvent?.message || stderrBuffer.trim() || `Download runner exited with code ${code}.`));
    });
    child.stdin.end(stdinText || "");
  });
}

function startDownloadProcess(item) {
  if (!fs.existsSync(runnerScript)) {
    item.status = "failed";
    item.error = `Download runner not found: ${runnerScript}`;
    appendDownloadLog(item, item.error);
    persistAndBroadcastDownloadState();
    return;
  }

  const itemPath = path.join(runtimePaths.temp, `download-${item.id}.json`);
  const eventLogPath = path.join(runtimePaths.logs, `download-${safeFilePart(item.name)}-${item.id}.jsonl`);
  fs.writeFileSync(itemPath, JSON.stringify(itemToRunnerJson(item), null, 2), "utf8");

  const child = spawn(resolvePython(), [runnerScript, "download", "--item-file", itemPath, "--event-log-file", eventLogPath], {
    cwd: extractingVideoDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

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
      persistAndBroadcastDownloadState();
    }
  });
  child.on("error", (error) => {
    item.status = "failed";
    item.phase = "failed";
    item.error = error.message;
    appendDownloadLog(item, error.message);
    persistAndBroadcastDownloadState();
  });
  child.on("close", (code) => {
    parseJsonLines(stdoutBuffer + "\n", (event) => applyRunnerEvent(item.id, event));
    downloadQueue.activeIds.delete(item.id);
    downloadQueue.processes.delete(item.id);
    delete item.pid;
    if (item.status === "canceled" || item.cancelRequested) {
      item.status = "canceled";
      item.phase = "canceled";
      appendDownloadLog(item, "Runner stopped after cancel.");
    } else if (code === 0) {
      item.status = "done";
      item.phase = "done";
      item.progress = 100;
      appendDownloadLog(item, "Download completed.");
    } else {
      item.status = "failed";
      item.phase = "failed";
      item.error = item.error || `Runner exited with code ${code}.`;
      appendDownloadLog(item, item.error);
    }
    item.updatedAt = new Date().toISOString();
    persistAndBroadcastDownloadState();
    pumpDownloadQueue();
  });
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
    item.status = "done";
    item.phase = "done";
    item.progress = 100;
    item.output = event.output || item.output;
  } else if (event.event === "failed") {
    item.status = "failed";
    item.phase = "failed";
    item.error = item.error || `Runner failed with code ${event.exit_code ?? "unknown"}.`;
  }

  persistAndBroadcastDownloadState();
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
    host: hostFromUrl(url || selectedUrl),
    workers: Math.max(1, Number(raw.workers || overrides.workers || downloadQueue.localWorkers || 8)),
    overwrite: Boolean(raw.overwrite || overrides.overwrite),
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

function downloadSnapshot() {
  return {
    items: downloadQueue.items.map((item) => {
      const copy = { ...item };
      delete copy.cancelRequested;
      return copy;
    }),
    parallelItems: downloadQueue.parallelItems,
    localWorkers: downloadQueue.localWorkers,
    runnerPath: runnerScript
  };
}

function persistAndBroadcastDownloadState() {
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
    const data = JSON.parse(fs.readFileSync(downloadStatePath, "utf8"));
    downloadQueue.parallelItems = Math.max(1, Number(data.parallelItems || downloadQueue.parallelItems));
    downloadQueue.localWorkers = Math.max(1, Number(data.localWorkers || downloadQueue.localWorkers));
    downloadQueue.items = Array.isArray(data.items)
      ? data.items.map((item) => {
          const normalized = normalizeDownloadItem(item);
          if (["active", "preparing", "muxing"].includes(normalized.status)) {
            normalized.status = "queued";
            normalized.phase = "queued";
            normalized.progress = 0;
            appendDownloadLog(normalized, "Recovered from previous app session.");
          }
          return normalized;
        })
      : [];
  } catch {
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

function resolvePython() {
  if (process.env.VISUBLY_PYTHON) return process.env.VISUBLY_PYTHON;
  return fs.existsSync(defaultPythonPath) ? defaultPythonPath : "python";
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
