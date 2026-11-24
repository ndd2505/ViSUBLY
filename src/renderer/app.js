"use strict";

const noopSubscribe = () => () => {};
const desktopOnly = async () => ({ ok: false, error: "Tính năng này chỉ có trong ứng dụng ViSUBLY." });

// Plain-browser fallback (no Electron preload): every screen still renders and
// actions report that they need the desktop app. No fake data.
const desktop = window.visublyDesktop || {
  platform: navigator.platform.toLowerCase().includes("mac") ? "darwin" : "win32",
  boot: { theme: "dark", resolvedTheme: "dark", version: "" },
  minimize: () => {},
  toggleMaximize: () => {},
  close: () => {},
  selectVideo: async () => null,
  selectVideoFolder: async () => null,
  selectSubtitle: async () => null,
  readSubtitleText: async () => "",
  checkFiles: async () => ({}),
  openInSystemPlayer: desktopOnly,
  toFileUrl: async (filePath) => localPathToFileUrl(filePath),
  scanVideoFolder: async () => null,
  findMatchingSubtitle: async () => null,
  airplay: {
    start: async () => {
      throw new Error("Remote chỉ chạy trong ứng dụng ViSUBLY.");
    },
    stop: async () => ({ ok: true }),
    info: async () => null,
    onPairingRequested: noopSubscribe,
    onPairingSuccess: noopSubscribe,
    onPowerState: noopSubscribe
  },
  download: {
    getState: async () => ({ items: [], parallelItems: 2, downloadDir: "" }),
    enqueueItems: desktopOnly,
    startQueue: desktopOnly,
    cancelItem: desktopOnly,
    retryItem: desktopOnly,
    removeItem: desktopOnly,
    clearCompleted: desktopOnly,
    openOutput: desktopOnly,
    revealOutput: desktopOnly,
    openDownloadDir: desktopOnly,
    onEvent: noopSubscribe,
    onState: noopSubscribe
  },
  settings: {
    get: async () => null,
    update: async () => null,
    selectDownloadDir: async () => ({ canceled: true }),
    onChange: noopSubscribe
  },
  app: {
    getInfo: async () => null,
    diskSpace: async () => null,
    openExtensionFolder: desktopOnly
  },
  capture: {
    onIncoming: noopSubscribe,
    confirm: desktopOnly,
    dismiss: async () => ({ ok: true }),
    prepareManual: desktopOnly,
    createPairingCode: desktopOnly,
    info: async () => null,
    revokeAll: desktopOnly
  }
};

const root = document.getElementById("app-root");
const folderPageSize = 120;
const playerControlsIdleMs = 2500;
const playerPrefsKey = "visubly.player.prefs";
const recentKey = "visubly.recent.v1";
const introKey = "visubly.intro.seenVersion";
const maxRecentEntries = 12;
const recentSaveIntervalMs = 5000;
const chromePollMs = 4000;
const introDurationMs = 1200;
const activeStatuses = new Set(["active", "preparing", "muxing"]);
const screenTitles = {
  home: "Trang chủ",
  download: "Tải xuống",
  folder: "Thư viện",
  player: "Trình phát",
  settings: "Cài đặt"
};
const systemDarkQuery = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

const state = {
  screen: "home",
  intro: false,
  theme: { mode: "dark", resolved: "dark" },
  info: null,
  settings: null,
  chrome: { known: false, running: false, pairedClients: 0, error: "" },
  disk: null,
  download: {
    items: [],
    parallelItems: 2,
    downloadDir: "",
    filter: "all",
    expandedLogId: "",
    actionError: ""
  },
  paste: { home: "", download: "", busy: "", error: "", errorFor: "" },
  capture: { queue: [], handled: 0, name: "", quality: "", busy: false, error: "" },
  pairing: { code: "", expiresAt: 0, loading: false, error: "", confirmRevoke: false, notice: "" },
  recent: [],
  player: {
    videoPath: "",
    videoUrl: "",
    displayName: "",
    srtPath: "",
    cues: [],
    subtitleNotice: "",
    mediaError: null,
    sourceToken: 0,
    currentTime: 0,
    resumeAt: 0,
    duration: 0,
    playing: false,
    theater: false,
    fullscreen: false,
    muted: false,
    volume: 0.8,
    lastVolume: 0.8,
    activeCueIndex: -1,
    subtitleOn: true,
    folderContext: null,
    style: {
      fontSize: 19,
      bottom: 58,
      background: false,
      outline: true
    }
  },
  folder: {
    path: "",
    name: "",
    videos: [],
    visibleLimit: folderPageSize,
    renderReady: true,
    scanning: false,
    error: "",
    scannedAt: "",
    skippedFolders: 0,
    truncated: false,
    pendingScrollPath: ""
  },
  remote: {
    qrUrl: null,
    testUrl: null,
    loading: false,
    pairingPin: null,
    pairingActive: false,
    awake: false,
    awakeReason: ""
  }
};

let folderThumbTimer = null;
let folderRenderTimer = null;
let downloadRenderTimer = null;
let playerControlsIdleTimer = null;
let playerControlsHidden = false;
let playerScrubbing = false;
let playerScrubFrame = 0;
let playerScrubPendingTime = null;
let playerKeyboardModality = false;
let playerLastPointer = { x: -1, y: -1 };
let playerFolderCenteredPath = "";
let reuseMainPlayerVideo = false;
let lastRenderedScreen = "";
let lastRenderedModalKey = "";
let folderThumbActive = 0;
let folderThumbQueue = [];
const maxFolderThumbLoads = 1;
let introTimer = null;
let pairingTimer = null;
let chromePollTimer = null;
let toastTimer = null;
let lastRecentSaveAt = 0;
let dialogFocusedFor = "";
let dialogReturnFocus = "";

const iconPaths = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
  library: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  player: '<path d="M7 5l12 7-12 7z"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  subtitleAi: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 10h10M7 14h4M13 14h4"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  video: '<path d="M4 6h11v12H4z"/><path d="m15 10 5-3v10l-5-3z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/>',
  retry: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4.6h4.6"/>',
  arrowL: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15 9.5a4 4 0 0 1 0 5"/><path d="M18 7a8 8 0 0 1 0 10"/>',
  volumeOff: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 5"/><path d="m21 9-5 5"/>',
  captions: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 12h4"/><path d="M13 12h4"/><path d="M7 15h7"/>',
  theater: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 6v12"/><path d="M17 6v12"/><path d="M7 10h10"/><path d="M7 14h10"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  fullscreenExit: '<path d="M9 3v4a2 2 0 0 1-2 2H3"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/><path d="M9 21v-4a2 2 0 0 0-2-2H3"/><path d="M15 21v-4a2 2 0 0 1 2-2h4"/>',
  pause: '<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>',
  rewind: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4.6h4.6"/>',
  forward: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.5v4.6h-4.6"/>',
  skipPrev: '<path d="M6 5v14"/><path d="M19 5 9 12l10 7z"/>',
  skipNext: '<path d="M18 5v14"/><path d="M5 5l10 7-10 7z"/>'
};

function icon(name, options = {}) {
  const size = options.size || 18;
  const stroke = options.stroke || 2.2;
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name] || iconPaths.home}</svg>`;
}

function playGlyph(size = 18) {
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z"/></svg>`;
}

function btn(label, action, classes = "", iconName = "", attrs = "") {
  const iconHtml = iconName ? icon(iconName) : "";
  return `<button type="button" class="btn ${classes}" data-action="${action}" ${attrs}>${iconHtml}<span>${label}</span></button>`;
}

function setScreen(screen) {
  if (!screenTitles[screen]) return;
  if (state.screen === "player" && screen !== "player") suspendMainPlayerForNavigation();
  if (screen === "folder" && !state.folder.visibleLimit) state.folder.visibleLimit = folderPageSize;
  if (screen === "folder") {
    state.folder.renderReady = false;
    scheduleFolderRender();
  } else {
    cancelFolderRender();
  }
  state.screen = screen;
  if (screen === "download") refreshDiskSpace();
  if (screen === "settings") {
    state.pairing.confirmRevoke = false;
    refreshAppInfo();
    ensurePairingCode();
  }
  if (screen === "home") refreshRecent();
  render();
}

function updateDocumentTitle() {
  const title = `ViSUBLY · ${screenTitles[state.screen] || screenTitles.home}`;
  if (document.title !== title) document.title = title;
}

function render(options = {}) {
  updateDocumentTitle();
  // While the player stage is fullscreen, replacing root.innerHTML would remove the
  // fullscreen element and kick the user out of fullscreen. Patch the stage instead.
  if (renderPlayerWhileFullscreen()) return;

  const sameScreen = state.screen === lastRenderedScreen;
  const samePlayerScreen = sameScreen && state.screen === "player";
  const preserveScroll = options.preserveScroll ?? sameScreen;
  const scrollSnapshot = preserveScroll ? captureScrollSnapshot() : [];
  const focusSnapshot = captureFocus();
  const folderListMemory = samePlayerScreen ? capturePlayerFolderListScroll() : null;
  // Keep the playing <video> element alive across re-renders: re-inserting it in the
  // same task keeps decoding/playback going instead of reloading the file.
  const keptVideo = takeReusableMainPlayerVideo();
  reuseMainPlayerVideo = Boolean(keptVideo);
  const dialogOpen = Boolean(modalKey());
  let html = "";
  try {
    html = `
    <div class="shell">
      ${renderTitlebar()}
      <div class="app" ${dialogOpen ? "inert" : ""}>
        ${renderSidebar()}
        <main class="main">${renderScreen()}</main>
      </div>
      ${renderCaptureDialog()}
      ${renderRemoteModal()}
      ${state.intro ? renderIntro() : ""}
    </div>
  `;
  } finally {
    reuseMainPlayerVideo = false;
  }
  root.innerHTML = html;
  if (keptVideo) root.querySelector("[data-main-video-slot]")?.replaceWith(keptVideo);
  lastRenderedScreen = state.screen;
  lastRenderedModalKey = modalKey();
  attachDynamicHandlers({ folderListMemory });
  if (scrollSnapshot.length) restoreScrollSnapshot(scrollSnapshot, { immediate: sameScreen });
  restoreFocus(focusSnapshot);
}

// Full re-renders replace every node, so remember which control had focus (and the caret).
function captureFocus() {
  const element = document.activeElement;
  if (!element || element === document.body || !root.contains(element)) return null;
  if (element.closest("[data-player-stage]")) return null;
  const selector = focusSelector(element);
  if (!selector) return null;
  const snapshot = { selector };
  if (typeof element.selectionStart === "number") {
    snapshot.start = element.selectionStart;
    snapshot.end = element.selectionEnd;
  }
  return snapshot;
}

function focusSelector(element) {
  if (!element || element === document.body) return "";
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts = [];
  for (const attr of ["data-screen", "data-action", "data-id", "data-value", "data-path"]) {
    const value = element.getAttribute(attr);
    if (value !== null) parts.push(`[${attr}="${CSS.escape(value)}"]`);
  }
  return parts.join("");
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const next = root.querySelector(snapshot.selector);
  if (!next || next === document.activeElement || next.disabled) return;
  if (next.closest("[inert]")) return;
  next.focus({ preventScroll: true });
  if (typeof snapshot.start === "number" && typeof next.setSelectionRange === "function") {
    try {
      next.setSelectionRange(snapshot.start, snapshot.end);
    } catch {
      // Some input types do not support selection ranges.
    }
  }
}

function modalKey() {
  const capture = state.capture.queue[0];
  if (capture) return `capture:${capture.captureId}`;
  if (state.remote.pairingActive && state.remote.pairingPin) return `pin:${state.remote.pairingPin}`;
  if (state.remote.qrUrl || state.remote.loading) return "qr";
  return "";
}

function takeReusableMainPlayerVideo() {
  if (state.screen !== "player" || !state.player.videoUrl) return null;
  const video = document.getElementById("mainPlayerVideo");
  if (!video) return null;
  if (video.dataset.sourceToken !== String(state.player.sourceToken)) return null;
  if (video.dataset.videoUrl !== state.player.videoUrl) return null;
  return video;
}

function renderPlayerWhileFullscreen() {
  if (state.screen !== "player" || !isPlayerStageFullscreen()) return false;
  const key = modalKey();
  if (key && key !== lastRenderedModalKey) {
    // A dialog (capture, pairing PIN, QR) must be visible: leave fullscreen, the
    // fullscreenchange handler then runs the full render.
    exitDocumentFullscreen().catch(() => {});
  }
  patchPlayerStage();
  return true;
}

function captureScrollSnapshot() {
  const selectors = [".main", ".screen", ".player-transcript", ".folder-screen", ".dl-log"];
  return selectors
    .map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      return { selector, left: element.scrollLeft, top: element.scrollTop };
    })
    .filter(Boolean);
}

function restoreScrollSnapshot(snapshot, options = {}) {
  const apply = () => {
    snapshot.forEach(({ selector, left, top }) => {
      const element = document.querySelector(selector);
      if (!element) return;
      element.scrollLeft = left;
      element.scrollTop = top;
    });
  };
  // Same-screen renders restore synchronously so the page never flashes to the top.
  if (options.immediate) apply();
  window.requestAnimationFrame(apply);
}

function scheduleFolderRender() {
  cancelFolderRender();
  folderRenderTimer = window.setTimeout(() => {
    folderRenderTimer = null;
    if (state.screen !== "folder") return;
    state.folder.renderReady = true;
    render();
  }, 80);
}

function cancelFolderRender() {
  if (!folderRenderTimer) return;
  window.clearTimeout(folderRenderTimer);
  folderRenderTimer = null;
}

function renderTitlebar() {
  const isMac = desktop.platform === "darwin";
  return `
    <header class="titlebar ${isMac ? "is-mac" : ""}">
      ${isMac ? `
        <div class="traffic-controls">
          <button type="button" class="traffic-dot red" data-action="close" aria-label="Đóng"></button>
          <button type="button" class="traffic-dot yellow" data-action="minimize" aria-label="Thu nhỏ"></button>
          <button type="button" class="traffic-dot green" data-action="maximize" aria-label="Phóng to"></button>
        </div>
      ` : ""}
      <span class="titlebar-title">ViSUBLY · ${escapeHtml(screenTitles[state.screen] || screenTitles.home)}</span>
      ${isMac ? "" : `
        <div class="window-controls">
          <button type="button" class="window-btn" data-action="minimize" aria-label="Thu nhỏ" title="Thu nhỏ"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" stroke="currentColor" stroke-width="1.2"/></svg></button>
          <button type="button" class="window-btn" data-action="maximize" aria-label="Phóng to" title="Phóng to"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></button>
          <button type="button" class="window-btn close" data-action="close" aria-label="Đóng" title="Đóng"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" stroke-width="1.2"/></svg></button>
        </div>
      `}
    </header>
  `;
}

function renderSidebar() {
  const pending = state.download.items.filter((item) => item.status === "queued" || activeStatuses.has(item.status)).length;
  const version = state.info?.version || desktop.boot?.version || "";
  return `
    <aside class="sidebar" data-sidebar>
      <div class="brand">
        <img class="brand-logo" src="./assets/brand/visubly-logo-small.svg" width="32" height="32" alt="">
        <span class="brand-word">ViSUBLY</span>
        ${version ? `<span class="version-pill" title="Phiên bản ${escapeAttr(version)}">${escapeHtml(version)}</span>` : ""}
      </div>
      <nav class="nav" aria-label="Điều hướng">
        ${navItem("home", "Trang chủ", "home")}
        ${navItem("download", "Tải xuống", "download", pending)}
        ${navItem("folder", "Thư viện", "library")}
        ${navItem("player", "Trình phát", "player")}
        <button type="button" class="nav-item is-soon" disabled aria-disabled="true">
          ${icon("subtitleAi", { size: 20, stroke: 2 })}
          <span>Phụ đề AI</span>
          <span class="soon-badge">Sắp có</span>
        </button>
        <div class="nav-divider" role="separator"></div>
        ${navItem("settings", "Cài đặt", "sliders")}
      </nav>
      ${renderChromeCard()}
    </aside>
  `;
}

function navItem(screen, label, iconName, count = 0) {
  const active = state.screen === screen;
  return `
    <button type="button" class="nav-item ${active ? "active" : ""}" data-screen="${screen}" ${active ? 'aria-current="page"' : ""}>
      ${icon(iconName, { size: 20, stroke: 2 })}
      <span>${label}</span>
      ${count ? `<span class="nav-count" aria-label="${count} video đang chờ">${count}</span>` : ""}
    </button>
  `;
}

function chromeConnected() {
  return Boolean(state.chrome.running && state.chrome.pairedClients > 0);
}

function renderChromeCard() {
  const connected = chromeConnected();
  return `
    <div class="side-card" data-chrome-card>
      <div class="side-card-status"><span class="status-dot ${connected ? "is-ok" : "is-off"}"></span>${connected ? "Chrome đã kết nối" : "Chưa kết nối Chrome"}</div>
      <div class="side-card-text">${connected
        ? "Bấm “Tải bằng ViSUBLY” ngay trên video đang xem."
        : `Ghép nối tiện ích Chrome trong <button type="button" class="text-link" data-screen="settings">Cài đặt</button> để tải video bằng một nút bấm.`}</div>
      <button type="button" class="btn secondary side-card-btn" data-action="start-remote">${icon("phone", { size: 16, stroke: 2 })}<span>Remote iPhone</span></button>
    </div>
  `;
}

function renderScreen() {
  if (state.screen === "download") return renderDownload();
  if (state.screen === "player") return renderPlayerStudio();
  if (state.screen === "folder") return renderFolderPlayer();
  if (state.screen === "settings") return renderSettings();
  return renderHome();
}

// ---------- Home ----------
function renderHome() {
  const counts = downloadCounts();
  const active = state.download.items.filter((item) => activeStatuses.has(item.status)).slice(0, 2);
  const recent = state.recent.slice(0, 3);
  return `
    <section class="screen home-screen">
      <header class="page-head">
        <div class="eyebrow">GRAB · SUB · WATCH</div>
        <h1 class="h1 display">Hôm nay xem gì?</h1>
      </header>
      ${renderPasteBar("home")}
      <div class="stat-grid">
        ${statCard("Đang tải", counts.active)}
        ${statCard("Trong hàng đợi", counts.queued)}
        ${statCard("Xong hôm nay", counts.doneToday)}
      </div>
      <div class="home-grid">
        <section class="card home-card">
          <div class="card-head">
            <h2 class="h2">Đang tải</h2>
            <button type="button" class="text-link" data-screen="download">Xem tất cả</button>
          </div>
          ${active.length
            ? active.map(renderHomeDownload).join("")
            : `<p class="empty-text">${counts.queued ? `Không có video nào đang tải. ${counts.queued} video đang chờ trong hàng đợi.` : "Không có video nào đang tải. Dán link ở trên để bắt đầu."}</p>`}
        </section>
        <section class="card home-card">
          <div class="card-head">
            <h2 class="h2">Xem tiếp</h2>
            <button type="button" class="text-link" data-screen="folder">Mở thư viện</button>
          </div>
          ${recent.length
            ? `<div class="recent-list">${recent.map(renderRecentRow).join("")}</div>`
            : `<p class="empty-text">Chưa có video nào. Video bạn mở trong Trình phát sẽ hiện ở đây để xem tiếp.</p>`}
        </section>
      </div>
      ${renderSoonCard("Phụ đề tiếng Việt bằng AI", "Đang hoàn thiện. Trong lúc chờ, bạn vẫn nạp được file .srt ở Trình phát.", true)}
    </section>
  `;
}

function statCard(label, value) {
  return `<div class="card stat-card"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></div>`;
}

function renderSoonCard(title, text, withIcon) {
  return `
    <section class="soon-card">
      ${withIcon ? `<span class="soon-icon">${icon("subtitleAi", { size: 22, stroke: 2 })}</span>` : ""}
      <div class="soon-copy">
        <div class="soon-title"><strong>${title}</strong><span class="soon-badge">Sắp có</span></div>
        <span>${text}</span>
      </div>
    </section>
  `;
}

function renderHomeDownload(item) {
  const muxing = item.status === "muxing";
  const preparing = item.status === "preparing";
  const percent = progressPercent(item);
  const right = muxing
    ? `<span class="row-status is-warn">Đang ghép MP4</span>`
    : preparing
      ? `<span class="row-status">Đang kiểm tra link</span>`
      : `<span class="row-status">${percent}%</span>`;
  const sub = muxing ? [qualityText(item), "gần xong"] : [qualityText(item), item.speed, etaLong(item.eta)];
  return `
    <div class="home-dl">
      <div class="home-dl-top"><strong title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</strong>${right}</div>
      ${progressBar(muxing ? 100 : percent, muxing ? "is-warn" : "")}
      <div class="home-dl-sub">${escapeHtml(sub.filter(Boolean).join(" · ") || "Đang tải")}</div>
    </div>
  `;
}

function renderRecentRow(entry) {
  const duration = Number(entry.duration) || 0;
  const position = Number(entry.position) || 0;
  const watched = position > 5;
  const finished = duration > 0 && position >= duration - 10;
  const sub = finished
    ? `Đã xem hết · ${formatClock(duration)}`
    : watched
      ? `Đã xem ${formatClock(position)} / ${formatClock(duration)}`
      : `Chưa xem · ${formatClock(duration)}`;
  const percent = duration ? Math.min(100, (position / duration) * 100) : 0;
  return `
    <button type="button" class="recent-row" data-action="open-recent" data-path="${escapeAttr(entry.path)}" title="${escapeAttr(entry.path)}">
      <span class="thumb recent-thumb">${playGlyph(18)}${watched ? `<span class="recent-progress" style="width:${percent.toFixed(1)}%"></span>` : ""}</span>
      <span class="recent-text"><strong>${escapeHtml(stripVideoExtension(entry.name || pathBaseName(entry.path)))}</strong><span>${escapeHtml(sub)}</span></span>
    </button>
  `;
}

function renderPasteBar(where) {
  const isHome = where === "home";
  const id = isHome ? "homePaste" : "dlPaste";
  const busy = state.paste.busy === where;
  const error = state.paste.errorFor === where ? state.paste.error : "";
  const label = busy
    ? `<span class="spinner" aria-hidden="true"></span><span>Đang đọc link…</span>`
    : isHome
      ? `${icon("download")}<span>Tải video</span>`
      : `<span>Thêm</span>`;
  return `
    <div class="paste-wrap">
      <form class="paste-bar ${isHome ? "is-large" : ""}" data-paste-form="${where}" novalidate>
        <label for="${id}" class="paste-field">
          ${icon("link")}
          <span class="sr-only">Link video hoặc lệnh cURL</span>
          <input id="${id}" type="text" data-bind="paste.${where}" value="${escapeAttr(state.paste[where])}" placeholder="${isHome ? "Dán link video (.m3u8, .mp4) hoặc lệnh cURL…" : "Dán link video hoặc lệnh cURL rồi nhấn Enter"}" autocomplete="off" spellcheck="false" ${busy ? 'readonly aria-busy="true"' : ""}>
        </label>
        <button type="submit" class="btn primary paste-submit" ${busy ? "disabled" : ""}>${label}</button>
      </form>
      ${error
        ? `<div class="inline-error" role="alert">${escapeHtml(error)}</div>`
        : isHome
          ? `<div class="paste-hint">Trên Chrome, bấm <strong>Tải bằng ViSUBLY</strong> ngay trên video, không cần copy link.</div>`
          : ""}
    </div>
  `;
}

function progressBar(percent, classes = "") {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  return `<div class="progress ${classes}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(value)}"><div class="progress-fill" style="width:${value}%"></div></div>`;
}

// ---------- Downloads ----------
function renderDownload() {
  const d = state.download;
  const counts = downloadCounts();
  const filters = [
    ["all", "Tất cả", counts.all],
    ["active", "Đang tải", counts.active],
    ["queued", "Hàng đợi", counts.queued],
    ["done", "Xong", counts.done],
    ["failed", "Lỗi", counts.failed]
  ];
  const items = filteredDownloadItems();
  const dir = currentDownloadDir();
  const parallel = state.settings?.maxParallelDownloads || d.parallelItems || 2;
  const idleQueue = counts.queued > 0 && counts.active === 0;
  return `
    <section class="screen downloads-screen">
      <header class="page-head is-row">
        <div class="page-titles">
          <h1 class="h1">Tải xuống</h1>
          <p class="page-sub">${dir ? `Lưu vào ${escapeHtml(dir)} · ` : ""}tải tối đa ${parallel} video cùng lúc</p>
        </div>
        <div class="head-actions">
          ${idleQueue ? `<button type="button" class="btn primary" data-action="start-queue">${icon("download")}<span>Tải hàng đợi</span></button>` : ""}
          <button type="button" class="btn outline" data-action="open-download-dir">${icon("library", { size: 16, stroke: 2 })}<span>Mở thư mục</span></button>
          <button type="button" class="btn outline" data-action="clear-finished-downloads" ${counts.done ? "" : "disabled"}>Xóa mục đã xong</button>
        </div>
      </header>
      ${renderPasteBar("download")}
      ${d.actionError ? `<div class="inline-error" role="alert">${escapeHtml(d.actionError)}</div>` : ""}
      <div class="filter-pills" role="group" aria-label="Lọc danh sách tải">
        ${filters.map(([key, label, count]) => `<button type="button" class="pill ${d.filter === key ? "is-on" : ""}" data-action="filter-downloads" data-value="${key}" aria-pressed="${d.filter === key}">${label} · ${count}</button>`).join("")}
      </div>
      <div class="card dl-list">
        <div class="dl-list-inner">
          ${items.length ? items.map((item) => renderDownloadRow(item)).join("") : renderDownloadEmpty(counts)}
        </div>
      </div>
      ${renderDownloadFooter()}
    </section>
  `;
}

function renderDownloadEmpty(counts) {
  const text = counts.all
    ? "Không có mục nào trong nhóm này."
    : "Chưa có video nào. Dán link ở trên, hoặc bấm Tải bằng ViSUBLY trên Chrome.";
  return `<div class="dl-empty">${icon("download", { size: 22, stroke: 2 })}<span>${text}</span></div>`;
}

function renderDownloadRow(item) {
  const status = item.status;
  const isActive = activeStatuses.has(status);
  const isQueued = status === "queued";
  const isDone = status === "done";
  const isFailed = status === "failed";
  const isCanceled = status === "canceled";
  const percent = progressPercent(item);
  const failure = isFailed ? describeItemFailure(item) : null;
  let statusText = "";
  let statusClass = "";
  if (status === "muxing") {
    statusText = "Đang ghép thành MP4…";
    statusClass = "is-warn";
  } else if (status === "preparing") {
    statusText = "Đang kiểm tra link…";
  } else if (status === "active") {
    statusText = [`${percent}%`, item.speed, etaShort(item.eta)].filter(Boolean).join(" · ");
  } else if (isQueued) {
    statusText = `Chờ · vị trí ${queuePosition(item)}`;
  } else if (isDone) {
    statusText = item.finishedAt ? `Xong · ${formatTimeOfDay(item.finishedAt)}` : "Xong";
    statusClass = "is-ok";
  } else if (isFailed) {
    statusText = failure.code;
    statusClass = "is-danger";
  } else if (isCanceled) {
    statusText = "Đã hủy";
  }

  const metaParts = isDone
    ? [item.output, qualityText(item), sizeText(item)]
    : [item.host, qualityText(item), sizeText(item)];
  const meta = isFailed
    ? `<span class="row-meta is-danger">${escapeHtml(failure.message)}</span>`
    : `<span class="row-meta" title="${escapeAttr(isDone ? item.output || "" : item.pageUrl || item.url || "")}">${escapeHtml(metaParts.filter(Boolean).join(" · "))}</span>`;
  const bar = isActive ? progressBar(status === "muxing" ? 100 : percent, status === "muxing" ? "is-warn" : "") : isQueued ? progressBar(0) : "";
  const logOpen = state.download.expandedLogId === item.id;

  let actions = "";
  if (isActive || isQueued) {
    actions = `<button type="button" class="icon-btn" data-action="cancel-download" data-id="${escapeAttr(item.id)}" aria-label="Hủy" title="Hủy">${icon("x", { size: 16 })}</button>`;
  } else if (isDone) {
    actions = `
      <button type="button" class="btn primary" data-action="play-download" data-id="${escapeAttr(item.id)}">${playGlyph(14)}<span>Xem</span></button>
      <button type="button" class="icon-btn" data-action="reveal-download-output" data-id="${escapeAttr(item.id)}" aria-label="Mở thư mục chứa file" title="Mở thư mục chứa file">${icon("folder", { size: 16, stroke: 2 })}</button>
    `;
  } else if (isFailed || isCanceled) {
    actions = `
      <button type="button" class="btn secondary" data-action="retry-download" data-id="${escapeAttr(item.id)}">Thử lại</button>
      <button type="button" class="btn ghost" data-action="toggle-download-log" data-id="${escapeAttr(item.id)}" aria-expanded="${logOpen}">${logOpen ? "Ẩn log" : "Xem log"}</button>
      <button type="button" class="icon-btn ghost" data-action="remove-download" data-id="${escapeAttr(item.id)}" aria-label="Xóa khỏi danh sách" title="Xóa khỏi danh sách">${icon("x", { size: 16 })}</button>
    `;
  }

  const logs = Array.isArray(item.logs) ? item.logs : [];
  return `
    <div class="dl-row ${logOpen ? "has-log" : ""}" data-download-row="${escapeAttr(item.id)}">
      <div class="dl-row-main">
        <span class="thumb dl-thumb ${isDone ? "is-done" : ""}">${isDone ? playGlyph(20) : `<span class="type-badge">${escapeHtml(typeLabel(item.type))}</span>`}</span>
        <div class="dl-info">
          <div class="dl-top"><strong title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</strong><span class="row-status ${statusClass}">${escapeHtml(statusText)}</span></div>
          ${bar}
          ${meta}
        </div>
        <div class="dl-actions">${actions}</div>
      </div>
      ${logOpen ? `<pre class="dl-log" tabindex="0" aria-label="Log tải của ${escapeAttr(item.name)}">${escapeHtml([item.error ? `Lỗi: ${item.error}` : "", ...logs].filter(Boolean).join("\n") || "Chưa có log.")}</pre>` : ""}
    </div>
  `;
}

function renderDownloadFooter() {
  const connected = chromeConnected();
  const info = state.info;
  let engine = `<span>Đang kiểm tra trình tải…</span>`;
  if (info) {
    if (!info.engine?.ok) engine = `<span class="is-danger" title="${escapeAttr(info.engine?.error || "")}">Trình tải chưa sẵn sàng</span>`;
    else if (!info.ffmpeg?.ok) engine = `<span class="is-danger">Thiếu ffmpeg</span>`;
    else engine = `<span>Trình tải sẵn sàng</span>`;
  }
  const disk = state.disk?.ok ? `<span>Còn trống ${escapeHtml(formatBytes(state.disk.free) || "0 B")} trên ${escapeHtml(state.disk.root)}</span>` : "";
  return `
    <footer class="dl-footer">
      <span class="footer-status"><span class="status-dot ${connected ? "is-ok" : "is-off"}"></span>${connected ? "Chrome đã kết nối" : "Chưa kết nối Chrome"}</span>
      ${engine}
      ${disk}
    </footer>
  `;
}

// ---------- "Tải video này?" dialog ----------
function renderCaptureDialog() {
  const capture = state.capture.queue[0];
  if (!capture) return "";
  const c = state.capture;
  const total = c.handled + c.queue.length;
  const variants = sortedVariants(capture.variants);
  const fromChrome = capture.origin !== "manual";
  const failure = capture.error ? describeFailure(capture.error) : null;
  const dir = currentDownloadDir();
  const sourceMeta = [capture.host, typeLabel(capture.type), variants.length ? `${variants.length} chất lượng` : ""].filter(Boolean).join(" · ");
  const duration = Number(capture.preparedItem?.estimatedDuration) || 0;
  return `
    <div class="dialog-overlay">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="capTitle" data-capture-dialog>
        <div class="dialog-head">
          <div class="dialog-titles">
            <div class="dialog-tags">
              <span class="tag-accent">${fromChrome ? "TỪ CHROME" : "TỪ LINK DÁN"}</span>
              ${total > 1 ? `<span class="tag-count" aria-label="Video ${c.handled + 1} trên ${total}">${c.handled + 1}/${total}</span>` : ""}
            </div>
            <h2 id="capTitle" class="dialog-title">Tải video này?</h2>
          </div>
          <button type="button" class="icon-btn filled" data-action="capture-skip" aria-label="Đóng" title="Đóng (Esc)">${icon("x", { size: 16 })}</button>
        </div>
        <div class="source-card">
          <span class="thumb source-thumb">${playGlyph(18)}</span>
          <div class="source-text">
            <strong title="${escapeAttr(capture.pageUrl || "")}">${escapeHtml(capture.pageTitle || capture.name || "Video")}</strong>
            <span>${escapeHtml(sourceMeta)}</span>
          </div>
        </div>
        ${failure ? `<div class="note is-danger" role="alert"><strong>${escapeHtml(failure.code)}.</strong> ${escapeHtml(failure.message)} Bạn vẫn có thể bấm Tải để ViSUBLY thử lại.</div>` : ""}
        <div class="field">
          <label for="capName">Tên file</label>
          <input id="capName" class="input" type="text" data-bind="capture.name" value="${escapeAttr(c.name)}" autocomplete="off" spellcheck="false" ${c.busy ? "readonly" : ""}>
        </div>
        ${variants.length ? `
          <fieldset class="quality-field">
            <legend>Chất lượng</legend>
            <div class="quality-grid" style="--quality-cols:${Math.min(4, variants.length)}">
              ${variants.map((variant) => renderQualityChip(variant, variants, duration)).join("")}
            </div>
          </fieldset>
        ` : ""}
        <div class="save-row">
          <span class="save-dir">Lưu vào <strong title="${escapeAttr(dir)}">${escapeHtml(dir || "thư mục mặc định")}</strong></span>
          <button type="button" class="btn outline small" data-action="change-download-dir" ${c.busy ? "disabled" : ""}>Đổi thư mục</button>
        </div>
        ${c.error ? `<div class="inline-error" role="alert">${escapeHtml(c.error)}</div>` : ""}
        <div class="dialog-actions">
          <button type="button" class="btn ghost" data-action="capture-skip" ${c.busy ? "disabled" : ""}>Bỏ qua</button>
          <button type="button" class="btn secondary" data-action="capture-queue" ${c.busy ? "disabled" : ""}>Thêm vào hàng đợi</button>
          <button type="button" class="btn primary" data-action="capture-now" ${c.busy ? "disabled" : ""}>${c.busy ? '<span class="spinner" aria-hidden="true"></span>' : icon("download", { size: 16 })}<span>Tải ngay</span></button>
        </div>
      </section>
    </div>
  `;
}

function renderQualityChip(variant, all, duration) {
  const key = variantKey(variant);
  const selected = state.capture.quality === key;
  const height = Number(variant.height) || 0;
  const label = height ? `${height}p` : String(variant.resolution || "Gốc");
  const bandwidth = Number(variant.bandwidth) || 0;
  const sameHeight = all.filter((other) => (Number(other.height) || 0) === height).length > 1;
  let sub = String(variant.resolution || "").replace("x", "×");
  if (bandwidth && duration) sub = `~${formatBytes((bandwidth * duration) / 8)}`;
  else if (sameHeight && bandwidth) sub = `${(bandwidth / 1e6).toFixed(1)} Mbps`;
  return `
    <button type="button" class="quality-chip ${selected ? "is-on" : ""}" data-action="pick-quality" data-value="${escapeAttr(key)}" aria-pressed="${selected}">
      <strong>${escapeHtml(label)}</strong>
      ${sub && sub !== label ? `<span>${escapeHtml(sub)}</span>` : ""}
    </button>
  `;
}

// ---------- Settings ----------
function renderSettings() {
  const s = state.settings || {};
  const mode = s.theme || state.theme.mode;
  const info = state.info;
  const parallel = Number(s.maxParallelDownloads) || state.download.parallelItems || 2;
  const notify = s.notifyOnComplete !== false;
  const dir = currentDownloadDir();
  return `
    <section class="screen settings-screen">
      <h1 class="h1">Cài đặt</h1>
      <div class="settings-grid">
        <div class="settings-col">
          <section class="card settings-card">
            <h2 class="h2">Giao diện</h2>
            <div class="segmented is-wide" role="group" aria-label="Giao diện">
              ${segButton("set-theme", "dark", "Tối", mode === "dark")}
              ${segButton("set-theme", "light", "Sáng", mode === "light")}
              ${segButton("set-theme", "system", "Theo Windows", mode === "system")}
            </div>
          </section>

          <section class="card settings-card">
            <h2 class="h2">Tải xuống</h2>
            <div class="setting-row">
              <div class="setting-text"><span class="setting-label">Thư mục lưu</span><span class="setting-mono" title="${escapeAttr(dir)}">${escapeHtml(dir || "Chưa chọn")}</span></div>
              <button type="button" class="btn secondary" data-action="change-download-dir">Đổi…</button>
            </div>
            <div class="setting-row">
              <span class="setting-label" id="parallelLabel">Tải cùng lúc</span>
              <div class="segmented is-compact" role="group" aria-labelledby="parallelLabel">
                ${[1, 2, 3].map((value) => segButton("set-parallel", String(value), String(value), parallel === value)).join("")}
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-text"><span class="setting-label">Thông báo khi tải xong</span><span class="setting-hint">Hiện thông báo Windows khi một video tải xong</span></div>
              <button type="button" class="switch ${notify ? "is-on" : ""}" role="switch" aria-checked="${notify}" aria-label="Thông báo khi tải xong" data-action="toggle-notify"><span class="switch-knob"></span></button>
            </div>
          </section>

          <section class="card settings-card is-tight">
            <h2 class="h2">Giới thiệu</h2>
            ${kvRow("Phiên bản", `<span class="mono-text">${escapeHtml(info?.version || desktop.boot?.version || "—")}</span>`)}
            ${kvRow("Dữ liệu app", `<span class="mono-text" title="${escapeAttr(info?.dataDir || "")}">${escapeHtml(info?.dataDir || "—")}</span>`)}
            ${kvRow("Trình tải video", readinessText(info ? info.engine?.ok : null, info?.engine?.error))}
            ${kvRow("ffmpeg", readinessText(info ? info.ffmpeg?.ok : null))}
          </section>
        </div>

        <div class="settings-col">
          ${renderChromeSettings()}
          <section class="card settings-card is-row">
            <div class="setting-text">
              <h2 class="h2">Remote iPhone</h2>
              <span class="setting-hint">Quét mã QR để điều khiển và xem video từ điện thoại qua Wi-Fi.</span>
            </div>
            <button type="button" class="btn secondary" data-action="start-remote">Bật Remote</button>
          </section>
          <section class="soon-card is-column">
            <div class="soon-title"><h2 class="h2">Phụ đề AI</h2><span class="soon-badge">Sắp có</span></div>
            <span>Whisper, Claude và ChatGPT sẽ được cấu hình ở đây.</span>
          </section>
        </div>
      </div>
    </section>
  `;
}

function renderChromeSettings() {
  const chrome = state.chrome;
  const pairing = state.pairing;
  let status;
  if (!chrome.known) status = `<span class="conn-status">Đang kiểm tra…</span>`;
  else if (!chrome.running) status = `<span class="conn-status is-danger" title="${escapeAttr(chrome.error || "")}"><span class="status-dot is-danger"></span>Cầu nối chưa chạy</span>`;
  else if (chrome.pairedClients > 0) status = `<span class="conn-status is-ok"><span class="status-dot is-ok"></span>${chrome.pairedClients} trình duyệt đã ghép nối</span>`;
  else status = `<span class="conn-status"><span class="status-dot is-off"></span>Chưa ghép nối</span>`;

  const secondsLeft = pairing.code ? Math.max(0, (pairing.expiresAt - Date.now()) / 1000) : 0;
  let codeBox;
  if (pairing.loading) {
    codeBox = `<span class="code-label">Mã ghép nối</span><span class="pair-code is-muted">··· ···</span><span class="code-label">Đang tạo mã…</span>`;
  } else if (pairing.code && secondsLeft > 0) {
    codeBox = `<span class="code-label">Mã ghép nối</span><span class="pair-code" aria-label="Mã ghép nối ${escapeAttr(pairing.code.split("").join(" "))}">${escapeHtml(formatPairingCode(pairing.code))}</span><span class="code-label" data-pair-countdown aria-live="off">Hết hạn sau ${formatClock(secondsLeft)}</span>`;
  } else {
    codeBox = `<span class="code-label">Mã ghép nối</span><span class="pair-code is-muted">— — —</span><span class="code-label ${pairing.error ? "is-danger" : ""}">${escapeHtml(pairing.error || "Mã đã hết hạn. Bấm Tạo mã mới.")}</span>`;
  }

  return `
    <section class="card settings-card is-featured">
      <div class="card-head">
        <h2 class="h2">Kết nối Chrome</h2>
        ${status}
      </div>
      <div class="code-box">${codeBox}</div>
      <ol class="steps">
        <li>Mở <strong>chrome://extensions</strong>, bật <strong>Developer mode</strong>, bấm <strong>Load unpacked</strong> và chọn thư mục extension.</li>
        <li>Bấm biểu tượng ViSUBLY trên thanh Chrome, nhập mã ở trên.</li>
        <li>Mở trang có video, bấm phát rồi bấm <strong>Tải bằng ViSUBLY</strong>.</li>
      </ol>
      ${pairing.notice ? `<div class="note" role="status">${escapeHtml(pairing.notice)}</div>` : ""}
      <div class="btn-row">
        <button type="button" class="btn primary" data-action="open-extension-folder">Mở thư mục extension</button>
        <button type="button" class="btn secondary" data-action="new-pairing-code" ${pairing.loading ? "disabled" : ""}>Tạo mã mới</button>
        ${pairing.confirmRevoke
          ? `<span class="confirm-inline" role="group" aria-label="Xác nhận hủy ghép nối">
              <button type="button" class="btn danger" data-action="confirm-revoke">Hủy ghép nối</button>
              <button type="button" class="btn ghost" data-action="cancel-revoke">Thôi</button>
            </span>`
          : `<button type="button" class="btn danger-text" data-action="ask-revoke">Hủy mọi ghép nối</button>`}
      </div>
    </section>
  `;
}

function segButton(action, value, label, pressed) {
  return `<button type="button" class="seg-btn ${pressed ? "is-on" : ""}" data-action="${action}" data-value="${escapeAttr(value)}" aria-pressed="${pressed}">${escapeHtml(label)}</button>`;
}

function kvRow(label, valueHtml) {
  return `<div class="kv-row"><span class="kv-label">${label}</span>${valueHtml}</div>`;
}

function readinessText(ok, error = "") {
  if (ok === null || ok === undefined) return `<span class="muted">Đang kiểm tra…</span>`;
  return ok ? `<span class="is-ok">Sẵn sàng</span>` : `<span class="is-danger" title="${escapeAttr(error || "")}">Chưa sẵn sàng</span>`;
}

// ---------- Intro + modals ----------
function renderIntro() {
  return `
    <div class="intro" data-intro data-action="dismiss-intro">
      <div class="intro-inner">
        <img class="intro-logo" src="./assets/brand/visubly-logo.svg" width="112" height="112" alt="">
        <div class="intro-word">ViSUBLY</div>
        <div class="intro-tag">GRAB · SUB · WATCH</div>
      </div>
      <div class="intro-skip">Bấm để bỏ qua</div>
    </div>
  `;
}

function renderRemoteModal() {
  if (state.capture.queue.length) return "";
  if (state.remote.pairingActive && state.remote.pairingPin) {
    return `
      <div class="dialog-overlay">
        <section class="dialog is-narrow is-center" role="dialog" aria-modal="true" aria-labelledby="pinTitle">
          <span class="dialog-icon">${icon("phone", { size: 26, stroke: 2 })}</span>
          <h2 id="pinTitle" class="dialog-title">Yêu cầu ghép nối</h2>
          <p class="dialog-text">Nhập mã PIN sau trên điện thoại của bạn:</p>
          <div class="pin-code">${escapeHtml(state.remote.pairingPin)}</div>
          <div class="dialog-actions is-center">${btn("Đóng", "close-remote", "secondary")}</div>
        </section>
      </div>
    `;
  }

  if (!state.remote.qrUrl && !state.remote.loading) return "";
  return `
    <div class="dialog-overlay">
      <section class="dialog is-narrow is-center" role="dialog" aria-modal="true" aria-labelledby="remoteTitle">
        <h2 id="remoteTitle" class="dialog-title">Remote iPhone</h2>
        <p class="dialog-text">Quét mã QR bằng camera iPhone để điều khiển và xem video qua Wi-Fi.</p>
        ${state.remote.loading
          ? `<div class="qr-box is-loading"><span class="spinner" aria-hidden="true"></span><span>Đang bật…</span></div>`
          : `<img class="qr-box" src="${escapeAttr(state.remote.qrUrl)}" alt="Mã QR để mở Remote trên điện thoại" width="232" height="232">`}
        <p class="dialog-note">${state.remote.awake ? "Máy tính đang được giữ thức để phát video; màn hình vẫn có thể tắt." : "Khi phát qua Remote, máy tính được giữ thức; màn hình vẫn có thể tắt."}</p>
        <div class="dialog-actions is-center">
          ${state.remote.loading ? "" : btn("Sao chép link", "copy-remote-link", "secondary")}
          ${btn("Đóng", "close-remote", "primary")}
        </div>
      </section>
    </div>
  `;
}


function playerViewModel() {
  const p = state.player;
  const fullscreen = isPlayerStageFullscreen();
  p.fullscreen = fullscreen;
  const hasVideo = Boolean(p.videoUrl);
  const folderIndex = currentFolderVideoIndex();
  return {
    p,
    hasVideo,
    fullscreen,
    overlay: hasVideo && (fullscreen || p.theater),
    hasSubtitles: hasRealSubtitleTrack(),
    videoName: p.displayName || (p.videoPath ? pathBaseName(p.videoPath) : "Chưa chọn video"),
    srtName: p.srtPath ? pathBaseName(p.srtPath) : "",
    folderIndex,
    folderCount: state.folder.videos.length,
    showFolderPanel: folderIndex >= 0 && !p.theater && !fullscreen,
    showFolderRail: folderIndex >= 0
  };
}

function renderPlayerStudio() {
  const m = playerViewModel();
  const p = m.p;
  const cues = m.hasSubtitles ? p.cues : [];
  const layoutClasses = [
    "player-layout",
    m.hasSubtitles && !m.showFolderPanel ? "" : "no-transcript",
    m.showFolderPanel ? "has-folder-panel" : "",
    p.theater ? "theater" : ""
  ].filter(Boolean).join(" ");

  return `
    <section class="screen player-screen ${p.theater ? "is-theater" : ""}">
      <div class="top-row">
        <h1 class="h1">Trình phát</h1>
        <div class="top-actions">
          ${m.folderIndex >= 0 ? btn("Về thư viện", "back-to-folder-context", "outline", "arrowL") : ""}
          ${m.folderIndex >= 0 ? `<span class="player-now-playing" title="${escapeAttr(m.videoName)}"><span>Đang phát</span><strong>${escapeHtml(m.videoName)}</strong></span>` : ""}
          ${btn("Chọn video", "choose-video", "primary", "folder")}
          ${btn("Nạp phụ đề", "choose-srt", "secondary", "captions")}
        </div>
      </div>
      <div class="${layoutClasses}">
        <div class="player-workbench" data-player-workbench>
          ${renderPlayerStage(m)}

          ${renderPlayerMediaSummary(m.videoName, m.srtName, m.hasSubtitles, m.showFolderPanel)}

          ${m.hasSubtitles ? `<div class="player-style-panel">
            <div>
              <div class="eyebrow">KIỂU PHỤ ĐỀ</div>
              <h3 class="h3">Hiển thị phụ đề</h3>
            </div>
            <div class="style-actions">
              ${btn(p.subtitleOn ? "Phụ đề: bật" : "Phụ đề: tắt", "subtitle-toggle", p.subtitleOn ? "lime" : "", "captions")}
              ${btn(p.style.background ? "Nền: bật" : "Nền: tắt", "subtitle-bg", p.style.background ? "lime" : "")}
              ${btn(p.style.outline ? "Viền: bật" : "Viền: tắt", "subtitle-outline", p.style.outline ? "lime" : "")}
              ${btn("A-", "subtitle-size-down", "", "minus")}
              ${btn("A+", "subtitle-size-up", "", "plus")}
              ${btn("Hạ xuống", "subtitle-bottom-down", "")}
              ${btn("Nâng lên", "subtitle-bottom-up", "")}
            </div>
          </div>` : ""}
        </div>
        ${m.showFolderPanel ? renderPlayerFolderSidebar(m.folderIndex) : ""}
        ${m.hasSubtitles && !m.showFolderPanel ? `<aside class="player-transcript">
          <div class="mini-row" style="justify-content:space-between">
            <h3 class="h3">Lời thoại</h3>
            <span class="count-badge">${cues.length} câu</span>
          </div>
          <div class="queue-list">
            ${cues.map((cue, index) => `
              <button class="subtitle-line transcript-line ${isCueActive(cue, p.currentTime) ? "active" : ""}" data-action="seek-cue" data-time="${cue.start}" data-cue-index="${index}" data-cue-start="${cue.start}" data-cue-end="${cue.end}">
                <div class="mono muted">${formatClock(cue.start)} · ${formatClock(cue.end)}</div>
                <strong>${escapeHtml(cue.text)}</strong>
              </button>
            `).join("")}
          </div>
        </aside>` : ""}
      </div>
    </section>
  `;
}

function playerStageClasses(m) {
  return [
    "player-stage",
    m.overlay ? "is-overlay" : "",
    m.fullscreen ? "is-fullscreen" : "",
    // Re-renders must not pop the hidden overlay bar back up mid-playback.
    m.overlay && playerControlsHidden && m.p.playing ? "is-controls-idle" : ""
  ].filter(Boolean).join(" ");
}

function playerFrameClasses(m) {
  return ["player-frame", m.hasVideo ? "has-video" : ""].filter(Boolean).join(" ");
}

// The stage is the fullscreen target: video frame + overlays + control bar only.
function renderPlayerStage(m) {
  return `
    <div class="${playerStageClasses(m)}" data-player-stage>
      <div class="${playerFrameClasses(m)}" data-player-drop>
        ${renderPlayerVideoElement(m)}
        ${renderPlayerFrameLayer(m)}
      </div>
      ${renderPlayerConsole(m)}
    </div>
  `;
}

function renderPlayerVideoElement(m) {
  const p = m.p;
  if (!m.hasVideo) {
    return `
      <div class="player-empty">
        <span class="play-dot">${icon("play")}</span>
        <h3 class="h3">Chọn video để xem</h3>
        <div class="player-empty-text">Kéo thả file video vào đây để phát, hoặc thả file .srt để nạp phụ đề.</div>
      </div>
    `;
  }
  if (reuseMainPlayerVideo) return `<span data-main-video-slot hidden></span>`;
  return `<video id="mainPlayerVideo" class="main-player-video" src="${escapeAttr(p.videoUrl)}" data-source-token="${p.sourceToken}" data-video-url="${escapeAttr(p.videoUrl)}" playsinline preload="metadata"></video>`;
}

function renderPlayerFrameLayer(m) {
  const p = m.p;
  const subtitleText = m.hasSubtitles ? activeSubtitleText(p.currentTime) : "";
  const overlayClasses = [
    "subtitle-overlay",
    "visubly-subtitle",
    p.style.background ? "with-bg" : "",
    p.style.outline ? "with-outline" : "",
    subtitleText ? "" : "is-empty"
  ].filter(Boolean).join(" ");
  const overlayStyle = `--subtitle-font-size:${p.style.fontSize}px;--subtitle-bottom:${p.style.bottom}px`;
  const titleLabel = m.folderIndex >= 0 ? `Đang phát · ${m.folderIndex + 1}/${m.folderCount}` : "Đang phát";

  return `
    <div class="player-frame-layer" data-player-layer>
      ${m.hasVideo ? `<div class="player-frame-title" title="${escapeAttr(m.videoName)}"><span>${escapeHtml(titleLabel)}</span><strong>${escapeHtml(m.videoName)}</strong></div>` : ""}
      ${m.hasSubtitles && p.subtitleOn ? `<div class="${overlayClasses}" style="${overlayStyle}"><span class="main-subtitle-text">${escapeHtml(subtitleText)}</span></div>` : ""}
      ${m.hasVideo && p.mediaError ? renderPlayerMediaError(m) : ""}
      ${m.showFolderRail ? renderPlayerFolderRail(m.folderIndex) : ""}
    </div>
  `;
}

function playerControlButton(action, iconName, label, options = {}) {
  const classes = ["btn", "icon", options.className || ""].filter(Boolean).join(" ");
  const pressed = typeof options.pressed === "boolean" ? ` aria-pressed="${options.pressed ? "true" : "false"}"` : "";
  return `<button class="${classes}" type="button" data-action="${action}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}"${pressed} ${options.disabled ? "disabled" : ""}>${icon(iconName)}</button>`;
}

function renderPlayerConsole(m) {
  const p = m.p;
  const noVideo = !m.hasVideo;
  const visibleVolume = p.muted ? 0 : p.volume;
  const progress = p.duration ? Math.min(100, Math.max(0, (p.currentTime / p.duration) * 100)) : 0;
  const inFolder = m.folderIndex >= 0;
  const hasPrev = inFolder && m.folderIndex > 0;
  const hasNext = inFolder && m.folderIndex < m.folderCount - 1;
  const fullscreenLabel = m.fullscreen ? "Thoát toàn màn hình (F)" : "Toàn màn hình (F)";
  const theaterLabel = p.theater ? "Thoát chế độ rạp (T)" : "Chế độ rạp (T)";

  return `
    <div class="player-console" data-player-console role="group" aria-label="Điều khiển trình phát">
      <div class="player-transport">
        ${inFolder ? playerControlButton("player-prev", "skipPrev", "Video trước (Shift+P)", { disabled: !hasPrev }) : ""}
        ${playerControlButton("seek-back", "rewind", "Lùi 5 giây (←)", { disabled: noVideo })}
        ${playerControlButton("toggle-player", p.playing ? "pause" : "play", p.playing ? "Tạm dừng (Space)" : "Phát (Space)", { disabled: noVideo, className: "primary player-play" })}
        ${playerControlButton("seek-forward", "forward", "Tới 5 giây (→)", { disabled: noVideo })}
        ${inFolder ? playerControlButton("player-next", "skipNext", "Video tiếp (Shift+N)", { disabled: !hasNext }) : ""}
      </div>
      <div class="volume-control">
        ${playerControlButton("toggle-mute", p.muted ? "volumeOff" : "volume", p.muted ? "Bật tiếng (M)" : "Tắt tiếng (M)", { disabled: noVideo, pressed: p.muted, className: p.muted ? "danger" : "" })}
        <input class="volume-slider" data-volume-slider type="range" min="0" max="1" step="0.01" value="${visibleVolume}" style="--volume-level:${visibleVolume * 100}%" aria-label="Âm lượng" aria-valuetext="${Math.round(visibleVolume * 100)}%" ${noVideo ? "disabled" : ""}>
        <span class="volume-value mono">${Math.round(visibleVolume * 100)}%</span>
      </div>
      <div class="player-scrubber" data-player-scrubber role="slider" tabindex="${noVideo ? "-1" : "0"}" aria-label="Tua video" aria-valuemin="0" aria-valuemax="${Math.round(p.duration || 0)}" aria-valuenow="${Math.round(p.currentTime || 0)}" aria-valuetext="${formatClock(p.currentTime)} trên ${formatClock(p.duration)}">
        <div class="player-scrubber-fill" data-player-scrubber-fill style="width:${progress}%"></div>
        <span class="player-scrubber-tooltip mono" data-player-scrubber-tooltip>${formatHoverClock(p.currentTime)}</span>
      </div>
      <span class="player-time mono">${formatClock(p.currentTime)} / ${formatClock(p.duration)}</span>
      <div class="player-view-actions">
        ${m.hasSubtitles ? playerControlButton("subtitle-toggle", "captions", p.subtitleOn ? "Ẩn phụ đề" : "Hiện phụ đề", { pressed: p.subtitleOn, className: p.subtitleOn ? "lime" : "" }) : ""}
        ${m.fullscreen ? "" : playerControlButton("toggle-theater", "theater", theaterLabel, { disabled: noVideo, pressed: p.theater, className: p.theater ? "lime" : "" })}
        ${playerControlButton("toggle-fullscreen", m.fullscreen ? "fullscreenExit" : "fullscreen", fullscreenLabel, { disabled: noVideo, pressed: m.fullscreen, className: m.fullscreen ? "lime" : "" })}
      </div>
    </div>
  `;
}

function renderPlayerMediaError(m) {
  const error = m.p.mediaError;
  const canOpenExternally = typeof desktop.openInSystemPlayer === "function";
  const hasNext = m.folderIndex >= 0 && m.folderIndex < m.folderCount - 1;
  const isWarning = error.kind === "warning";
  return `
    <div class="player-error ${isWarning ? "is-warning" : ""}" role="alert">
      <div class="player-error-card">
        <span class="player-error-icon">${icon(isWarning ? "video" : "x")}</span>
        <strong>${escapeHtml(error.title)}</strong>
        <p>${escapeHtml(error.detail)}</p>
        ${error.technical ? `<code class="player-error-tech mono">${escapeHtml(error.technical)}</code>` : ""}
        <div class="player-error-actions">
          ${canOpenExternally ? btn("Mở bằng trình phát hệ thống", "open-video-externally", "primary", "play") : ""}
          ${hasNext ? btn("Video tiếp", "player-next", "secondary", "skipNext") : ""}
          ${btn("Chọn video khác", "choose-video", canOpenExternally ? "" : "primary", "folder")}
          ${isWarning ? btn("Bỏ qua", "dismiss-media-error", "ghost", "x") : ""}
        </div>
      </div>
    </div>
  `;
}

function renderPlayerMediaSummary(videoName, srtName, hasSubtitles, compact = false) {
  const classes = ["player-meta-grid", hasSubtitles ? "" : "single", compact ? "compact" : ""].filter(Boolean).join(" ");
  const notice = state.player.subtitleNotice;
  return `
    <div class="${classes}">
      <div class="queue-item">
        <div class="eyebrow">VIDEO</div>
        <strong title="${escapeAttr(videoName)}">${escapeHtml(videoName)}</strong>
      </div>
      ${hasSubtitles ? `<div class="queue-item">
        <div class="eyebrow">PHỤ ĐỀ</div>
        <strong title="${escapeAttr(srtName)}">${escapeHtml(srtName)}</strong>
      </div>` : ""}
      ${notice ? `<div class="player-notice" role="status">${escapeHtml(notice)}</div>` : ""}
    </div>
  `;
}

function renderPlayerFolderRail(activeIndex = currentFolderVideoIndex()) {
  if (activeIndex < 0 || !state.folder.videos.length) return "";
  const activeVideo = state.folder.videos[activeIndex];

  return `
    <aside class="player-folder-rail" data-player-folder-rail>
      <div class="player-folder-tab" aria-hidden="true">
        ${icon("folder")}
        <span>${state.folder.videos.length}</span>
      </div>
      <div class="player-folder-panel">
        <div class="player-folder-head">
          <div>
            <div class="eyebrow">DANH SÁCH PHÁT</div>
            <strong>${escapeHtml(groupLabel(activeVideo?.groupName))}</strong>
          </div>
          ${btn("Thư viện", "back-to-folder-context", "ghost", "arrowL")}
        </div>
        <div class="player-folder-list" data-player-folder-list="rail">
          ${renderPlayerFolderListItems(activeIndex)}
        </div>
      </div>
    </aside>
  `;
}

function renderPlayerFolderSidebar(activeIndex = currentFolderVideoIndex()) {
  if (activeIndex < 0 || !state.folder.videos.length) return "";
  const activeVideo = state.folder.videos[activeIndex];
  return `
    <aside class="player-folder-sidebar">
      <div class="player-folder-head">
        <div>
          <div class="eyebrow">DANH SÁCH PHÁT</div>
          <strong title="${escapeAttr(groupLabel(activeVideo?.groupName))}">${escapeHtml(groupLabel(activeVideo?.groupName))}</strong>
        </div>
        <span class="count-badge">${state.folder.videos.length}</span>
      </div>
      <div class="player-folder-list" data-player-folder-list="sidebar">
        ${renderPlayerFolderListItems(activeIndex)}
      </div>
    </aside>
  `;
}

function renderPlayerFolderListItems(activeIndex = currentFolderVideoIndex()) {
  let currentFolder = null;
  let currentGroup = null;
  let html = "";

  state.folder.videos.forEach((video, index) => {
    const folderName = video.folderName || video.folder || "Thư mục này";
    const groupName = video.groupName || "Other";
    if (folderName !== currentFolder) {
      currentFolder = folderName;
      currentGroup = null;
      html += `<div class="player-folder-section">${escapeHtml(folderName)}</div>`;
    }
    if (groupName !== currentGroup) {
      currentGroup = groupName;
      html += `<div class="player-folder-group">${escapeHtml(groupLabel(groupName))}</div>`;
    }

    html += renderPlayerFolderItem(video, index, index === activeIndex);
  });

  return html;
}

function renderPlayerFolderItem(video, index, isActive) {
  const title = video.name || pathBaseName(video.path);
  const resolution = video.resolutionLabel || inferResolutionFromName(title) || "";
  const subLabel = hasFolderVideoSubtitle(video) ? "có phụ đề" : "chưa có phụ đề";
  const meta = [resolution, subLabel].filter(Boolean).join(" · ");
  return `
    <button class="player-folder-item ${isActive ? "active" : ""}" data-action="open-folder-video" data-video-index="${index}" data-player-folder-item="${index}" title="${escapeAttr(video.relativePath || title)}">
      <span class="player-folder-play">${isActive ? icon("play") : index + 1}</span>
      <span class="player-folder-text">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(meta)}</span>
      </span>
    </button>
  `;
}

function renderFolderPlayer() {
  const f = state.folder;
  const hasFolder = Boolean(f.path);
  const hasVideos = f.videos.length > 0;
  const renderReady = f.renderReady !== false;
  const visibleLimit = Math.max(1, Number(f.visibleLimit || folderPageSize));
  const visibleVideos = f.videos.slice(0, visibleLimit);
  const hiddenCount = Math.max(0, f.videos.length - visibleVideos.length);
  const selectedPath = state.player.videoPath;
  const status = hasFolder
    ? `${f.videos.length} video${f.truncated ? " · tối đa 1000" : ""}${f.skippedFolders ? ` · bỏ qua ${f.skippedFolders} thư mục` : ""}`
    : "Chọn thư mục để quét";

  let groupedHtml = "";
  if (hasVideos && renderReady) {
    let currentFolder = null;
    let currentGroup = null;
    
    visibleVideos.forEach((video, index) => {
      let isNewFolder = video.folderName !== currentFolder;
      let isNewGroup = isNewFolder || video.groupName !== currentGroup;
      
      if (isNewFolder || isNewGroup) {
        if (index > 0) groupedHtml += `</div>`;
        
        if (isNewFolder) {
          groupedHtml += `<h2 class="folder-group-title">${escapeHtml(video.folderName)}</h2>`;
          currentFolder = video.folderName;
          currentGroup = null;
        }
        
        if (video.groupName && (isNewFolder || video.groupName !== currentGroup)) {
          groupedHtml += `<h3 class="folder-prefix-title">${escapeHtml(groupLabel(video.groupName))}</h3>`;
          currentGroup = video.groupName;
        }
        
        groupedHtml += `<div class="folder-grid">`;
      }
      
      groupedHtml += renderFolderVideoCard(video, selectedPath, index);
    });
    
    if (visibleVideos.length > 0) {
      groupedHtml += `</div>`;
    }
  }

  return `
    <section class="screen folder-screen">
      <div class="top-row folder-top-row">
        <div class="page-titles">
          <h1 class="h1">Thư viện</h1>
          <p class="page-sub">Xem video theo thư mục trên máy, tự nạp phụ đề .srt cùng tên.</p>
        </div>
        <div class="folder-actions">
          ${hasFolder ? btn("Quét lại", "rescan-video-folder", "outline", "search", f.scanning ? "disabled" : "") : ""}
          ${btn(hasFolder ? "Chọn thư mục khác" : "Chọn thư mục", "choose-video-folder", "primary", "folder", f.scanning ? "disabled" : "")}
          ${hasFolder ? btn("Đóng thư mục", "clear-video-folder", "ghost", "x", f.scanning ? "disabled" : "") : ""}
        </div>
      </div>

      ${f.error ? `<div class="note is-danger folder-note"><strong>Không quét được thư mục.</strong><br>${escapeHtml(f.error)}</div>` : ""}

      ${!hasFolder && !f.scanning ? `
        <div class="folder-empty empty">
          <span class="play-dot">${icon("folder")}</span>
          <h3 class="h3">Chọn một thư mục</h3>
          <div class="muted">ViSUBLY sẽ quét các file video trong thư mục và giữ danh sách này cho tới khi bạn đóng app, đóng thư mục hoặc chọn thư mục khác.</div>
          <div class="empty-actions">${btn("Chọn thư mục", "choose-video-folder", "primary", "folder")}</div>
        </div>
      ` : ""}

      ${f.scanning ? `
        <div class="folder-empty empty">
          <span class="play-dot">${icon("search")}</span>
          <h3 class="h3">Đang quét thư mục</h3>
          <div class="muted">${escapeHtml(f.path || "Đang chờ chọn thư mục…")}</div>
        </div>
      ` : ""}

      ${hasFolder && !f.scanning ? `
        <div class="folder-summary">
          <div>
            <div class="eyebrow">THƯ MỤC ĐANG XEM</div>
            <strong title="${escapeAttr(f.path)}">${escapeHtml(f.name || f.path)}</strong>
            <div class="mono muted folder-path">${escapeHtml(f.path)}</div>
          </div>
          <div class="folder-summary-stats">
            <span class="count-badge">${escapeHtml(status)}</span>
            ${f.scannedAt ? `<span class="soft-badge">Quét ${escapeHtml(formatShortDate(f.scannedAt))}</span>` : ""}
          </div>
        </div>

        ${hasVideos && !renderReady ? `
          <div class="folder-empty empty compact">
            <span class="play-dot">${icon("folder")}</span>
            <h3 class="h3">Đang mở thư mục</h3>
            <div class="muted">Đang chuẩn bị danh sách video…</div>
          </div>
        ` : hasVideos ? `
          ${groupedHtml}
          ${hiddenCount ? `
            <div class="folder-load-more">
              ${btn(`Hiện thêm ${Math.min(folderPageSize, hiddenCount)}`, "load-more-folder-videos", "secondary", "plus")}
              <span class="mono muted">Đang hiện ${visibleVideos.length}/${f.videos.length}</span>
            </div>
          ` : ""}
        ` : `
          <div class="folder-empty empty">
            <span class="play-dot">${icon("video")}</span>
            <h3 class="h3">Không có video nào</h3>
            <div class="muted">Thử thư mục khác, hoặc thêm file MP4, MOV, MKV, WEBM, AVI, WMV hay TS vào đây.</div>
          </div>
        `}
      ` : ""}
    </section>
  `;
}

function renderFolderVideoCard(video, selectedPath, index) {
  const folder = video.folder ? video.folder : "Thư mục này";
  const isActive = selectedPath && selectedPath === video.path;
  const title = video.name || pathBaseName(video.path);
  const meta = [folder, formatBytes(video.size), video.modifiedAt ? formatShortDate(video.modifiedAt) : ""].filter(Boolean).join(" · ");
  const resolution = video.resolutionLabel || inferResolutionFromName(title) || "Đang đọc";
  const isSubbed = hasFolderVideoSubtitle(video);
  const subLabel = video.subtitlePath || video.subtitleName ? "Có file phụ đề" : isSubbed ? "Phụ đề sẵn" : "Chưa có phụ đề";

  return `
    <button class="folder-video-card ${isActive ? "active" : ""}" data-action="open-folder-video" data-video-index="${index}" data-folder-video-index="${index}" data-video-path="${escapeAttr(video.path)}" title="${escapeAttr(video.relativePath || title)}">
      <div class="folder-thumb">
        <video class="folder-thumb-video" data-src="${escapeAttr(video.url || localPathToFileUrl(video.path))}" data-video-index="${index}" muted playsinline preload="none" data-folder-thumb></video>
        <span class="folder-play">${icon("play")}</span>
        <span class="folder-ext">${escapeHtml(video.extension || pathExtension(video.path).toUpperCase())}</span>
      </div>
      <div class="folder-video-info">
        <strong>${escapeHtml(title)}</strong>
        <div class="mono muted">${escapeHtml(meta)}</div>
        <div class="folder-video-tags">
          <span class="folder-video-tag resolution" data-folder-resolution="${index}">${escapeHtml(resolution)}</span>
          <span class="folder-video-tag ${isSubbed ? "subbed" : "unsubbed"}">${icon("captions")} ${escapeHtml(subLabel)}</span>
        </div>
      </div>
    </button>
  `;
}


function attachDynamicHandlers(options = {}) {
  attachPlayerStage();
  attachMainPlayer();
  attachPlayerFolderRail(options.folderListMemory || null);
  syncPlayerControlsVisibility();
  if (state.screen === "folder") {
    scheduleFolderThumbs();
    scrollPendingFolderVideoIntoView();
  } else {
    cancelFolderThumbs();
  }
  focusCaptureDialog();
  if (state.screen === "settings" && state.pairing.code) startPairingTicker();
}

// New capture on screen: move focus into the dialog (name field) once.
function focusCaptureDialog() {
  const capture = state.capture.queue[0];
  if (!capture) {
    dialogFocusedFor = "";
    return;
  }
  if (dialogFocusedFor === capture.captureId) return;
  dialogFocusedFor = capture.captureId;
  const input = document.getElementById("capName");
  if (input) {
    input.focus({ preventScroll: true });
    input.select();
  }
}

function trapDialogFocus(dialog, event) {
  const focusables = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.offsetParent !== null);
  if (!focusables.length) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (!dialog.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function closeTopDialog() {
  if (state.capture.queue.length) return skipCurrentCapture();
  if (state.remote.pairingActive || state.remote.qrUrl || state.remote.loading) return closeRemoteModal();
  return undefined;
}

function closeRemoteModal() {
  state.remote.qrUrl = null;
  state.remote.testUrl = null;
  state.remote.loading = false;
  state.remote.pairingActive = false;
  state.remote.pairingPin = null;
  render();
}

document.addEventListener("submit", (event) => {
  const form = event.target.closest?.("[data-paste-form]");
  if (!form) return;
  event.preventDefault();
  submitPaste(form.dataset.pasteForm);
});

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-screen]");
  if (nav) {
    setScreen(nav.dataset.screen);
    return;
  }

  const actionEl = event.target.closest("[data-action]");
  if (!actionEl || actionEl.disabled) return;
  const action = actionEl.dataset.action;
  const id = actionEl.dataset.id || "";
  // A mouse click must not leave focus on a player control, otherwise Space would
  // re-activate that button instead of toggling playback. Keyboard clicks keep focus.
  if (event.detail > 0 && actionEl.closest("[data-player-stage]")) actionEl.blur();

  if (action === "minimize") return desktop.minimize();
  if (action === "maximize") return desktop.toggleMaximize();
  if (action === "close") return desktop.close();
  if (action === "dismiss-intro") return dismissIntro();

  if (action === "start-remote") return startRemote();
  if (action === "copy-remote-link") {
    if (!state.remote.testUrl) return undefined;
    try {
      await navigator.clipboard.writeText(state.remote.testUrl);
      showToast("Đã sao chép link Remote");
    } catch {
      showToast("Không sao chép được link");
    }
    return undefined;
  }
  if (action === "close-remote") return closeRemoteModal();

  // Capture dialog
  if (action === "capture-skip") return skipCurrentCapture();
  if (action === "capture-queue") return confirmCurrentCapture(false);
  if (action === "capture-now") return confirmCurrentCapture(true);
  if (action === "pick-quality") {
    state.capture.quality = actionEl.dataset.value || "";
    return render();
  }
  if (action === "change-download-dir") return changeDownloadDir();

  // Downloads
  if (action === "filter-downloads") {
    state.download.filter = actionEl.dataset.value || "all";
    return render();
  }
  if (action === "start-queue") {
    const result = await desktop.download.startQueue();
    applyDownloadResult(result);
    return render();
  }
  if (action === "open-download-dir") {
    const result = await desktop.download.openDownloadDir();
    if (result?.ok === false) showToast(result.error || "Không mở được thư mục tải xuống");
    return undefined;
  }
  if (action === "clear-finished-downloads") {
    state.download.actionError = "";
    const result = await desktop.download.clearCompleted();
    applyDownloadResult(result);
    return render();
  }
  if (action === "cancel-download") {
    const result = await desktop.download.cancelItem(id);
    applyDownloadResult(result);
    return render();
  }
  if (action === "retry-download") {
    if (state.download.expandedLogId === id) state.download.expandedLogId = "";
    const result = await desktop.download.retryItem(id);
    applyDownloadResult(result);
    return render();
  }
  if (action === "remove-download") {
    const result = await desktop.download.removeItem(id);
    applyDownloadResult(result);
    return render();
  }
  if (action === "toggle-download-log") {
    state.download.expandedLogId = state.download.expandedLogId === id ? "" : id;
    return render();
  }
  if (action === "reveal-download-output") {
    const result = await desktop.download.revealOutput(id);
    if (result?.ok === false) showToast("Không tìm thấy file. Có thể nó đã bị chuyển hoặc xóa.");
    return undefined;
  }
  if (action === "play-download") return playDownloadedItem(id);
  if (action === "open-recent") return openRecent(actionEl.dataset.path || "");

  // Settings
  if (action === "set-theme") return setThemeMode(actionEl.dataset.value);
  if (action === "set-parallel") return updateSettings({ maxParallelDownloads: Number(actionEl.dataset.value) });
  if (action === "toggle-notify") return updateSettings({ notifyOnComplete: !(state.settings?.notifyOnComplete !== false) });
  if (action === "new-pairing-code") return ensurePairingCode(true);
  if (action === "open-extension-folder") {
    const result = await desktop.app.openExtensionFolder();
    state.pairing.notice = result?.ok
      ? `Đã mở thư mục extension: ${result.path}`
      : `Không mở được thư mục extension${result?.path ? ` (${result.path})` : ""}.`;
    return render();
  }
  if (action === "ask-revoke") {
    state.pairing.confirmRevoke = true;
    return render();
  }
  if (action === "cancel-revoke") {
    state.pairing.confirmRevoke = false;
    return render();
  }
  if (action === "confirm-revoke") return revokeAllPairings();

  // Library + player
  if (action === "choose-video") {
    const picked = await desktop.selectVideo();
    if (picked) await loadVideoPath(picked, { folderContext: null });
    return render();
  }
  if (action === "choose-srt") {
    const picked = await desktop.selectSubtitle();
    if (picked) await loadSubtitlePath(picked);
    return render();
  }
  if (action === "choose-video-folder") return chooseVideoFolder();
  if (action === "rescan-video-folder") return rescanVideoFolder();
  if (action === "clear-video-folder") {
    state.folder = emptyFolderState();
    return render();
  }
  if (action === "load-more-folder-videos") {
    state.folder.visibleLimit = Math.min(
      state.folder.videos.length,
      Math.max(folderPageSize, Number(state.folder.visibleLimit || folderPageSize)) + folderPageSize
    );
    return render();
  }
  if (action === "open-folder-video") {
    return openFolderVideo(Number(actionEl.dataset.videoIndex), actionEl.dataset.videoPath || "");
  }
  if (action === "player-prev") return stepFolderVideo(-1);
  if (action === "player-next") return stepFolderVideo(1);
  if (action === "dismiss-media-error") {
    state.player.mediaError = null;
    return render();
  }
  if (action === "open-video-externally") return openVideoExternally();
  if (action === "back-to-folder-context") {
    const index = currentFolderVideoIndex();
    if (index >= 0) {
      state.folder.visibleLimit = Math.max(Number(state.folder.visibleLimit || folderPageSize), index + 1);
      state.folder.pendingScrollPath = state.player.videoPath;
    }
    return setScreen("folder");
  }
  if (action === "toggle-player") return toggleMainPlayer();
  if (action === "toggle-mute") return toggleMainMute();
  if (action === "seek-back") return seekMainPlayerBy(-5);
  if (action === "seek-forward") return seekMainPlayerBy(5);
  if (action === "toggle-theater") return toggleTheaterMode();
  if (action === "toggle-fullscreen") return togglePlayerFullscreen();
  if (action === "subtitle-toggle") {
    state.player.subtitleOn = !state.player.subtitleOn;
    return render();
  }
  if (action === "subtitle-bg") {
    state.player.style.background = !state.player.style.background;
    return render();
  }
  if (action === "subtitle-outline") {
    state.player.style.outline = !state.player.style.outline;
    return render();
  }
  if (action === "subtitle-size-down") {
    state.player.style.fontSize = Math.max(14, state.player.style.fontSize - 2);
    return render();
  }
  if (action === "subtitle-size-up") {
    state.player.style.fontSize = Math.min(30, state.player.style.fontSize + 2);
    return render();
  }
  if (action === "subtitle-bottom-down") {
    state.player.style.bottom = Math.max(24, state.player.style.bottom - 8);
    return render();
  }
  if (action === "subtitle-bottom-up") {
    state.player.style.bottom = Math.min(150, state.player.style.bottom + 8);
    return render();
  }
  if (action === "seek-cue") return seekMainPlayer(Number(actionEl.dataset.time || 0));
  return undefined;
});

document.addEventListener("input", (event) => {
  const bind = event.target.dataset?.bind;
  if (!bind) return;
  const value = event.target.value;
  if (bind === "paste.home" || bind === "paste.download") {
    const where = bind.slice(6);
    state.paste[where] = value;
    if (state.paste.errorFor === where && state.paste.error) {
      state.paste.error = "";
      state.paste.errorFor = "";
      event.target.closest(".paste-wrap")?.querySelector(".inline-error")?.remove();
    }
  }
  if (bind === "capture.name") state.capture.name = value;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Tab") playerKeyboardModality = true;
  if (state.intro && ["Escape", "Enter", " "].includes(event.key)) {
    event.preventDefault();
    dismissIntro();
    return;
  }
  const dialog = root.querySelector('[role="dialog"][aria-modal="true"]');
  if (dialog) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeTopDialog();
    } else if (event.key === "Tab") {
      trapDialogFocus(dialog, event);
    } else if (event.key === "Enter" && event.target?.id === "capName" && !event.isComposing) {
      event.preventDefault();
      confirmCurrentCapture(true);
    }
    return;
  }
  handlePlayerShortcut(event);
});

// Keep keyboard focus inside an open dialog (the rest of the app is inert).
document.addEventListener("focusin", (event) => {
  const dialog = root.querySelector('[role="dialog"][aria-modal="true"]');
  if (dialog && !dialog.contains(event.target) && root.contains(event.target)) {
    const first = dialog.querySelector("input:not([disabled]), button:not([disabled])");
    first?.focus({ preventScroll: true });
  }
});


function scheduleFolderThumbs() {
  cancelFolderThumbs();
  const sincePlayer = Date.now() - Number(state.player.lastSuspendedAt || 0);
  const delay = sincePlayer < 700 ? 360 : 120;
  folderThumbTimer = window.setTimeout(() => {
    folderThumbTimer = null;
    attachFolderThumbs();
  }, delay);
}

function cancelFolderThumbs() {
  if (folderThumbTimer) window.clearTimeout(folderThumbTimer);
  folderThumbTimer = null;
  folderThumbQueue = [];
  folderThumbActive = 0;
}

// Stage handlers use on* properties so they stay idempotent: the stage element
// survives fullscreen patches and must not accumulate duplicate listeners.
function attachPlayerStage() {
  const stage = document.querySelector("[data-player-stage]");
  if (!stage) {
    clearPlayerControlsTimer();
    return;
  }

  stage.onpointermove = (event) => {
    if (event.screenX === playerLastPointer.x && event.screenY === playerLastPointer.y) return;
    playerLastPointer = { x: event.screenX, y: event.screenY };
    showPlayerControls();
  };
  stage.onpointerdown = () => showPlayerControls();
  stage.onmouseleave = () => {
    // Pointer left the picture (theater mode / second monitor): hide right away.
    if (!state.player.playing || !stage.classList.contains("is-overlay") || playerScrubbing) return;
    if (playerKeyboardModality && stage.contains(document.activeElement)) return;
    hidePlayerControls(stage);
  };

  const playerDrop = stage.querySelector("[data-player-drop]");
  if (!playerDrop) return;

  playerDrop.ondragover = (event) => {
    event.preventDefault();
    playerDrop.classList.add("dragging");
  };
  playerDrop.ondragleave = (event) => {
    if (!playerDrop.contains(event.relatedTarget)) playerDrop.classList.remove("dragging");
  };
  playerDrop.ondrop = async (event) => {
    event.preventDefault();
    playerDrop.classList.remove("dragging");
    const file = event.dataTransfer.files?.[0];
    if (!file) return;

    const filePath = file.path || file.name;
    if (isSubtitlePath(filePath)) {
      await loadSubtitlePath(filePath);
      render();
      return;
    }

    if (isVideoPath(filePath)) {
      const token = await loadVideoPath(filePath);
      if (token !== state.player.sourceToken) return;
      state.player.playing = true;
      render();
    }
  };

  const ignoreFrameClick = (event) => Boolean(event.target.closest("button, input, a, [data-player-folder-rail], .player-error"));
  // Single click toggles playback, double click toggles fullscreen (the two
  // single clicks cancel each other out, like most desktop players).
  playerDrop.onclick = (event) => {
    if (!state.player.videoUrl || ignoreFrameClick(event)) return;
    toggleMainPlayer();
    showPlayerControls();
  };
  playerDrop.ondblclick = (event) => {
    if (!state.player.videoUrl || ignoreFrameClick(event)) return;
    togglePlayerFullscreen();
  };
}

function capturePlayerFolderListScroll() {
  const scroll = {};
  document.querySelectorAll("[data-player-folder-list]").forEach((list) => {
    if (list.clientHeight) scroll[list.dataset.playerFolderList] = list.scrollTop;
  });
  return { path: playerFolderCenteredPath, scroll };
}

// Keep the active playlist item visible by scrolling only the list itself;
// scrollIntoView() would also scroll the page and the overflow-hidden frame.
function attachPlayerFolderRail(memory = null) {
  if (state.screen !== "player" || !document.querySelector("[data-player-folder-list]")) return;
  const activePath = state.player.videoPath;
  window.requestAnimationFrame(() => {
    document.querySelectorAll("[data-player-folder-list]").forEach((list) => {
      if (!list.clientHeight) return;
      const key = list.dataset.playerFolderList;
      const remembered = memory?.scroll?.[key];
      if (memory?.path && sameLocalPath(memory.path, activePath) && Number.isFinite(remembered)) {
        list.scrollTop = remembered;
        return;
      }
      const active = list.querySelector(".player-folder-item.active");
      if (active) scrollChildIntoContainer(list, active);
    });
    playerFolderCenteredPath = activePath;
  });
}

function scrollChildIntoContainer(container, child, behavior = "auto") {
  if (!container || !child || !container.clientHeight) return;
  const containerRect = container.getBoundingClientRect();
  const childRect = child.getBoundingClientRect();
  const offset = childRect.top - containerRect.top - container.clientTop + container.scrollTop;
  const target = Math.max(0, offset - (container.clientHeight - childRect.height) / 2);
  if (Math.abs(target - container.scrollTop) < 2) return;
  container.scrollTo({ top: target, behavior });
}

function patchPlayerStage() {
  const stage = document.querySelector("[data-player-stage]");
  if (!stage) return;
  const m = playerViewModel();
  const active = document.activeElement;
  const focusedAction = active && stage.contains(active) ? active.closest?.("[data-action]")?.dataset.action || "" : "";
  const folderListMemory = capturePlayerFolderListScroll();

  stage.className = playerStageClasses(m);
  const frame = stage.querySelector("[data-player-drop]");
  if (frame) frame.className = playerFrameClasses(m);
  const layer = stage.querySelector("[data-player-layer]");
  if (layer) layer.outerHTML = renderPlayerFrameLayer(m);
  const consoleEl = stage.querySelector("[data-player-console]");
  if (consoleEl) consoleEl.outerHTML = renderPlayerConsole(m);

  attachPlayerStage();
  attachMainPlayer();
  attachPlayerFolderRail(folderListMemory);
  if (focusedAction) stage.querySelector(`[data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
}

function scrollPendingFolderVideoIntoView() {
  const targetPath = state.folder.pendingScrollPath;
  if (!targetPath) return;
  const index = state.folder.videos.findIndex((video) => sameLocalPath(video.path, targetPath));
  if (index < 0) {
    state.folder.pendingScrollPath = "";
    return;
  }

  window.requestAnimationFrame(() => {
    const card = document.querySelector(`[data-folder-video-index="${index}"]`);
    card?.scrollIntoView({ block: "center" });
    state.folder.pendingScrollPath = "";
  });
}

document.addEventListener("pointerdown", () => {
  playerKeyboardModality = false;
}, true);

// Safety net: if the scrubber was re-rendered mid-drag its own pointerup never fires.
["pointerup", "pointercancel"].forEach((type) => window.addEventListener(type, () => {
  if (!playerScrubbing) return;
  playerScrubbing = false;
  schedulePlayerControlsHide();
}));

document.addEventListener("focusin", (event) => {
  if (playerKeyboardModality && event.target?.closest?.("[data-player-stage]")) showPlayerControls();
});

if ("onfullscreenchange" in document) {
  document.addEventListener("fullscreenchange", syncFullscreenState);
} else {
  document.addEventListener("webkitfullscreenchange", syncFullscreenState);
}

function isTextEntryElement(element) {
  if (!element || element === document.body) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["range", "checkbox", "radio", "button", "submit", "reset", "color", "file"].includes(String(element.type || "").toLowerCase());
}

function handlePlayerShortcut(event) {
  if (state.screen !== "player" || event.defaultPrevented) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (isTextEntryElement(event.target) || isTextEntryElement(document.activeElement)) return false;
  if (modalKey() || state.intro) return false;

  const p = state.player;
  const key = event.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;

  if (key === "Escape") {
    // Esc leaves fullscreen first (Chromium usually consumes it, this is the fallback)
    // and theater mode only when not fullscreen, so fullscreen-from-theater lands in theater.
    if (getFullscreenElement()) {
      event.preventDefault();
      exitDocumentFullscreen().catch(() => {});
      return true;
    }
    if (p.theater && p.videoUrl) {
      event.preventDefault();
      toggleTheaterMode();
      return true;
    }
    return false;
  }
  if (!p.videoUrl) return false;

  showPlayerControls();
  const onButton = Boolean(event.target?.closest?.("button, a[href], summary"));
  if (key === " " || key === "Spacebar") {
    // Keyboard users who tabbed to a control get native activation of that control.
    if (onButton && playerKeyboardModality) return false;
    event.preventDefault();
    if (!event.repeat) toggleMainPlayer();
    return true;
  }
  if (key === "ArrowLeft" || key === "ArrowRight") {
    event.preventDefault();
    seekMainPlayerBy(key === "ArrowLeft" ? -5 : 5);
    return true;
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    event.preventDefault();
    adjustMainPlayerVolume(key === "ArrowUp" ? 0.05 : -0.05);
    return true;
  }
  const toggles = {
    m: () => toggleMainMute(),
    f: () => togglePlayerFullscreen(),
    t: () => toggleTheaterMode()
  };
  if (event.shiftKey && (lower === "n" || lower === "p")) {
    event.preventDefault();
    if (!event.repeat) stepFolderVideo(lower === "n" ? 1 : -1);
    return true;
  }
  if (toggles[lower]) {
    event.preventDefault();
    if (!event.repeat) toggles[lower]();
    return true;
  }
  return false;
}

// ---------- Downloads bridge ----------
function initDownloadBridge() {
  desktop.download?.onState?.((snapshot) => {
    syncDownloadState(snapshot);
    scheduleDownloadRender();
  });
  refreshDownloadState();
}

async function refreshDownloadState() {
  try {
    const snapshot = await desktop.download.getState();
    syncDownloadState(snapshot);
    onDownloadsChanged();
  } catch {
    // The browser fallback keeps the UI usable without Electron IPC.
  }
}

function scheduleDownloadRender() {
  if (downloadRenderTimer) return;
  downloadRenderTimer = window.setTimeout(() => {
    downloadRenderTimer = null;
    onDownloadsChanged();
  }, 180);
}

// Screens that show downloads re-render; elsewhere only the sidebar badge is patched,
// so a playing video's controls are never rebuilt by progress ticks.
function onDownloadsChanged() {
  if (state.screen === "download" || state.screen === "home") render({ preserveScroll: true });
  else refreshSidebar();
}

function refreshSidebar() {
  const sidebar = document.querySelector("[data-sidebar]");
  if (sidebar) sidebar.outerHTML = renderSidebar();
}

function applyDownloadResult(result = {}) {
  if (result?.state) syncDownloadState(result.state);
  state.download.actionError = result?.ok === false ? describeFailure(result.error).message : "";
}

function syncDownloadState(snapshot = {}) {
  if (!snapshot || !Array.isArray(snapshot.items)) return;
  const doneBefore = state.download.items.filter((item) => item.status === "done").length;
  state.download.items = snapshot.items;
  if (Number(snapshot.parallelItems)) state.download.parallelItems = Number(snapshot.parallelItems);
  if (snapshot.downloadDir) state.download.downloadDir = snapshot.downloadDir;
  const expanded = state.download.expandedLogId;
  if (expanded && !snapshot.items.some((item) => item.id === expanded)) state.download.expandedLogId = "";
  if (snapshot.items.filter((item) => item.status === "done").length !== doneBefore) refreshDiskSpace();
}

function downloadCounts() {
  const items = state.download.items;
  const today = new Date().toDateString();
  const counts = { all: items.length, active: 0, queued: 0, done: 0, failed: 0, doneToday: 0 };
  for (const item of items) {
    if (activeStatuses.has(item.status)) counts.active += 1;
    else if (item.status === "queued") counts.queued += 1;
    else if (item.status === "done") {
      counts.done += 1;
      const finished = new Date(item.finishedAt || item.updatedAt || 0);
      if (finished.toDateString() === today) counts.doneToday += 1;
    } else if (item.status === "failed" || item.status === "canceled") counts.failed += 1;
  }
  return counts;
}

function downloadSortRank(item) {
  if (activeStatuses.has(item.status)) return 0;
  if (item.status === "queued") return 1;
  if (item.status === "done") return 2;
  return 3;
}

function filteredDownloadItems() {
  const filter = state.download.filter;
  const matches = (item) => {
    if (filter === "active") return activeStatuses.has(item.status);
    if (filter === "queued") return item.status === "queued";
    if (filter === "done") return item.status === "done";
    if (filter === "failed") return item.status === "failed" || item.status === "canceled";
    return true;
  };
  return state.download.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => matches(item))
    .sort((a, b) => {
      const rank = downloadSortRank(a.item) - downloadSortRank(b.item);
      if (rank) return rank;
      if (a.item.status === "done" && b.item.status === "done") {
        return String(b.item.finishedAt || "").localeCompare(String(a.item.finishedAt || ""));
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

function queuePosition(item) {
  return state.download.items.filter((entry) => entry.status === "queued").findIndex((entry) => entry.id === item.id) + 1;
}

function currentDownloadDir() {
  return state.settings?.downloadDir || state.download.downloadDir || state.info?.downloadDir || "";
}

async function playDownloadedItem(itemId) {
  const item = state.download.items.find((entry) => entry.id === itemId);
  if (!item?.output) return;
  let exists = {};
  try {
    exists = (await desktop.checkFiles([item.output])) || {};
  } catch {
    exists = {};
  }
  if (exists[item.output] === false) {
    state.download.actionError = `Không tìm thấy file ${item.output}. Có thể nó đã bị chuyển hoặc xóa.`;
    render();
    return;
  }
  state.download.actionError = "";
  const token = await loadVideoPath(item.output, { displayName: item.name, folderContext: null });
  if (token !== state.player.sourceToken) return;
  state.player.playing = true;
  setScreen("player");
}

// ---------- Paste + capture dialog ----------
async function submitPaste(where) {
  if (where !== "home" && where !== "download") return;
  if (state.paste.busy) return;
  const source = String(state.paste[where] || "").trim();
  if (!source) {
    state.paste.error = "Dán link video hoặc lệnh cURL trước đã.";
    state.paste.errorFor = where;
    render();
    return;
  }
  state.paste.busy = where;
  state.paste.error = "";
  state.paste.errorFor = "";
  render();
  let result;
  try {
    result = await desktop.capture.prepareManual(source);
  } catch (error) {
    result = { ok: false, error: error?.message || "" };
  }
  state.paste.busy = "";
  if (result?.ok && result.capture) {
    state.paste[where] = "";
    enqueueCaptureDialog(result.capture);
    return;
  }
  state.paste.error = describeFailure(result?.error).message;
  state.paste.errorFor = where;
  render();
}

function initCaptureBridge() {
  desktop.capture?.onIncoming?.((payload) => enqueueCaptureDialog(payload));
}

function enqueueCaptureDialog(payload) {
  if (!payload?.captureId) return;
  if (state.capture.queue.some((entry) => entry.captureId === payload.captureId)) return;
  const wasEmpty = state.capture.queue.length === 0;
  if (wasEmpty) {
    state.capture.handled = 0;
    dialogReturnFocus = focusSelector(document.activeElement);
  }
  state.capture.queue.push(payload);
  if (wasEmpty) primeCaptureForm();
  if (payload.downloadDir && !state.settings?.downloadDir) state.download.downloadDir = payload.downloadDir;
  if (state.intro) dismissIntro();
  render();
}

function primeCaptureForm() {
  const capture = state.capture.queue[0];
  state.capture.name = capture ? String(capture.name || "") : "";
  state.capture.quality = capture ? defaultVariantKey(capture) : "";
  state.capture.error = "";
  state.capture.busy = false;
}

function advanceCaptureQueue() {
  state.capture.queue.shift();
  state.capture.handled += 1;
  const empty = state.capture.queue.length === 0;
  if (empty) state.capture.handled = 0;
  primeCaptureForm();
  render();
  if (empty && dialogReturnFocus) {
    const target = root.querySelector(dialogReturnFocus);
    if (target && !target.disabled) target.focus({ preventScroll: true });
    dialogReturnFocus = "";
  }
}

async function confirmCurrentCapture(start) {
  const capture = state.capture.queue[0];
  if (!capture || state.capture.busy) return;
  state.capture.busy = true;
  state.capture.error = "";
  render();
  let result;
  try {
    result = await desktop.capture.confirm({
      captureId: capture.captureId,
      name: state.capture.name.trim() || capture.name,
      quality: state.capture.quality,
      start
    });
  } catch (error) {
    result = { ok: false, error: error?.message || "" };
  }
  state.capture.busy = false;
  if (result?.ok) {
    if (result.state) syncDownloadState(result.state);
    showToast(start ? "Đã thêm và bắt đầu tải" : "Đã thêm vào hàng đợi");
    advanceCaptureQueue();
    return;
  }
  const raw = String(result?.error || "");
  state.capture.error = /expired|already handled/i.test(raw)
    ? capture.origin === "manual"
      ? "Yêu cầu này đã hết hạn. Hãy dán lại link."
      : "Yêu cầu này đã hết hạn. Bấm lại Tải bằng ViSUBLY trên Chrome."
    : describeFailure(raw).message;
  render();
}

async function skipCurrentCapture() {
  const capture = state.capture.queue[0];
  if (!capture || state.capture.busy) return;
  try {
    await desktop.capture.dismiss(capture.captureId);
  } catch {
    // The pending capture simply expires in the main process.
  }
  advanceCaptureQueue();
}

function variantKey(variant) {
  return String(variant?.url || variant?.resolution || "");
}

function sortedVariants(variants) {
  if (!Array.isArray(variants)) return [];
  return variants
    .filter((variant) => variant && (variant.url || variant.resolution))
    .slice()
    .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0) || (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
}

function defaultVariantKey(capture) {
  const variants = sortedVariants(capture.variants);
  if (!variants.length) return "";
  const selectedUrl = capture.preparedItem?.selectedUrl;
  const selected = variants.find((variant) => variant.url && variant.url === selectedUrl);
  return variantKey(selected || variants[0]);
}

async function changeDownloadDir() {
  let result;
  try {
    result = await desktop.settings.selectDownloadDir();
  } catch (error) {
    showToast(error?.message || "Không đổi được thư mục");
    return;
  }
  if (!result || result.canceled) return;
  if (result.settings) state.settings = result.settings;
  refreshDiskSpace();
  render();
}

// ---------- Settings + theme ----------
function applyTheme(mode) {
  const next = ["dark", "light", "system"].includes(mode) ? mode : "dark";
  const resolved = next === "system" ? (systemDarkQuery && !systemDarkQuery.matches ? "light" : "dark") : next;
  state.theme = { mode: next, resolved };
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

async function setThemeMode(mode) {
  applyTheme(mode);
  state.settings = { ...(state.settings || {}), theme: state.theme.mode };
  render();
  await updateSettings({ theme: state.theme.mode }, { quiet: true });
}

async function updateSettings(partial, options = {}) {
  let next = null;
  try {
    next = await desktop.settings.update(partial);
  } catch (error) {
    showToast(error?.message || "Không lưu được cài đặt");
  }
  if (next && typeof next === "object" && !("ok" in next)) state.settings = next;
  else state.settings = { ...(state.settings || {}), ...partial };
  if (!options.quiet) render();
}

function initSettingsBridge() {
  desktop.settings?.onChange?.((next) => {
    if (!next || typeof next !== "object") return;
    const themeChanged = next.theme && next.theme !== state.theme.mode;
    state.settings = next;
    if (themeChanged) applyTheme(next.theme);
    if (state.screen === "player") refreshSidebar();
    else render();
  });
  systemDarkQuery?.addEventListener?.("change", () => {
    if (state.theme.mode === "system") applyTheme("system");
  });
}

async function refreshAppInfo() {
  try {
    const info = await desktop.app.getInfo();
    if (info) {
      state.info = info;
      if (info.captureBridge) applyChromeInfo(info.captureBridge);
    }
  } catch {
    // Info is decorative; screens show "Đang kiểm tra…" without it.
  }
  if (state.screen === "player") refreshSidebar();
  else render();
}

async function refreshSettings() {
  try {
    const next = await desktop.settings.get();
    if (next && typeof next === "object") {
      state.settings = next;
      if (next.theme && next.theme !== state.theme.mode) applyTheme(next.theme);
    }
  } catch {
    // Keep defaults.
  }
}

async function refreshDiskSpace() {
  let result = null;
  try {
    result = await desktop.app.diskSpace();
  } catch {
    result = null;
  }
  const changed = JSON.stringify(result?.ok ? result : null) !== JSON.stringify(state.disk);
  state.disk = result?.ok ? result : null;
  if (changed && state.screen === "download") render();
}

// ---------- Chrome connection + pairing ----------
function applyChromeInfo(info) {
  if (!info || typeof info !== "object") return false;
  const next = {
    known: true,
    running: Boolean(info.running),
    pairedClients: Number(info.pairedClients) || 0,
    error: String(info.error || "")
  };
  const changed =
    !state.chrome.known ||
    next.running !== state.chrome.running ||
    next.pairedClients !== state.chrome.pairedClients ||
    next.error !== state.chrome.error;
  state.chrome = next;
  return changed;
}

async function pollChrome() {
  let info = null;
  try {
    info = await desktop.capture.info();
  } catch {
    info = null;
  }
  if (!info) return;
  const pairedBefore = state.chrome.known ? state.chrome.pairedClients : null;
  if (!applyChromeInfo(info)) return;
  // A pairing code is single use: once a browser paired with it, offer a fresh one.
  if (pairedBefore !== null && state.chrome.pairedClients > pairedBefore && state.pairing.code) {
    state.pairing.code = "";
    state.pairing.expiresAt = 0;
    state.pairing.notice = "Đã ghép nối với Chrome. Mã cũ đã dùng xong.";
    if (state.screen === "settings") ensurePairingCode(true);
  }
  if (state.screen === "player") refreshSidebar();
  else render();
}

function startChromePolling() {
  if (chromePollTimer || !window.visublyDesktop) return;
  pollChrome();
  chromePollTimer = window.setInterval(() => {
    if (document.visibilityState === "hidden") return;
    pollChrome();
  }, chromePollMs);
}

async function ensurePairingCode(force = false) {
  const pairing = state.pairing;
  if (pairing.loading) return;
  if (!force && pairing.code && pairing.expiresAt > Date.now() + 5000) return;
  pairing.loading = true;
  pairing.error = "";
  if (state.screen === "settings") render();
  let result;
  try {
    result = await desktop.capture.createPairingCode();
  } catch (error) {
    result = { ok: false, error: error?.message || "" };
  }
  pairing.loading = false;
  if (result?.ok && result.code) {
    pairing.code = String(result.code);
    pairing.expiresAt = Number(result.expiresAt) || Date.now() + 5 * 60 * 1000;
  } else {
    pairing.code = "";
    pairing.expiresAt = 0;
    pairing.error = bridgeErrorText(result?.error);
  }
  if (state.screen === "settings") render();
}

function bridgeErrorText(raw) {
  const text = String(raw || "");
  if (/turned off/i.test(text)) return "Kết nối trình duyệt đang tắt.";
  if (/could not start|EADDRINUSE|not running|not installed|failed to load/i.test(text)) {
    return "Cầu nối Chrome chưa chạy. Khởi động lại ViSUBLY rồi thử lại.";
  }
  return text ? `Không tạo được mã: ${text}` : "Không tạo được mã ghép nối.";
}

function startPairingTicker() {
  if (pairingTimer) return;
  pairingTimer = window.setInterval(() => {
    const pairing = state.pairing;
    if (state.screen !== "settings" || !pairing.code) {
      window.clearInterval(pairingTimer);
      pairingTimer = null;
      return;
    }
    const left = (pairing.expiresAt - Date.now()) / 1000;
    if (left <= 0) {
      pairing.code = "";
      pairing.expiresAt = 0;
      render();
      return;
    }
    const countdown = document.querySelector("[data-pair-countdown]");
    if (countdown) countdown.textContent = `Hết hạn sau ${formatClock(left)}`;
  }, 1000);
}

function formatPairingCode(code) {
  const value = String(code || "");
  return value.length === 6 ? `${value.slice(0, 3)} ${value.slice(3)}` : value;
}

async function revokeAllPairings() {
  state.pairing.confirmRevoke = false;
  let result;
  try {
    result = await desktop.capture.revokeAll();
  } catch (error) {
    result = { ok: false, error: error?.message || "" };
  }
  if (result?.ok) {
    if (result.info) applyChromeInfo(result.info);
    state.pairing.notice = "Đã hủy mọi ghép nối. Chrome cần nhập mã mới để kết nối lại.";
  } else {
    state.pairing.notice = bridgeErrorText(result?.error).replace("Không tạo được mã", "Không hủy được ghép nối");
  }
  render();
}

// ---------- Remote iPhone ----------
function startRemote() {
  state.remote.loading = true;
  render();
  desktop.airplay
    .start()
    .then((info) => {
      state.remote.qrUrl = info?.qrUrl || null;
      state.remote.testUrl = info?.baseUrl ? `${info.baseUrl}/?token=${info.pairingToken}` : null;
      state.remote.loading = false;
      if (!state.remote.qrUrl) showToast("Không bật được Remote iPhone");
      render();
    })
    .catch((error) => {
      state.remote.loading = false;
      showToast(`Không bật được Remote: ${error?.message || "lỗi không rõ"}`);
      render();
    });
}

// ---------- "Xem tiếp" (recently played, localStorage) ----------
function loadRecentEntries() {
  try {
    const list = JSON.parse(window.localStorage.getItem(recentKey) || "[]");
    if (!Array.isArray(list)) return [];
    return list.filter((entry) => entry && typeof entry.path === "string" && entry.path);
  } catch {
    return [];
  }
}

function saveRecentEntries(list) {
  try {
    window.localStorage.setItem(recentKey, JSON.stringify(list.slice(0, maxRecentEntries)));
  } catch {
    // Storage may be unavailable; the list just will not persist.
  }
}

async function refreshRecent() {
  const entries = loadRecentEntries();
  let exists = {};
  if (entries.length) {
    try {
      exists = (await desktop.checkFiles(entries.map((entry) => entry.path))) || {};
    } catch {
      exists = {};
    }
  }
  const next = entries.filter((entry) => exists[entry.path] === true);
  const changed = JSON.stringify(next) !== JSON.stringify(state.recent);
  state.recent = next;
  if (changed && state.screen === "home") render();
}

function rememberPlayback(video) {
  const p = state.player;
  if (!p.videoPath || !video) return;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : p.duration;
  if (!duration) return;
  const entry = {
    path: p.videoPath,
    name: p.displayName || pathBaseName(p.videoPath),
    position: Math.max(0, Math.min(duration, Number(video.currentTime) || 0)),
    duration,
    updatedAt: new Date().toISOString()
  };
  const list = [entry, ...loadRecentEntries().filter((item) => !sameLocalPath(item.path, entry.path))];
  saveRecentEntries(list);
  lastRecentSaveAt = Date.now();
  state.recent = [entry, ...state.recent.filter((item) => !sameLocalPath(item.path, entry.path))].slice(0, maxRecentEntries);
}

async function openRecent(pathValue) {
  if (!pathValue) return;
  const entry = state.recent.find((item) => sameLocalPath(item.path, pathValue));
  const token = await loadVideoPath(pathValue, { displayName: entry?.name || "", folderContext: null });
  if (token !== state.player.sourceToken) return;
  const position = Number(entry?.position) || 0;
  const duration = Number(entry?.duration) || 0;
  if (position > 5 && (!duration || position < duration - 10)) state.player.resumeAt = position;
  state.player.playing = true;
  setScreen("player");
}

// ---------- Errors (friendly Vietnamese text, raw log stays available) ----------
function httpStatusFrom(text) {
  const patterns = [
    /HTTP Error (\d{3})/i,
    /returned error:?\s*(\d{3})/i,
    /status(?: code)?[:= ]+(\d{3})/i,
    /\b(\d{3})\s+(?:Forbidden|Unauthorized|Not Found|Gone|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable)/i,
    /server returned (\d{3})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  if (/\bForbidden\b/i.test(text)) return 403;
  if (/\bUnauthorized\b/i.test(text)) return 401;
  return 0;
}

function describeFailure(raw) {
  const text = String(raw || "");
  const status = httpStatusFrom(text);
  if (status === 401 || status === 403) {
    return { code: `Lỗi ${status}`, message: "Link đã hết hạn hoặc cần đăng nhập. Mở lại trang trên Chrome rồi bấm Tải bằng ViSUBLY." };
  }
  if (status === 404 || status === 410) {
    return { code: `Lỗi ${status}`, message: "Không tìm thấy video ở link này. Có thể video đã bị gỡ hoặc link bị thiếu, hãy lấy link mới." };
  }
  if (/no space left|ENOSPC|disk (is )?full|not enough space/i.test(text)) {
    return { code: "Hết dung lượng", message: "Ổ đĩa lưu video đã đầy. Giải phóng bớt dung lượng hoặc đổi thư mục lưu trong Cài đặt rồi thử lại." };
  }
  if (/ffmpeg/i.test(text) && /not found|missing|cannot find|ENOENT|not recognized|no such file/i.test(text)) {
    return { code: "Thiếu ffmpeg", message: "Không tìm thấy ffmpeg để ghép video. Hãy cài lại ViSUBLY." };
  }
  if (/engine|runner|python|visubly-downloader|spawn/i.test(text) && /not found|missing|ENOENT|could not start|cannot start|not available|failed to start/i.test(text)) {
    return { code: "Thiếu trình tải", message: "Trình tải video không khởi động được. Hãy cài lại ViSUBLY." };
  }
  if (/\bDRM\b|widevine|playready|fairplay|SAMPLE-AES|encrypted|EXT-X-KEY/i.test(text)) {
    return { code: "Không hỗ trợ", message: "Video này được bảo vệ bản quyền (DRM) nên ViSUBLY không tải được." };
  }
  if (/blob url|unsupported|not supported|no variants or media segments|could not find url|no url or curl|invalid url|unknown url type|not a valid/i.test(text)) {
    return { code: "Không hỗ trợ", message: "ViSUBLY chưa đọc được link này. Hãy dùng link .m3u8 hoặc .mp4, hoặc bấm Tải bằng ViSUBLY trên Chrome." };
  }
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|network|connection (reset|refused|aborted)|URLError|RemoteDisconnected|SSL|Could not resolve host|Failed to connect/i.test(text)) {
    return { code: "Lỗi mạng", message: "Mất kết nối hoặc máy chủ phản hồi quá chậm. Kiểm tra mạng rồi bấm Thử lại." };
  }
  if (status >= 500 && status < 600) {
    return { code: `Lỗi ${status}`, message: "Máy chủ video đang gặp sự cố. Thử lại sau ít phút." };
  }
  if (status === 429) {
    return { code: "Lỗi 429", message: "Máy chủ đang giới hạn tốc độ tải. Đợi một lát rồi bấm Thử lại." };
  }
  if (/paste a url|full curl command first/i.test(text)) {
    return { code: "Thiếu link", message: "Dán link video hoặc lệnh cURL trước đã." };
  }
  if (/output file (is not available|was not found)/i.test(text)) {
    return { code: "Không thấy file", message: "Không tìm thấy file đã tải. Có thể nó đã bị chuyển hoặc xóa." };
  }
  if (/only in the visubly app|chỉ có trong ứng dụng/i.test(text)) {
    return { code: "Cần ứng dụng", message: "Tính năng này chỉ có trong ứng dụng ViSUBLY." };
  }
  return { code: "Lỗi", message: "Tải không thành công. Bấm Thử lại, hoặc Xem log để biết chi tiết." };
}

function describeItemFailure(item) {
  const fromError = describeFailure(item.error);
  if (fromError.code !== "Lỗi") return fromError;
  const logs = Array.isArray(item.logs) ? item.logs.slice(-40).join("\n") : "";
  return describeFailure(`${item.error || ""}\n${logs}`);
}

// ---------- Formatting ----------
function progressPercent(item) {
  return Math.round(Math.max(0, Math.min(100, Number(item?.progress) || 0)));
}

function etaShort(seconds) {
  const value = Number(seconds);
  if (seconds === null || seconds === undefined || !Number.isFinite(value) || value <= 0) return "";
  return `còn ${formatClock(value)}`;
}

function etaLong(seconds) {
  const value = Number(seconds);
  if (seconds === null || seconds === undefined || !Number.isFinite(value) || value <= 0) return "";
  if (value < 60) return "còn chưa tới 1 phút";
  if (value < 3600) return `còn khoảng ${Math.round(value / 60)} phút`;
  const hours = Math.floor(value / 3600);
  const minutes = Math.round((value % 3600) / 60);
  return `còn khoảng ${hours} giờ${minutes ? ` ${minutes} phút` : ""}`;
}

function typeLabel(type) {
  const value = String(type || "").toLowerCase();
  return { m3u8: "HLS", hls: "HLS", mp4: "MP4", dash: "DASH" }[value] || (value ? value.toUpperCase() : "VIDEO");
}

function qualityText(item) {
  const match = String(item?.selectedQuality || "").match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/i);
  if (match) return resolutionLabelFromSize(Number(match[1]), Number(match[2]));
  return "";
}

function sizeText(item) {
  if (item.status === "done" && item.fileSize) return formatBytes(item.fileSize);
  const duration = Number(item.estimatedDuration) || 0;
  const variant = Array.isArray(item.variants) ? item.variants.find((entry) => entry.url && entry.url === item.selectedUrl) : null;
  const bandwidth = Number(variant?.bandwidth) || 0;
  return duration && bandwidth ? `~${formatBytes((bandwidth * duration) / 8)}` : "";
}

function formatTimeOfDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")} ${time}`;
}

function stripVideoExtension(name) {
  return String(name || "").replace(/\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|ts|m2ts|mts)$/i, "");
}

// ---------- Toast + intro ----------
function showToast(message) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("is-visible");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function introVersionKey() {
  return desktop.boot?.version || "dev";
}

function shouldShowIntro() {
  try {
    return window.localStorage.getItem(introKey) !== introVersionKey();
  } catch {
    return false;
  }
}

function dismissIntro() {
  if (!state.intro) return;
  state.intro = false;
  if (introTimer) window.clearTimeout(introTimer);
  introTimer = null;
  try {
    window.localStorage.setItem(introKey, introVersionKey());
  } catch {
    // Showing the splash again next launch is harmless.
  }
  const intro = document.querySelector("[data-intro]");
  if (!intro) return;
  intro.classList.add("is-leaving");
  window.setTimeout(() => intro.remove(), 240);
}


function currentFolderVideoIndex() {
  if (!state.player.videoPath || !state.folder.videos.length) return -1;
  return state.folder.videos.findIndex((video) => sameLocalPath(video.path, state.player.videoPath));
}

function sameLocalPath(a, b) {
  return normalizeLocalPath(a) === normalizeLocalPath(b);
}

function normalizeLocalPath(value) {
  return String(value || "").replaceAll("/", "\\").toLowerCase();
}

// A reused <video> (fullscreen patch, folder next/prev) may still point at the
// previous source: swap its src in place instead of creating a new element.
function ensureMainPlayerVideoSource(video) {
  const p = state.player;
  if (!p.videoUrl) return;
  if (video.dataset.sourceToken === String(p.sourceToken) && video.dataset.videoUrl === p.videoUrl) return;
  video.dataset.sourceToken = String(p.sourceToken);
  video.dataset.videoUrl = p.videoUrl;
  video.src = p.videoUrl;
  video.load();
}

function attachMainPlayer() {
  const video = document.getElementById("mainPlayerVideo");
  if (!video) return;

  ensureMainPlayerVideoSource(video);
  video.muted = state.player.muted;
  video.volume = state.player.volume;
  const sourceToken = video.dataset.sourceToken;
  const isCurrentSource = () => sourceToken === String(state.player.sourceToken);

  const syncState = () => {
    if (!isCurrentSource()) return;
    state.player.currentTime = video.currentTime || 0;
    state.player.duration = Number.isFinite(video.duration) ? video.duration : state.player.duration;
    state.player.playing = !video.paused && !video.ended;
    updatePlayerUi();
  };

  video.onloadedmetadata = () => {
    if (!isCurrentSource()) return;
    state.player.duration = Number.isFinite(video.duration) ? video.duration : 0;
    // "Xem tiếp" resumes from the saved position once the duration is known.
    const resumeAt = state.player.resumeAt;
    state.player.resumeAt = 0;
    if (resumeAt > 0 && resumeAt < state.player.duration) state.player.currentTime = resumeAt;
    if (state.player.currentTime > 0 && state.player.currentTime < state.player.duration) {
      video.currentTime = state.player.currentTime;
    } else {
      video.currentTime = 0;
      state.player.currentTime = 0;
    }
    if (!video.videoWidth && !video.videoHeight && !state.player.mediaError) {
      // Audio decodes but the picture does not (typically HEVC without hardware support).
      state.player.mediaError = describeMissingVideoTrack();
      render();
      return;
    }
    updatePlayerUi();
    rememberPlayback(video);
  };
  video.ontimeupdate = () => {
    syncState();
    if (isCurrentSource() && !video.paused && Date.now() - lastRecentSaveAt > recentSaveIntervalMs) rememberPlayback(video);
  };
  video.onplay = () => {
    syncState();
    showPlayerControls();
  };
  video.onpause = () => {
    syncState();
    showPlayerControls();
    if (isCurrentSource()) rememberPlayback(video);
  };
  video.onended = () => {
    syncState();
    showPlayerControls();
    if (!isCurrentSource() || playerScrubbing) return;
    // Folder playlists continue with the next file.
    const index = currentFolderVideoIndex();
    if (index >= 0 && index < state.folder.videos.length - 1) openFolderVideo(index + 1);
  };
  video.onerror = () => {
    if (!isCurrentSource() || !video.error) return;
    state.player.playing = false;
    state.player.mediaError = describeMediaError(video.error, state.player.videoPath);
    render();
  };
  video.onvolumechange = () => {
    if (!isCurrentSource()) return;
    state.player.muted = video.muted || video.volume === 0;
    state.player.volume = video.volume;
    if (video.volume > 0) state.player.lastVolume = video.volume;
    savePlayerPrefs();
    updatePlayerUi();
  };

  const scrubber = document.querySelector("[data-player-scrubber]");
  if (scrubber) {
    scrubber.onpointerdown = (event) => {
      if (event.button !== 0 || !state.player.duration) return;
      event.preventDefault();
      playerScrubbing = true;
      scrubber.classList.add("is-scrubbing", "previewing");
      try {
        scrubber.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is best effort.
      }
      updateScrubberPreview(scrubber, event.clientX);
      scrubPlayerTo(scrubber, event.clientX);
    };
    scrubber.onpointermove = (event) => {
      updateScrubberPreview(scrubber, event.clientX);
      if (playerScrubbing) scrubPlayerTo(scrubber, event.clientX);
    };
    const endScrub = (event) => {
      if (!playerScrubbing) return;
      playerScrubbing = false;
      scrubber.classList.remove("is-scrubbing");
      if (event.type === "pointerup") scrubPlayerTo(scrubber, event.clientX, true);
      try {
        scrubber.releasePointerCapture(event.pointerId);
      } catch {
        // Already released.
      }
      if (!scrubber.matches(":hover")) scrubber.classList.remove("previewing");
      schedulePlayerControlsHide();
    };
    scrubber.onpointerup = endScrub;
    scrubber.onpointercancel = endScrub;
    scrubber.onlostpointercapture = endScrub;
    scrubber.onpointerleave = () => {
      if (!playerScrubbing) scrubber.classList.remove("previewing");
    };
  }

  const volumeSlider = document.querySelector("[data-volume-slider]");
  if (volumeSlider) volumeSlider.oninput = (event) => {
    const value = Math.min(1, Math.max(0, Number(event.target.value) || 0));
    setMainPlayerVolume(value);
  };

  if (state.player.playing && video.paused) {
    video.play().catch(() => {
      state.player.playing = false;
      updatePlayerUi();
    });
  }
  updatePlayerUi();
}

function scrubPlayerTo(scrubber, clientX, final = false) {
  const duration = state.player.duration;
  const rect = scrubber.getBoundingClientRect();
  if (!duration || !rect.width) return;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const time = ratio * duration;
  state.player.currentTime = time;
  playerScrubPendingTime = time;
  updatePlayerUi();
  if (final) {
    if (playerScrubFrame) window.cancelAnimationFrame(playerScrubFrame);
    applyPlayerScrub();
    return;
  }
  // Coalesce seeks to one per frame while dragging.
  if (!playerScrubFrame) playerScrubFrame = window.requestAnimationFrame(applyPlayerScrub);
}

function applyPlayerScrub() {
  playerScrubFrame = 0;
  if (playerScrubPendingTime === null) return;
  const time = playerScrubPendingTime;
  playerScrubPendingTime = null;
  seekMainPlayer(time);
}

function describeMediaError(error, videoPath) {
  const ext = (pathExtension(videoPath) || "video").toUpperCase();
  const code = Number(error?.code || 0);
  const technical = String(error?.message || "").trim();
  const missing = code === 2 || /ERR_FILE_NOT_FOUND|ERR_ACCESS_DENIED|ERR_FILE_/i.test(technical);
  if (missing) {
    return {
      kind: "error",
      title: "Không đọc được file video này",
      detail: "Không mở được file. Có thể file đã bị chuyển, đổi tên, xóa, hoặc vẫn đang được tải về.",
      technical
    };
  }
  if (code === 3) {
    return {
      kind: "error",
      title: "Dừng phát: lỗi giải mã",
      detail: `Một phần file ${ext} bị hỏng hoặc dùng codec mà trình phát tích hợp không giải mã được. Hãy mở bằng trình phát hệ thống, hoặc chuyển sang MP4 (H.264 + AAC).`,
      technical
    };
  }
  const legacy = ["AVI", "WMV", "FLV", "ASF", "MPG", "MPEG", "VOB", "TS", "M2TS", "MTS", "3GP", "RM", "RMVB", "DIVX"];
  return {
    kind: "error",
    title: `File ${ext} này không phát được trong ViSUBLY`,
    detail: legacy.includes(ext)
      ? `${ext} dùng định dạng hoặc codec mà trình phát tích hợp không hỗ trợ. Hãy mở bằng trình phát hệ thống, hoặc chuyển sang MP4 (H.264 + AAC).`
      : "Codec video hoặc âm thanh chưa được hỗ trợ (thường là video HEVC/H.265 hoặc âm thanh AC3/DTS). Hãy mở bằng trình phát hệ thống, hoặc chuyển sang MP4 (H.264 + AAC).",
    technical
  };
}

function describeMissingVideoTrack() {
  return {
    kind: "warning",
    title: "Không có hình: không giải mã được video",
    detail: "Âm thanh vẫn có thể phát, nhưng codec video (thường là HEVC/H.265 khi máy không hỗ trợ phần cứng) chưa được trình phát tích hợp hỗ trợ. Hãy mở bằng trình phát hệ thống, hoặc chuyển sang MP4 (H.264 + AAC).",
    technical: ""
  };
}

async function openFolderVideo(index, fallbackPath = "") {
  const video = state.folder.videos[index];
  const videoPath = video?.path || fallbackPath;
  if (!videoPath) return;
  const wasPlayer = state.screen === "player";
  const token = await loadVideoPath(videoPath, {
    displayName: video?.name || "",
    subtitlePath: video?.subtitlePath || "",
    folderContext: {
      folderPath: state.folder.path,
      videoIndex: index,
      videoPath,
      groupName: video?.groupName || "Other"
    }
  });
  // A newer pick (fast next/next clicks) supersedes this one.
  if (token !== state.player.sourceToken) return;
  state.player.playing = true;
  // In fullscreen render() patches the stage in place, so fullscreen survives.
  if (wasPlayer && state.screen === "player") return render();
  return setScreen("player");
}

function stepFolderVideo(delta) {
  const index = currentFolderVideoIndex();
  if (index < 0) return;
  const next = index + delta;
  if (next < 0 || next >= state.folder.videos.length) return;
  return openFolderVideo(next);
}

async function openVideoExternally() {
  const videoPath = state.player.videoPath;
  if (!videoPath || typeof desktop.openInSystemPlayer !== "function") return;
  document.getElementById("mainPlayerVideo")?.pause();
  try {
    const result = await desktop.openInSystemPlayer(videoPath);
    if (result?.ok === false) throw new Error(result.error || "");
  } catch (error) {
    state.player.mediaError = {
      kind: "error",
      title: "Không mở được trình phát hệ thống",
      detail: error?.message || "Windows chưa có ứng dụng nào mở được loại file này.",
      technical: ""
    };
    render();
  }
}

function loadPlayerPrefs() {
  try {
    const prefs = JSON.parse(window.localStorage.getItem(playerPrefsKey) || "null");
    if (!prefs || typeof prefs !== "object") return;
    const volume = Number(prefs.volume);
    if (Number.isFinite(volume)) state.player.volume = Math.min(1, Math.max(0, volume));
    const lastVolume = Number(prefs.lastVolume);
    if (Number.isFinite(lastVolume) && lastVolume > 0) state.player.lastVolume = Math.min(1, lastVolume);
    state.player.muted = Boolean(prefs.muted);
  } catch {
    // Preferences are a convenience; defaults are fine.
  }
}

function savePlayerPrefs() {
  try {
    window.localStorage.setItem(playerPrefsKey, JSON.stringify({
      volume: state.player.volume,
      lastVolume: state.player.lastVolume,
      muted: state.player.muted
    }));
  } catch {
    // Storage may be unavailable.
  }
}

function attachFolderThumbs() {
  const thumbs = [...document.querySelectorAll("[data-folder-thumb]")];
  const observer = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const video = entry.target;
          observer.unobserve(video);
          queueFolderThumb(video);
        }
      }, {
        root: document.querySelector(".folder-screen"),
        rootMargin: "260px 0px",
        threshold: 0.01
      })
    : null;

  thumbs.forEach((video) => {
    const holder = video.closest(".folder-thumb");
    if (!holder) return;

    video.addEventListener("loadedmetadata", () => {
      const duration = Number(video.duration || 0);
      updateFolderResolution(video);
      if (!Number.isFinite(duration) || duration <= 0) return;
      try {
        video.currentTime = Math.min(4, Math.max(0.2, duration * 0.08));
      } catch {
        // Some codecs expose metadata but do not allow seeking before playback.
      }
    }, { once: true });

    video.addEventListener("loadeddata", () => {
      holder.classList.add("loaded");
      completeFolderThumb(video);
    }, { once: true });

    video.addEventListener("error", () => {
      holder.classList.add("broken");
      completeFolderThumb(video);
    }, { once: true });

    if (observer) observer.observe(video);
    else queueFolderThumb(video);
  });
}

function queueFolderThumb(video) {
  if (video.src || !video.dataset.src || video.dataset.queued === "true") return;
  video.dataset.queued = "true";
  folderThumbQueue.push(video);
  pumpFolderThumbQueue();
}

function pumpFolderThumbQueue() {
  if (state.screen !== "folder") return;
  while (folderThumbActive < maxFolderThumbLoads && folderThumbQueue.length) {
    const video = folderThumbQueue.shift();
    if (!video || video.src || !video.dataset.src) continue;
    folderThumbActive += 1;
    loadFolderThumb(video);
  }
}

function loadFolderThumb(video) {
  if (video.src || !video.dataset.src) return;
  video.src = video.dataset.src;
  video.load();
  window.setTimeout(() => completeFolderThumb(video), 1800);
}

function completeFolderThumb(video) {
  if (video.dataset.done === "true") return;
  video.dataset.done = "true";
  folderThumbActive = Math.max(0, folderThumbActive - 1);
  pumpFolderThumbQueue();
}

function updateFolderResolution(video) {
  const width = Number(video.videoWidth || 0);
  const height = Number(video.videoHeight || 0);
  const label = resolutionLabelFromSize(width, height);
  if (!label) return;

  const index = Number(video.dataset.videoIndex);
  if (Number.isInteger(index) && state.folder.videos[index]) {
    state.folder.videos[index].width = width;
    state.folder.videos[index].height = height;
    state.folder.videos[index].resolutionLabel = label;
  }

  const tag = document.querySelector(`[data-folder-resolution="${index}"]`);
  if (tag) tag.textContent = label;
}

function updateScrubberPreview(scrubber, clientX) {
  if (!state.player.duration) return;
  const rect = scrubber.getBoundingClientRect();
  if (!rect.width) return;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const previewTime = ratio * state.player.duration;
  const tooltip = scrubber.querySelector("[data-player-scrubber-tooltip]");
  scrubber.style.setProperty("--hover-x", `${ratio * 100}%`);
  scrubber.classList.add("previewing");
  if (tooltip) tooltip.textContent = formatHoverClock(previewTime);
}

function updatePlayerUi() {
  const p = state.player;
  const hasTrack = hasRealSubtitleTrack();
  const text = hasTrack ? activeSubtitleText(p.currentTime) : "";
  const subtitleBox = document.querySelector(".visubly-subtitle");
  if (subtitleBox) subtitleBox.classList.toggle("is-empty", !text);

  const subtitle = document.querySelector(".main-subtitle-text");
  if (subtitle && subtitle.textContent !== text) subtitle.textContent = text;

  const time = document.querySelector(".player-time");
  if (time) time.textContent = `${formatClock(p.currentTime)} / ${formatClock(p.duration)}`;

  const progress = p.duration ? Math.min(100, Math.max(0, (p.currentTime / p.duration) * 100)) : 0;
  const fill = document.querySelector("[data-player-scrubber-fill]");
  if (fill) fill.style.width = `${progress}%`;

  const scrubber = document.querySelector("[data-player-scrubber]");
  if (scrubber) {
    scrubber.setAttribute("aria-valuemax", String(Math.round(p.duration || 0)));
    scrubber.setAttribute("aria-valuenow", String(Math.round(p.currentTime || 0)));
    scrubber.setAttribute("aria-valuetext", `${formatClock(p.currentTime)} trên ${formatClock(p.duration)}`);
  }

  const cueIndex = hasTrack ? p.cues.findIndex((cue) => isCueActive(cue, p.currentTime)) : -1;
  if (cueIndex !== p.activeCueIndex) {
    p.activeCueIndex = cueIndex;
    document.querySelectorAll(".transcript-line.active").forEach((line) => line.classList.remove("active"));
    const activeLine = cueIndex >= 0 ? document.querySelector(`.transcript-line[data-cue-index="${cueIndex}"]`) : null;
    if (activeLine) {
      activeLine.classList.add("active");
      // Scroll the transcript panel only, never the page.
      scrollChildIntoContainer(activeLine.closest(".player-transcript"), activeLine, "smooth");
    }
  }

  const playButton = document.querySelector('[data-action="toggle-player"]');
  const playState = p.playing ? "playing" : "paused";
  if (playButton && playButton.dataset.state !== playState) {
    const label = p.playing ? "Tạm dừng (Space)" : "Phát (Space)";
    playButton.dataset.state = playState;
    playButton.innerHTML = icon(p.playing ? "pause" : "play");
    playButton.title = label;
    playButton.setAttribute("aria-label", label);
  }

  const muteButton = document.querySelector('[data-action="toggle-mute"]');
  const muteState = p.muted ? "muted" : "sound";
  if (muteButton && muteButton.dataset.state !== muteState) {
    const label = p.muted ? "Bật tiếng (M)" : "Tắt tiếng (M)";
    muteButton.dataset.state = muteState;
    muteButton.innerHTML = icon(p.muted ? "volumeOff" : "volume");
    muteButton.title = label;
    muteButton.setAttribute("aria-label", label);
    muteButton.setAttribute("aria-pressed", p.muted ? "true" : "false");
    muteButton.classList.toggle("danger", p.muted);
  }

  const visibleVolume = p.muted ? 0 : p.volume;
  const volumeSlider = document.querySelector("[data-volume-slider]");
  if (volumeSlider) {
    if (document.activeElement !== volumeSlider || Number(volumeSlider.value) !== visibleVolume) volumeSlider.value = String(visibleVolume);
    volumeSlider.style.setProperty("--volume-level", `${visibleVolume * 100}%`);
    volumeSlider.setAttribute("aria-valuetext", `${Math.round(visibleVolume * 100)}%`);
  }

  const volumeValue = document.querySelector(".volume-value");
  if (volumeValue) volumeValue.textContent = `${Math.round(visibleVolume * 100)}%`;
}

function toggleMainPlayer() {
  const video = document.getElementById("mainPlayerVideo");
  if (!video || state.player.mediaError?.kind === "error") return;
  if (video.paused || video.ended) {
    video.play().catch(() => {
      state.player.playing = false;
      updatePlayerUi();
    });
  } else {
    video.pause();
  }
}

function toggleMainMute() {
  const video = document.getElementById("mainPlayerVideo");
  if (!video) return;
  if (video.muted || video.volume === 0) {
    video.volume = state.player.lastVolume || 0.8;
    video.muted = false;
  } else {
    video.muted = true;
  }
  state.player.muted = video.muted;
  state.player.volume = video.volume;
  savePlayerPrefs();
  updatePlayerUi();
}

function setMainPlayerVolume(value) {
  const video = document.getElementById("mainPlayerVideo");
  if (!video) return;
  const nextVolume = Math.min(1, Math.max(0, Math.round((Number(value) || 0) * 100) / 100));
  video.volume = nextVolume;
  video.muted = nextVolume === 0;
  state.player.volume = nextVolume;
  state.player.muted = video.muted;
  if (nextVolume > 0) state.player.lastVolume = nextVolume;
  savePlayerPrefs();
  updatePlayerUi();
  showPlayerControls();
}

function adjustMainPlayerVolume(delta) {
  const currentVolume = state.player.muted ? 0 : state.player.volume;
  setMainPlayerVolume(currentVolume + delta);
}

function suspendMainPlayerForNavigation() {
  const video = document.getElementById("mainPlayerVideo");
  state.player.lastSuspendedAt = Date.now();
  state.player.playing = false;
  clearPlayerControlsTimer();
  playerControlsHidden = false;
  if (!video) return;

  state.player.currentTime = video.currentTime || state.player.currentTime || 0;
  state.player.duration = Number.isFinite(video.duration) ? video.duration : state.player.duration;
  state.player.muted = video.muted || video.volume === 0;
  state.player.volume = video.volume;
  if (video.volume > 0) state.player.lastVolume = video.volume;

  try {
    video.pause();
  } catch {
    // Best-effort pause before replacing the screen.
  }
}

function toggleTheaterMode() {
  if (state.screen !== "player" || !state.player.videoUrl) return;
  // Theater is the layout underneath fullscreen; change it after leaving fullscreen.
  if (getFullscreenElement()) return;
  state.player.theater = !state.player.theater;
  render();
  showPlayerControls();
}

async function togglePlayerFullscreen() {
  if (state.screen !== "player" || !state.player.videoUrl) return;
  if (getFullscreenElement()) {
    try {
      await exitDocumentFullscreen();
    } catch {
      syncFullscreenState();
    }
    return;
  }

  // Only the video stage (picture + subtitles + overlay bar) goes fullscreen.
  const stage = document.querySelector("[data-player-stage]");
  if (!stage) return;
  try {
    await requestElementFullscreen(stage);
  } catch {
    syncFullscreenState();
  }
}

function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;
}

function isDocumentFullscreen() {
  return Boolean(getFullscreenElement());
}

function isPlayerStageFullscreen() {
  const element = getFullscreenElement();
  return Boolean(element && element.isConnected && element.matches?.("[data-player-stage]"));
}

function requestElementFullscreen(element) {
  if (element.requestFullscreen) return Promise.resolve(element.requestFullscreen({ navigationUI: "hide" }));
  const request = element.webkitRequestFullscreen || element.msRequestFullscreen;
  if (!request) return Promise.resolve();
  return Promise.resolve(request.call(element));
}

function exitDocumentFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (!exit || !getFullscreenElement()) return Promise.resolve();
  return Promise.resolve(exit.call(document));
}

// Runs for every fullscreen enter/exit (button, F, double click, Esc, F11).
function syncFullscreenState() {
  state.player.fullscreen = isPlayerStageFullscreen();
  if (state.screen !== "player") return;
  // Entering: render() patches the fullscreen stage in place (overlay classes, exit icon).
  // Leaving: full render back to the window/theater layout, reusing the same <video>.
  render();
  showPlayerControls();
}

function showPlayerControls() {
  playerControlsHidden = false;
  document.querySelector("[data-player-stage]")?.classList.remove("is-controls-idle");
  schedulePlayerControlsHide();
}

function schedulePlayerControlsHide() {
  clearPlayerControlsTimer();
  const stage = document.querySelector("[data-player-stage]");
  if (!stage || !stage.classList.contains("is-overlay") || !state.player.playing) return;
  playerControlsIdleTimer = window.setTimeout(hidePlayerControlsWhenIdle, playerControlsIdleMs);
}

function hidePlayerControlsWhenIdle() {
  playerControlsIdleTimer = null;
  const stage = document.querySelector("[data-player-stage]");
  if (!stage || !stage.classList.contains("is-overlay") || !state.player.playing) return;
  if (playerControlsPinned(stage)) {
    schedulePlayerControlsHide();
    return;
  }
  hidePlayerControls(stage);
}

function hidePlayerControls(stage) {
  clearPlayerControlsTimer();
  playerControlsHidden = true;
  stage.classList.add("is-controls-idle");
}

// The overlay bar stays up while scrubbing, hovering the bar/playlist, showing an
// error, or while a control has keyboard focus.
function playerControlsPinned(stage) {
  if (playerScrubbing) return true;
  if (stage.querySelector(".player-console:hover, .player-folder-rail:hover, .player-error")) return true;
  const active = document.activeElement;
  return Boolean(playerKeyboardModality && active && stage.contains(active) && active.closest(".player-console, .player-folder-rail"));
}

function syncPlayerControlsVisibility() {
  const stage = document.querySelector("[data-player-stage]");
  if (!stage || !stage.classList.contains("is-overlay")) {
    clearPlayerControlsTimer();
    playerControlsHidden = false;
    return;
  }
  if (!playerControlsHidden) schedulePlayerControlsHide();
}

function clearPlayerControlsTimer() {
  if (!playerControlsIdleTimer) return;
  window.clearTimeout(playerControlsIdleTimer);
  playerControlsIdleTimer = null;
}

function seekMainPlayer(seconds) {
  const video = document.getElementById("mainPlayerVideo");
  const duration = state.player.duration || (video && Number.isFinite(video.duration) ? video.duration : 0);
  let target = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (duration) target = Math.min(target, duration);
  state.player.currentTime = target;
  if (video) {
    video.currentTime = target;
    updatePlayerUi();
  } else {
    render();
  }
}

function seekMainPlayerBy(delta) {
  const video = document.getElementById("mainPlayerVideo");
  const now = video && video.readyState > 0 ? video.currentTime : state.player.currentTime;
  seekMainPlayer(now + delta);
}

function emptyFolderState() {
  return {
    path: "",
    name: "",
    videos: [],
    visibleLimit: folderPageSize,
    scanning: false,
    error: "",
    scannedAt: "",
    skippedFolders: 0,
    truncated: false,
    pendingScrollPath: ""
  };
}

async function chooseVideoFolder() {
  state.folder = { ...state.folder, scanning: true, error: "" };
  render();

  try {
    const result = await desktop.selectVideoFolder();
    if (!result) {
      state.folder = { ...state.folder, scanning: false };
      render();
      return;
    }
    applyFolderScan(result);
  } catch (error) {
    state.folder = { ...state.folder, scanning: false, error: error?.message || "Không quét được thư mục này." };
  }

  render();
}

async function rescanVideoFolder() {
  if (!state.folder.path) return chooseVideoFolder();
  state.folder = { ...state.folder, scanning: true, error: "" };
  render();

  try {
    const result = await desktop.scanVideoFolder(state.folder.path);
    applyFolderScan(result);
  } catch (error) {
    state.folder = { ...state.folder, scanning: false, error: error?.message || "Không quét lại được thư mục này." };
  }

  render();
}

function extractVideoPrefix(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const match = base.match(/^(.*?)[-_\s]*\d+.*$/);
  if (match && match[1].length >= 3) {
    return match[1].trim().toUpperCase();
  }
  return null;
}

function applyFolderScan(result = {}) {
  let videos = Array.isArray(result.videos) ? result.videos : [];
  
  videos.forEach(v => {
    v.folderName = v.folder || "Thư mục này";
    v.prefixRaw = extractVideoPrefix(v.name || pathBaseName(v.path));
  });

  const prefixCounts = {};
  videos.forEach(v => {
    if (v.prefixRaw) {
      const key = v.folderName + "::" + v.prefixRaw;
      prefixCounts[key] = (prefixCounts[key] || 0) + 1;
    }
  });

  videos.forEach(v => {
    if (v.prefixRaw) {
      const key = v.folderName + "::" + v.prefixRaw;
      v.prefixName = prefixCounts[key] >= 2 ? v.prefixRaw : null;
    } else {
      v.prefixName = null;
    }
    v.groupName = v.prefixName || "Other";
  });

  videos.sort((a, b) => {
    if (a.folderName !== b.folderName) return a.folderName.localeCompare(b.folderName);
    
    if (a.groupName !== b.groupName) {
      if (a.groupName === "Other") return 1;
      if (b.groupName === "Other") return -1;
      return a.groupName.localeCompare(b.groupName);
    }
    
    const nameA = a.name || "";
    const nameB = b.name || "";
    return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
  });

  state.folder = {
    path: String(result.path || ""),
    name: String(result.name || pathBaseName(result.path) || result.path || ""),
    videos: videos,
    visibleLimit: folderPageSize,
    renderReady: true,
    scanning: false,
    error: "",
    scannedAt: String(result.scannedAt || new Date().toISOString()),
    skippedFolders: Number(result.skippedFolders || 0),
    truncated: Boolean(result.truncated)
  };
}

async function loadVideoPath(pathValue, options = {}) {
  if (!pathValue) return state.player.sourceToken;
  const sourceToken = setVideoPath(pathValue, options);
  try {
    const url = await desktop.toFileUrl(pathValue);
    if (sourceToken !== state.player.sourceToken) return sourceToken;
    if (url) state.player.videoUrl = url;
  } catch {
    if (sourceToken !== state.player.sourceToken) return sourceToken;
    state.player.videoUrl = localPathToFileUrl(pathValue);
  }

  if (options.subtitlePath && await loadSubtitlePath(options.subtitlePath, sourceToken)) return sourceToken;

  try {
    const matchingSubtitle = await desktop.findMatchingSubtitle(pathValue);
    if (sourceToken !== state.player.sourceToken) return sourceToken;
    if (matchingSubtitle) await loadSubtitlePath(matchingSubtitle, sourceToken);
  } catch {
    // No sidecar subtitle: the video simply plays without captions (never demo text).
  }
  return sourceToken;
}

async function loadSubtitlePath(pathValue, sourceToken = state.player.sourceToken) {
  if (!pathValue) return false;
  let text = "";
  try {
    text = await desktop.readSubtitleText(pathValue);
  } catch {
    text = "";
  }
  if (sourceToken !== state.player.sourceToken) return false;
  const cues = parseSrt(text);
  if (!cues.length) {
    // Keep whatever track is already loaded and tell the user why nothing changed.
    state.player.subtitleNotice = `Không đọc được câu phụ đề nào từ ${pathBaseName(pathValue)}. Hãy kiểm tra đó là file SRT hoặc WebVTT hợp lệ.`;
    return false;
  }
  state.player.srtPath = pathValue;
  state.player.cues = cues;
  state.player.subtitleNotice = "";
  state.player.activeCueIndex = -1;
  // Do not touch currentTime: loading captions mid-video must not restart playback.
  return true;
}

function setVideoPath(pathValue, options = {}) {
  state.player.sourceToken += 1;
  const currentVideo = document.getElementById("mainPlayerVideo");
  if (currentVideo) {
    currentVideo.pause();
    currentVideo.removeAttribute("src");
    currentVideo.load();
  }

  const parts = pathValue.split(/[\\/]/);
  const fileName = parts[parts.length - 1] || "video.mkv";
  const displayFileName = displayNameWithExtension(options.displayName, fileName);
  state.player.videoPath = pathValue;
  state.player.displayName = displayFileName;
  state.player.videoUrl = localPathToFileUrl(pathValue);
  state.player.currentTime = 0;
  state.player.resumeAt = 0;
  state.player.duration = 0;
  state.player.playing = false;
  state.player.activeCueIndex = -1;
  // Drop the previous video's captions/errors so they never flash over the new file.
  state.player.srtPath = "";
  state.player.cues = [];
  state.player.subtitleNotice = "";
  state.player.mediaError = null;
  state.player.folderContext = options.folderContext || null;
  return state.player.sourceToken;
}

function hasRealSubtitleTrack() {
  return Boolean(state.player.srtPath && state.player.cues.length);
}

function isCueActive(cue, seconds) {
  const time = Number(seconds) || 0;
  return time >= cue.start && time < cue.end;
}

function activeSubtitleText(seconds) {
  if (!state.player.subtitleOn) return "";
  // Overlapping cues (two speakers, signs + dialogue) are shown together.
  return findActiveCues(seconds).map((cue) => cue.text).join("\n");
}

function findActiveCues(seconds) {
  return state.player.cues.filter((cue) => isCueActive(cue, seconds));
}

// Line-based SRT/WebVTT parser: tolerates a BOM, CRLF/CR line endings, whitespace-only
// "blank" lines, missing index lines, missing blank lines between cues, VTT headers,
// NOTE/STYLE blocks, cue settings and inline markup.
function parseSrt(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .split(/\r\n|\r|\n/);
  const cues = [];
  let current = null;
  let closed = false;

  const finish = () => {
    if (!current) return;
    const cueText = cleanCueText(current.lines.join("\n"));
    if (cueText && current.end > current.start) cues.push({ start: current.start, end: current.end, text: cueText });
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const timing = parseCueTiming(line);
    if (timing) {
      // No blank line before this cue: the previous text's last line is its index.
      if (current && !closed && /^\d+$/.test(current.lines[current.lines.length - 1] || "")) current.lines.pop();
      finish();
      current = { ...timing, lines: [] };
      closed = false;
      continue;
    }
    if (!current || closed) continue;
    if (!line) {
      if (current.lines.length) closed = true;
      continue;
    }
    current.lines.push(line);
  }
  finish();
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

function parseCueTiming(line) {
  if (!line.includes("-->")) return null;
  const [left, right = ""] = line.split("-->");
  const start = parseSrtTime(left.trim().split(/\s+/).pop());
  const end = parseSrtTime(right.trim().split(/\s+/)[0]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

function cleanCueText(text) {
  return String(text || "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\\N/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lrm;|&rlm;/gi, "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function parseSrtTime(value) {
  const match = String(value || "").trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/);
  if (!match) return Number.NaN;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number((match[4] || "0").padEnd(3, "0"));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function formatClock(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function formatHoverClock(seconds) {
  return formatClock(seconds);
}

function resolutionLabelFromSize(width, height) {
  const w = Number(width || 0);
  const h = Number(height || 0);
  if (!w || !h) return "";
  const edge = Math.min(w, h);
  if (edge >= 2160) return "2160p";
  if (edge >= 1440) return "1440p";
  if (edge >= 1080) return "1080p";
  if (edge >= 720) return "720p";
  if (edge >= 480) return "480p";
  if (edge >= 360) return "360p";
  return `${Math.round(edge)}p`;
}

function inferResolutionFromName(value) {
  const match = String(value || "").match(/(?:^|[^0-9])([248]80|360|540|720|1080|1440|2160|4320)p(?:[^0-9]|$)/i);
  return match ? `${match[1]}p` : "";
}

function hasFolderVideoSubtitle(video = {}) {
  return Boolean(
    video.hasSubtitle ||
    video.subtitlePath ||
    video.subtitleName ||
    hasSubbedVideoMarker(video.name || video.path)
  );
}

function hasSubbedVideoMarker(value) {
  const stem = pathBaseName(value).replace(/\.[^.]+$/, "");
  return /(?:^|[-_.\s])vs(?:$|[-_.\s])/i.test(stem);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function formatShortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function localPathToFileUrl(pathValue) {
  const raw = String(pathValue || "");
  if (!raw || /^(file|https?|blob):/i.test(raw)) return raw;
  const normalized = raw.replace(/\\/g, "/");
  const prefixed = /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
  return `file://${encodeURI(prefixed).replaceAll("#", "%23")}`;
}

function pathBaseName(pathValue) {
  const parts = String(pathValue || "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function pathExtension(pathValue) {
  const match = pathBaseName(pathValue).match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function displayNameWithExtension(displayName, fallbackFileName) {
  const name = String(displayName || "").trim();
  if (!name) return fallbackFileName;
  if (/\.[^.\\/]+$/.test(name)) return name;
  const extension = pathExtension(fallbackFileName);
  return extension ? `${name}.${extension}` : name;
}

function isSubtitlePath(pathValue) {
  return ["srt", "vtt"].includes(pathExtension(pathValue));
}

function isVideoPath(pathValue) {
  // Accept every container the folder scanner lists; unsupported codecs get a clear error state.
  return ["mp4", "m4v", "mov", "mkv", "webm", "ogv", "avi", "wmv", "flv", "ts", "m2ts", "mts", "mpg", "mpeg", "3gp"].includes(pathExtension(pathValue));
}

function groupLabel(name) {
  return !name || name === "Other" ? "Khác" : String(name);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\n", "&#10;");
}

function initAirPlayPairingBridge() {
  if (desktop.airplay?.onPairingRequested) {
    desktop.airplay.onPairingRequested((pin) => {
      state.remote.pairingPin = pin;
      state.remote.pairingActive = true;
      render();
    });
  }
  if (desktop.airplay?.onPairingSuccess) {
    desktop.airplay.onPairingSuccess(() => {
      state.remote.pairingPin = null;
      state.remote.pairingActive = false;
      render();
    });
  }
  if (desktop.airplay?.onPowerState) {
    desktop.airplay.onPowerState((payload) => {
      const nextAwake = Boolean(payload?.active);
      const changed = state.remote.awake !== nextAwake;
      state.remote.awake = nextAwake;
      state.remote.awakeReason = payload?.reason || "";
      if (changed) render();
    });
  }
}

async function bootstrap() {
  applyTheme(desktop.boot?.theme || "dark");
  state.intro = shouldShowIntro();
  loadPlayerPrefs();
  initDownloadBridge();
  initCaptureBridge();
  initSettingsBridge();
  initAirPlayPairingBridge();
  render();
  if (state.intro) introTimer = window.setTimeout(dismissIntro, introDurationMs);
  await refreshSettings();
  refreshAppInfo();
  refreshRecent();
  refreshDiskSpace();
  startChromePolling();
}

bootstrap();
