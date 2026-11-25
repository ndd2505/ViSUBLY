const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Returns an unsubscribe function, like the existing on* helpers.
const subscribe = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

// Theme + version are needed before the first paint (no light/dark flash, intro gating).
let bootInfo = { theme: "dark", resolvedTheme: "dark", version: "" };
try {
  bootInfo = { ...bootInfo, ...ipcRenderer.sendSync("app:bootInfoSync") };
} catch {
  // Defaults are fine; the renderer refreshes settings asynchronously.
}

const settingsApi = {
  get: () => ipcRenderer.invoke("settings:get"),
  update: (partial) => ipcRenderer.invoke("settings:update", partial),
  selectDownloadDir: () => ipcRenderer.invoke("settings:selectDownloadDir"),
  onChange: subscribe("settings:changed")
};

const captureApi = {
  onIncoming: subscribe("capture:incoming"),
  confirm: (payload) => ipcRenderer.invoke("capture:confirm", payload),
  dismiss: (captureId) => ipcRenderer.invoke("capture:dismiss", captureId),
  prepareManual: (source) => ipcRenderer.invoke("capture:prepareManual", { source }),
  createPairingCode: () => ipcRenderer.invoke("capture:createPairingCode"),
  info: () => ipcRenderer.invoke("capture:info"),
  revokeAll: () => ipcRenderer.invoke("capture:revokeAll")
};

const downloadApi = {
  getState: () => ipcRenderer.invoke("download:getState"),
  prepareItem: (payload) => ipcRenderer.invoke("download:prepare", payload),
  enqueueItems: (items) => ipcRenderer.invoke("download:enqueue", items),
  startQueue: (options) => ipcRenderer.invoke("download:start", options),
  cancelItem: (itemId) => ipcRenderer.invoke("download:cancel", itemId),
  retryItem: (itemId) => ipcRenderer.invoke("download:retry", itemId),
  removeItem: (itemId) => ipcRenderer.invoke("download:remove", itemId),
  clearCompleted: () => ipcRenderer.invoke("download:clearCompleted"),
  openOutput: (itemId) => ipcRenderer.invoke("download:openOutput", itemId),
  revealOutput: (itemId) => ipcRenderer.invoke("download:revealOutput", itemId),
  openDownloadDir: () => ipcRenderer.invoke("download:openDir"),
  onEvent: subscribe("download:event"),
  onState: subscribe("download:state")
};

contextBridge.exposeInMainWorld("visublyDesktop", {
  platform: process.platform,
  boot: bootInfo,
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
  close: () => ipcRenderer.invoke("window:close"),
  selectVideo: () => ipcRenderer.invoke("dialog:selectVideo"),
  selectVideoFolder: () => ipcRenderer.invoke("dialog:selectVideoFolder"),
  selectSubtitle: () => ipcRenderer.invoke("dialog:selectSubtitle"),
  readTextFile: (filePath) => ipcRenderer.invoke("file:readText", filePath),
  readSubtitleText: (filePath) => ipcRenderer.invoke("file:readSubtitleText", filePath),
  checkFiles: (paths) => ipcRenderer.invoke("file:exists", paths),
  openInSystemPlayer: (filePath) => ipcRenderer.invoke("media:openInSystemPlayer", filePath),
  toFileUrl: (filePath) => ipcRenderer.invoke("media:toFileUrl", filePath),
  scanVideoFolder: (folderPath, options) => ipcRenderer.invoke("media:scanVideoFolder", folderPath, options),
  scanVideoFolders: (folderPaths) => ipcRenderer.invoke("media:scanVideoFolders", folderPaths),
  // Dropped File -> absolute path (File.path is gone in newer Electron).
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  fileKinds: (paths) => ipcRenderer.invoke("file:kinds", paths),
  findMatchingSubtitle: (videoPath) => ipcRenderer.invoke("media:findMatchingSubtitle", videoPath),
  airplay: {
    start: () => ipcRenderer.invoke("airplay:start"),
    stop: () => ipcRenderer.invoke("airplay:stop"),
    info: () => ipcRenderer.invoke("airplay:info"),
    respondPairing: (requestId, allow) => ipcRenderer.invoke("airplay:respondPairing", { requestId, allow }),
    listDevices: () => ipcRenderer.invoke("airplay:listDevices"),
    revokeDevice: (id) => ipcRenderer.invoke("airplay:revokeDevice", id),
    revokeAllDevices: () => ipcRenderer.invoke("airplay:revokeAllDevices"),
    onPairingResolved: subscribe("airplay:pairing-resolved"),
    onDevicesChanged: subscribe("airplay:devices-changed"),
    onPairingRequested: subscribe("airplay:pairing-requested"),
    onPairingSuccess: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("airplay:pairing-success", listener);
      return () => ipcRenderer.removeListener("airplay:pairing-success", listener);
    },
    onPowerState: subscribe("airplay:power-state")
  },
  download: downloadApi,
  settings: settingsApi,
  video: {
    getEnhanceStatus: () => ipcRenderer.invoke("video:getEnhanceStatus"),
    setEnhance: (on) => ipcRenderer.invoke("video:setEnhance", on),
    reportStutter: (info) => ipcRenderer.invoke("video:reportStutter", info),
    onEnhanceChanged: subscribe("video:enhance-changed")
  },
  relaunch: () => ipcRenderer.invoke("app:relaunch"),
  app: {
    getInfo: () => ipcRenderer.invoke("app:getInfo"),
    diskSpace: () => ipcRenderer.invoke("app:diskSpace"),
    openExtensionFolder: () => ipcRenderer.invoke("app:openExtensionFolder"),
    // Files opened from Windows: pull the ones queued before boot, then listen for more.
    takeOpenFiles: () => ipcRenderer.invoke("app:takeOpenFiles"),
    onOpenFiles: subscribe("app:open-files")
  },
  capture: captureApi
});
