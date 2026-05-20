const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("visublyDesktop", {
  platform: process.platform,
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
  close: () => ipcRenderer.invoke("window:close"),
  selectVideo: () => ipcRenderer.invoke("dialog:selectVideo"),
  selectSubtitle: () => ipcRenderer.invoke("dialog:selectSubtitle"),
  readTextFile: (filePath) => ipcRenderer.invoke("file:readText", filePath),
  toFileUrl: (filePath) => ipcRenderer.invoke("media:toFileUrl", filePath),
  findMatchingSubtitle: (videoPath) => ipcRenderer.invoke("media:findMatchingSubtitle", videoPath),
  integrations: {
    startDownloadBatch: async (items) => ({ ok: true, items }),
    generateSubtitle: async (payload) => ({ ok: true, payload })
  }
});
