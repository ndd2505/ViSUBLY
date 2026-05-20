const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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

ipcMain.handle("media:findMatchingSubtitle", async (_event, videoPath) => {
  if (!videoPath || typeof videoPath !== "string") return null;
  const parsed = path.parse(videoPath);
  const suffixes = ["", ".vi", ".vie", ".vn", ".en", ".eng"];
  const extensions = [".srt", ".vtt"];

  for (const suffix of suffixes) {
    for (const extension of extensions) {
      const candidate = path.join(parsed.dir, `${parsed.name}${suffix}${extension}`);
      try {
        await fs.promises.access(candidate, fs.constants.R_OK);
        return candidate;
      } catch {
        // Keep looking through common subtitle naming variants.
      }
    }
  }

  return null;
});
