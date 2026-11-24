const { contextBridge, ipcRenderer } = require("electron");

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
  scanVideoFolder: (folderPath) => ipcRenderer.invoke("media:scanVideoFolder", folderPath),
  findMatchingSubtitle: (videoPath) => ipcRenderer.invoke("media:findMatchingSubtitle", videoPath),
  airplay: {
    start: () => ipcRenderer.invoke("airplay:start"),
    stop: () => ipcRenderer.invoke("airplay:stop"),
    info: () => ipcRenderer.invoke("airplay:info"),
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
  app: {
    getInfo: () => ipcRenderer.invoke("app:getInfo"),
    diskSpace: () => ipcRenderer.invoke("app:diskSpace"),
    openExtensionFolder: () => ipcRenderer.invoke("app:openExtensionFolder")
  },
  capture: captureApi
});
