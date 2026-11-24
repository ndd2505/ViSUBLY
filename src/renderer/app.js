"use strict";

const localDownloadFallback = { items: [], parallelItems: 1, localWorkers: 8 };

const desktop = window.visublyDesktop || {
  platform: navigator.platform.toLowerCase().includes("mac") ? "darwin" : "win32",
  minimize: () => {},
  toggleMaximize: () => {},
  close: () => {},
  selectVideo: async () => null,
  selectVideoFolder: async () => null,
  selectSubtitle: async () => null,
  readTextFile: async () => "",
  toFileUrl: async (filePath) => localPathToFileUrl(filePath),
  scanVideoFolder: async () => null,
  findMatchingSubtitle: async () => null,
  download: {
    getState: async () => localDownloadFallback,
    prepareItem: async (payload) => ({
      ok: true,
      item: {
        id: `local-${Date.now()}`,
        name: payload.name || suggestNameFromCurl(payload.source),
        sourceText: payload.source,
        url: payload.source,
        selectedUrl: payload.source,
        quality: payload.quality || "1080",
        selectedQuality: qualityToResolution(payload.quality || "1080"),
        output: `E:\\${payload.name || "video"}.mp4`,
        host: extractHost(payload.source),
        status: "queued",
        phase: "queued",
        progress: 0,
        logs: ["Local browser fallback item."]
      }
    }),
    enqueueItems: async (items) => {
      localDownloadFallback.items.push(...items);
      return { ok: true, items, state: localDownloadFallback };
    },
    startQueue: async () => {
      const active = localDownloadFallback.items.some((item) => ["active", "preparing", "muxing"].includes(item.status));
      const next = active ? null : localDownloadFallback.items.find((item) => item.status === "queued");
      if (next) {
        next.status = "active";
        next.phase = "ffmpeg_download";
        next.progress = Math.max(next.progress || 0, 12);
        next.logs = [...(next.logs || []), "Local preview started."];
      }
      return { ok: true, state: localDownloadFallback };
    },
    cancelItem: async (itemId) => {
      const item = localDownloadFallback.items.find((entry) => entry.id === itemId);
      if (item) item.status = "canceled";
      return { ok: true, state: localDownloadFallback };
    },
    retryItem: async (itemId) => {
      const item = localDownloadFallback.items.find((entry) => entry.id === itemId);
      if (item) {
        item.status = "queued";
        item.progress = 0;
      }
      return { ok: true, state: localDownloadFallback };
    },
    removeItem: async (itemId) => {
      localDownloadFallback.items = localDownloadFallback.items.filter((entry) => entry.id !== itemId);
      return { ok: true, state: localDownloadFallback };
    },
    clearCompleted: async () => {
      localDownloadFallback.items = localDownloadFallback.items.filter((item) => item.status !== "done");
      return { ok: true, state: localDownloadFallback };
    },
    openOutput: async () => ({ ok: false, error: "Open output is available in the desktop app." }),
    revealOutput: async () => ({ ok: false, error: "Reveal output is available in the desktop app." }),
    onEvent: () => () => {},
    onState: () => () => {}
  },
  integrations: {
    startDownloadBatch: async (items) => ({ ok: true, items }),
    generateSubtitle: async (payload) => ({ ok: true, payload })
  }
};

const root = document.getElementById("app-root");
const folderPageSize = 120;
const playerControlsIdleMs = 2500;
const playerPrefsKey = "visubly.player.prefs";

const qualities = [
  { id: "2160", label: "2160p", note: "4K · HEVC · 3.4 GB" },
  { id: "1440", label: "1440p", note: "QHD · 1.9 GB" },
  { id: "1080", label: "1080p", note: "FHD · H.264 · 980 MB" },
  { id: "720", label: "720p", note: "HD · 520 MB" },
  { id: "480", label: "480p", note: "SD · 240 MB" },
  { id: "audio", label: "Audio", note: "m4a · 14 MB" }
];

const sampleCurl = `curl 'https://cdn.streamhub.net/v/8a3ef/master.m3u8'
  -H 'Referer: https://watch.streamhub.net/'
  -H 'User-Agent: Mozilla/5.0'
  --cookie 'sid=NVe...'`;

const flaggedSegments = [
  {
    id: "00:14:22",
    source: "Don't get your knickers in a twist, mate.",
    claude: "Đừng có nóng tính thế, anh bạn.",
    chatgpt: "Bình tĩnh nào ông tướng, làm gì căng vậy.",
    hint: "ChatGPT keeps the teasing tone instead of making it stern."
  },
  {
    id: "00:18:09",
    source: "This has all gone pear-shaped, hasn't it?",
    claude: "Mọi thứ đang đi chệch hướng cả rồi, đúng không?",
    chatgpt: "Mọi thứ rối tinh rối mù hết rồi, phải không?",
    hint: "The second option reads more natural in spoken Vietnamese."
  },
  {
    id: "00:27:46",
    source: "Right, I'm off to the loo.",
    claude: "Được rồi, tôi đi vệ sinh đây.",
    chatgpt: "Thôi, tao đi cái đã.",
    hint: "Casual register matters because the speaker is joking with a friend."
  },
  {
    id: "00:31:04",
    source: "He's barking up the wrong tree.",
    claude: "Cậu ấy đang đánh giá sai vấn đề.",
    chatgpt: "Cậu ấy đang bắt nhầm hướng rồi.",
    hint: "ChatGPT preserves the idiom as a conversational image."
  },
  {
    id: "00:36:18",
    source: "Easy as pie.",
    claude: "Thế là xong, dễ như ăn bánh.",
    chatgpt: "Xong xuôi rồi đó, dễ như húp cháo!",
    hint: "Both are localized. The second sounds more like dialogue."
  }
];

const state = {
  screen: "home",
  intro: true,
  download: {
    phase: "input",
    step: 0,
    curl: "",
    name: "",
    quality: "1080",
    items: [],
    active: -1,
    preparing: false,
    prepareError: "",
    actionError: "",
    terminalItemId: "",
    parallelItems: 1
  },
  subtitle: {
    videoPath: "D:\\Movies\\Inside_No9_S08E04.mkv",
    fileName: "Inside_No9_S08E04.mkv",
    movieTitle: "Inside No.9 · S08E04",
    movieEdited: false,
    cast: ["Reece Shearsmith", "Steve Pemberton"],
    castDraft: "",
    processing: {
      running: false,
      values: [0, 0, 0, 0, 0],
      done: false
    }
  },
  approvals: {
    cursor: 0,
    decisions: Array(flaggedSegments.length).fill(null),
    customText: ""
  },
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
  },
  playerMode: "vi"
};

let downloadTimer = null;
let processingTimer = null;
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

function icon(name) {
  const paths = {
    home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
    download: '<path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    sub: '<path d="M4 5h16v10H8l-4 4z"/><path d="M8 9h8"/><path d="M8 12h5"/>',
    play: '<path d="M8 5v14l11-7z"/>',
    video: '<path d="M4 6h11v12H4z"/><path d="m15 10 5-3v10l-5-3z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3.2 3 14.8 0 18"/><path d="M12 3c-3 3.2-3 14.8 0 18"/>',
    settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/><path d="M4 12h2"/><path d="M18 12h2"/><path d="M12 4v2"/><path d="M12 18v2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/>',
    bell: '<path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9"/><path d="M10 21h4"/>',
    arrowR: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    arrowL: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    x: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    check: '<path d="m5 13 4 4L19 7"/>',
    brain: '<path d="M9 4a4 4 0 0 0-4 4v8a4 4 0 0 0 4 4"/><path d="M15 4a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4"/><path d="M9 4c2 1 4 1 6 0"/><path d="M9 20c2-1 4-1 6 0"/>',
    folder: '<path d="M3 6h7l2 2h9v10H3z"/>',
    edit: '<path d="M4 20h4l11-11-4-4L4 16z"/><path d="m14 6 4 4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
    volume: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15 9.5a4 4 0 0 1 0 5"/><path d="M18 7a8 8 0 0 1 0 10"/>',
    volumeOff: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 5"/><path d="m21 9-5 5"/>',
    captions: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 12h4"/><path d="M13 12h4"/><path d="M7 15h7"/>',
    theater: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 6v12"/><path d="M17 6v12"/><path d="M7 10h10"/><path d="M7 14h10"/>',
    fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    fullscreenExit: '<path d="M9 3v4a2 2 0 0 1-2 2H3"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/><path d="M9 21v-4a2 2 0 0 0-2-2H3"/><path d="M15 21v-4a2 2 0 0 1 2-2h4"/>',
    minus: '<path d="M5 12h14"/>',
    pause: '<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>',
    rewind: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4.6h4.6"/>',
    forward: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.5v4.6h-4.6"/>',
    skipPrev: '<path d="M6 5v14"/><path d="M19 5 9 12l10 7z"/>',
    skipNext: '<path d="M18 5v14"/><path d="M5 5l10 7-10 7z"/>'
  };
  return `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.home}</svg>`;
}

function logo() {
  return `<div class="logo"><img class="logo-icon" src="./assets/brand/visubly-app-logo-concept-v2.png" alt=""><span class="logo-word">ViSUBLY</span></div>`;
}

function starSvg(className = "") {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12,1.5 14.85,8.95 22.85,9.4 16.6,14.4 18.7,22.2 12,17.85 5.3,22.2 7.4,14.4 1.15,9.4 9.15,8.95" fill="var(--vi-star)" stroke="var(--ink)" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
}

function btn(label, action, classes = "", iconName = "", attrs = "") {
  const iconHtml = iconName ? icon(iconName) : "";
  return `<button class="btn ${classes}" data-action="${action}" ${attrs}>${iconHtml}<span>${label}</span></button>`;
}

function setScreen(screen) {
  if (state.screen === "player" && screen !== "player") suspendMainPlayerForNavigation();
  if (screen === "folder" && !state.folder.visibleLimit) state.folder.visibleLimit = folderPageSize;
  if (screen === "folder") {
    state.folder.renderReady = false;
    scheduleFolderRender();
  } else {
    cancelFolderRender();
  }
  state.screen = screen;
  render();
}

function titleForScreen() {
  return {
    home: "Visubly",
    download: "Visubly · Download",
    subtitle: "Visubly · Subtitle",
    processing: "Visubly · Working",
    approve: "Visubly · Approve",
    player: "Visubly · Player",
    folder: "Visubly · Folder",
    library: "Visubly · Library",
    settings: "Visubly · Settings"
  }[state.screen] || "Visubly";
}

function render(options = {}) {
  // While the player stage is fullscreen, replacing root.innerHTML would remove the
  // fullscreen element and kick the user out of fullscreen. Patch the stage instead.
  if (renderPlayerWhileFullscreen()) return;

  const samePlayerScreen = state.screen === "player" && lastRenderedScreen === "player";
  const preserveScroll = options.preserveScroll ?? samePlayerScreen;
  const scrollSnapshot = preserveScroll ? captureScrollSnapshot() : [];
  const folderListMemory = samePlayerScreen ? capturePlayerFolderListScroll() : null;
  // Keep the playing <video> element alive across re-renders: re-inserting it in the
  // same task keeps decoding/playback going instead of reloading the file.
  const keptVideo = takeReusableMainPlayerVideo();
  reuseMainPlayerVideo = Boolean(keptVideo);
  let html = "";
  try {
    html = `
    <div class="shell">
      ${renderTitlebar()}
      <div class="app">
        ${renderSidebar()}
        <main class="main">${renderScreen()}</main>
      </div>
      ${state.intro ? renderIntro() : ""}
      ${renderRemoteModal()}
    </div>
  `;
  } finally {
    reuseMainPlayerVideo = false;
  }
  root.innerHTML = html;
  if (keptVideo) root.querySelector("[data-main-video-slot]")?.replaceWith(keptVideo);
  lastRenderedScreen = state.screen;
  lastRenderedModalKey = remoteModalKey();
  attachDynamicHandlers({ folderListMemory });
  if (scrollSnapshot.length) restoreScrollSnapshot(scrollSnapshot, { immediate: samePlayerScreen });
}

function remoteModalKey() {
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
  const modalKey = remoteModalKey();
  if (modalKey && modalKey !== lastRenderedModalKey) {
    // A pairing PIN / QR modal must be visible: leave fullscreen, the
    // fullscreenchange handler then runs the full render.
    exitDocumentFullscreen().catch(() => {});
  }
  patchPlayerStage();
  return true;
}

function captureScrollSnapshot() {
  const selectors = [
    ".main",
    ".screen",
    ".running-list",
    ".queue-list",
    ".download-terminal",
    ".player-transcript",
    ".folder-screen"
  ];

  return selectors
    .map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      return {
        selector,
        left: element.scrollLeft,
        top: element.scrollTop
      };
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
  // Same-screen player renders restore synchronously so the page never flashes to the top.
  if (options.immediate) apply();
  window.requestAnimationFrame(apply);
}

function renderRemoteModal() {
  if (state.remote.pairingActive && state.remote.pairingPin) {
    return `
      <div class="modal-overlay" style="display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);position:fixed;inset:0;z-index:9999;">
        <div style="background:var(--paper);padding:40px;border-radius:16px;text-align:center;color:var(--ink);box-shadow:0 10px 40px rgba(0,0,0,0.5);border:var(--line)">
          <div style="font-size:48px;margin-bottom:20px">📱</div>
          <h2 class="h2" style="margin-bottom:10px">Yêu cầu ghép nối</h2>
          <p style="margin-bottom:20px;color:var(--ink-soft)">Nhập mã PIN sau trên điện thoại của bạn:</p>
          <div style="font-size:56px;font-weight:900;letter-spacing:10px;background:#eee;padding:20px;border-radius:12px;border:var(--line);margin-bottom:30px;font-family:monospace">${state.remote.pairingPin}</div>
          ${btn("Đóng", "close-remote", "ghost")}
        </div>
      </div>
    `;
  }

  if (!state.remote.qrUrl && !state.remote.loading) return "";
  return `
    <div class="modal-overlay" style="display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);position:fixed;inset:0;z-index:9999;">
      <div style="background:var(--paper);padding:30px;border-radius:16px;text-align:center;color:var(--ink);box-shadow:0 10px 40px rgba(0,0,0,0.5)">
        <h2 class="h2" style="margin-bottom:10px">Visubly Remote</h2>
        <p style="margin-bottom:20px;color:var(--ink)">Lấy điện thoại quét mã QR này để điều khiển.</p>
        ${state.remote.loading ? '<div style="width:250px;height:250px;display:flex;align-items:center;justify-content:center;background:#eee;border-radius:8px">Đang bật...</div>' : `<img src="${state.remote.qrUrl}" alt="QR" width="250" height="250" style="border-radius:8px" />`}
        <p class="muted mono" style="margin-top:14px">${state.remote.awake ? "Stream keep-awake is active; the display can still sleep." : "PC streaming stays awake while the display may turn off."}</p>
        <div style="margin-top:20px; display:flex; gap:10px; justify-content:center;">
          ${btn("Copy Link Test", "copy-remote-link", "primary")}
          ${btn("Đóng", "close-remote", "ghost")}
        </div>
      </div>
    </div>
  `;
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
    <header class="titlebar">
      ${isMac ? `
        <div class="traffic-controls">
          <button class="traffic-dot red" data-action="close" title="Close" aria-label="Close"></button>
          <button class="traffic-dot yellow" data-action="minimize" title="Minimize" aria-label="Minimize"></button>
          <button class="traffic-dot green" data-action="maximize" title="Maximize" aria-label="Maximize"></button>
        </div>
      ` : `<div></div>`}
      <div class="titlebar-title">${titleForScreen()}</div>
      ${isMac ? `<div></div>` : `
        <div class="window-controls">
          <button class="window-btn" data-action="minimize" title="Minimize">─</button>
          <button class="window-btn" data-action="maximize" title="Maximize">□</button>
          <button class="window-btn close" data-action="close" title="Close">×</button>
        </div>
      `}
    </header>
  `;
}

function renderSidebar() {
  const d = state.download.items.filter((item) => item.status !== "done").length;
  const nav = [
    ["home", "Home", "home", ""],
    ["download", "Download", "download", d ? String(d) : ""],
    ["subtitle", "Subtitle", "sub", ""],
    ["player", "Player", "play", ""]
  ];
  const library = [
    ["folder", "Folder", "folder", state.folder.videos.length ? String(state.folder.videos.length) : ""],
    ["library", "My videos", "video", ""],
    ["settings", "Settings", "settings", ""]
  ];

  return `
    <aside class="sidebar">
      <div class="brand">
        ${logo()}
        <span class="version-pill">v0.18</span>
      </div>
      <div class="nav-label">Main</div>
      ${nav.map(([screen, label, iconName, count]) => navItem(screen, label, iconName, count)).join("")}
      <div class="nav-label">Library</div>
      ${library.map(([screen, label, iconName, count]) => navItem(screen, label, iconName, count)).join("")}
      <div class="model-card">
        <div class="mini-row">
          <span class="status-dot"></span>
          <span class="mono">MODEL · LOCAL</span>
        </div>
        <div style="font-weight:900;margin-top:8px">247 videos learned</div>
        <div class="progress-track" style="margin-top:8px"><div class="progress-fill" style="width:63%"></div></div>
        <div class="mono muted" style="margin-top:6px">63% to v0.19</div>
      </div>
    </aside>
  `;
}

function navItem(screen, label, iconName, count) {
  const active = state.screen === screen || (screen === "subtitle" && ["subtitle", "processing", "approve"].includes(state.screen));
  return `
    <button class="nav-item ${active ? "active" : ""}" data-screen="${screen}">
      ${icon(iconName)}
      <span>${label}</span>
      ${count ? `<span class="count">${count}</span>` : ""}
    </button>
  `;
}

function renderScreen() {
  if (state.screen === "home") return renderHome();
  if (state.screen === "download") return renderDownload();
  if (state.screen === "subtitle") return renderSubtitle();
  if (state.screen === "processing") return renderProcessing();
  if (state.screen === "approve") return renderApprove();
  if (state.screen === "player") return renderPlayerStudio();
  if (state.screen === "folder") return renderFolderPlayer();
  if (state.screen === "library") return renderLibrary();
  if (state.screen === "settings") return renderSettings();
  return renderHome();
}

function renderHome() {
  return `
    <section class="screen">
      <div class="top-row">
        <div>
          <div class="eyebrow">Good afternoon, Minh</div>
          <h1 class="h1">What are we <span style="color:var(--coral);font-style:italic">watching</span> today?</h1>
        </div>
        <div style="display:flex;gap:8px">
          ${btn("Bật Remote", "start-remote", "primary", "globe")}
          ${btn("Search", "noop", "ghost", "search")}
          ${btn("", "noop", "icon", "bell", "aria-label='Notifications'")}
        </div>
      </div>

      <div class="grid-2">
        <button class="tile coral" data-screen="download">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <span class="icon-box">${icon("download")}</span>
            <span class="chip" style="background:var(--paper)">01 · GRAB</span>
          </div>
          <div>
            <h2 class="h2">Download from cURL</h2>
            <p class="tile-copy">Paste cURL commands one at a time. Visubly parses qualities and runs the queue item by item.</p>
          </div>
          <div class="mini-row" style="margin-top:auto;justify-content:space-between">
            <span class="mono">2 in queue · 1 finished today</span>
            <span class="btn ghost">Start batch ${icon("arrowR")}</span>
          </div>
        </button>

        <button class="tile violet" data-screen="subtitle">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <span class="icon-box">${icon("sub")}</span>
            <span class="chip" style="background:var(--paper);color:var(--ink)">02 · SUB</span>
          </div>
          <div>
            <h2 class="h2">Subtitle to tiếng Việt</h2>
            <p class="tile-copy">Drop a video, confirm the movie title and cast names, then review only the lines that need human taste.</p>
          </div>
          <div class="mini-row" style="margin-top:auto;justify-content:space-between">
            <span class="mono">247 videos translated · v0.18</span>
            <span class="btn ghost">Open studio ${icon("arrowR")}</span>
          </div>
        </button>
      </div>

      <div class="stat-strip">
        <div class="stat-row">
          <div class="stat-icon">${icon("brain")}</div>
          <div style="flex:1">
            <h3 class="h3">Your local model is learning</h3>
            <div class="muted" style="font-size:13px;margin-top:4px">Every approve, ChatGPT pick, and custom rewrite updates a private glossary on this machine.</div>
          </div>
          <div class="stat-badges">
            ${stat("Accuracy", "87%", "var(--lime)")}
            ${stat("Phrases", "12.4K", "var(--rose)")}
            ${stat("Videos", "247", "var(--mint)")}
          </div>
        </div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
        <h3 class="h3">Recent</h3>
        <span class="mono muted">LAST 7 DAYS</span>
      </div>
      <div class="grid-3">
        ${recent("Inside No.9 · S08E04", "EN → VI · 41 min", "Done", "var(--lime)", "player")}
        ${recent("Le Mans 24h Highlight", "EN → VI · needs approval", "Needs you", "var(--coral)", "approve")}
        ${recent("Conan_OVA_2024.mkv", "JP → VI · queued", "Queued", "var(--paper)", "download")}
      </div>
    </section>
  `;
}

function stat(label, value, color) {
  return `<div class="stat-box" style="background:${color}"><div class="mono muted">${label}</div><div style="font-weight:900;font-size:20px">${value}</div></div>`;
}

function renderMediaThumb(label, clipStart = 0, clipEnd = 6, classes = "") {
  // Only ever preview real subtitle lines; never demo text.
  const cues = hasRealSubtitleTrack() ? state.player.cues : [];
  const cue = cues.find((item) => item.start >= clipStart) || cues[0];
  const subtitle = cue?.text || "Hover preview";
  if (!state.player.videoUrl) {
    return `
      <div class="thumb ${classes}">
        <span class="play-dot">${icon("play")}</span>
        <div class="mini-subtitle">${escapeHtml(subtitle)}</div>
      </div>
    `;
  }

  return `
    <div class="mini-player ${classes}" data-clip-start="${clipStart}" data-clip-end="${clipEnd}" aria-label="${escapeAttr(label)} hover preview">
      <video src="${escapeAttr(state.player.videoUrl)}" muted playsinline preload="metadata"></video>
      <span class="mini-play-dot">${icon("play")}</span>
      <div class="mini-subtitle">${escapeHtml(subtitle)}</div>
    </div>
  `;
}

function recent(title, sub, status, color, screen) {
  const clipStart = screen === "approve" ? 7 : screen === "download" ? 14 : 0;
  return `
    <button class="recent-card" data-screen="${screen}">
      ${renderMediaThumb(title, clipStart, clipStart + 6)}
      <div class="mini-row" style="justify-content:space-between;margin-top:10px;gap:12px">
        <div style="min-width:0;text-align:left">
          <div style="font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${title}</div>
          <div class="mono muted">${sub}</div>
        </div>
        <span class="badge" style="background:${color}">${status}</span>
      </div>
    </button>
  `;
}

function renderDownload() {
  return state.download.phase === "running" ? renderDownloadRunning() : renderDownloadWizard();
}

function renderDownloadWizard() {
  const step = state.download.step;
  const queuedCount = state.download.items.filter((item) => item.status === "queued").length;
  return `
    <section class="screen tight">
      ${screenHeader("01 · GRAB", "Download · Batch builder", `${state.download.items.length} in batch`, "home")}
      <div class="body-grid">
        <div class="wizard-main">
          ${renderStepper(step, ["Paste cURL", "Name it", "Pick quality", "Review"])}
          ${renderWizardStep()}
        </div>
        <aside class="side-panel">
          <div class="mini-row" style="justify-content:space-between">
            <h3 class="h3">Batch queue</h3>
            <span class="badge" style="background:var(--lime)">${state.download.items.length}</span>
          </div>
          <div class="queue-list">
            ${state.download.items.map((item, index) => `
              <div class="queue-item">
                <div class="mini-row" style="justify-content:space-between">
                  <strong>${escapeHtml(item.name)}</strong>
                  <button class="btn ghost icon" data-action="remove-download" data-index="${index}" data-id="${escapeAttr(item.id)}" title="Remove">${icon("x")}</button>
                </div>
                <div class="mono muted">${qualityLabel(item.quality)} · ${escapeHtml(item.host || extractHost(item.url) || "parsed host")}</div>
                <div class="row-progress mini"><div style="width:${Math.round(item.progress || 0)}%"></div></div>
                <div class="mono muted">${statusLabel(item.status)} · ${phaseLabel(item.phase)}</div>
              </div>
            `).join("") || `<div class="empty">No items yet.</div>`}
          </div>
          <div style="margin-top:18px;display:grid;gap:10px">
            ${btn("Start downloads", "start-downloads", "primary", "download", queuedCount ? "" : "disabled")}
            ${btn("Use sample cURL", "use-sample-curl", "", "plus")}
          </div>
        </aside>
      </div>
    </section>
  `;
}

function renderStepper(active, labels) {
  return `<div class="stepper">${labels.map((label, index) => `
    <span class="step-pill ${index === active ? "active" : ""} ${index < active ? "done" : ""}">
      <span class="step-num">${index < active ? "✓" : index + 1}</span>${label}
    </span>
  `).join("")}</div>`;
}

function renderWizardStep() {
  const d = state.download;
  if (d.step === 0) {
    return `
      <div class="form-panel">
        <h2 class="h2">Paste cURL</h2>
        <p class="muted">Paste a plain URL or the full cURL from DevTools. The parser keeps headers and preflights HLS quality before queueing.</p>
        <div class="field">
          <label for="curlInput">cURL command</label>
          <textarea class="textarea" id="curlInput" data-bind="download.curl" placeholder="${escapeAttr(sampleCurl)}">${escapeHtml(d.curl)}</textarea>
        </div>
        ${d.prepareError ? `<div class="note danger-note">${escapeHtml(d.prepareError)}</div>` : ""}
        <div style="display:flex;justify-content:space-between;margin-top:16px">
          ${btn("Use sample", "use-sample-curl", "", "plus")}
          ${btn("Next", "download-next", "primary", "arrowR")}
        </div>
      </div>
    `;
  }
  if (d.step === 1) {
    return `
      <div class="form-panel">
        <h2 class="h2">Name the output</h2>
        <p class="muted">This will become the file name and the default movie title hint in the subtitle flow.</p>
        <div class="field">
          <label for="nameInput">Video name</label>
          <input class="input" id="nameInput" data-bind="download.name" value="${escapeAttr(d.name)}" placeholder="Inside_No9_S08E04">
        </div>
        ${d.qualityError ? `<div class="note danger-note" style="margin-top:12px">${escapeHtml(d.qualityError)}</div>` : ""}
        <div style="display:flex;justify-content:space-between;margin-top:16px">
          ${btn("Back", "download-back", "", "arrowL")}
          ${btn(d.loadingQualities ? "Loading..." : "Next", "download-next", "primary", "arrowR", d.loadingQualities ? "disabled" : "")}
        </div>
      </div>
    `;
  }
  if (d.step === 2) {
    const list = d.dynamicQualities || qualities;
    const isLowQuality = d.maxHeight && d.maxHeight <= 720;
    
    return `
      <div class="form-panel">
        <h2 class="h2">Pick quality</h2>
        <p class="muted">The downloader will use this as the preferred HLS resolution. If it is missing, it keeps the highest available stream.</p>
        
        ${isLowQuality ? `<div class="note danger-note" style="margin-top:12px; border-color:var(--coral); color:var(--coral)">Warning: Maximum resolution is ${d.maxHeight}p. Do you want to proceed?</div>` : ""}

        <div class="quality-grid" style="margin-top:16px">
          ${list.filter((q) => q.id !== "audio").map((q) => `
            <button class="quality-option ${d.quality === q.id ? "selected" : ""}" data-action="pick-quality" data-quality="${q.id}">
              <div style="font-weight:900;font-size:18px">${q.label}</div>
              <div class="mono muted">${q.note}</div>
            </button>
          `).join("")}
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:16px">
          <div style="display:flex; gap:10px">
            ${btn("Back", "download-back", "", "arrowL")}
            ${isLowQuality ? btn("Hủy", "download-cancel-record", "danger") : ""}
          </div>
          ${btn("Next", "download-next", "primary", "arrowR")}
        </div>
      </div>
    `;
  }
  return `
    <div class="form-panel">
      <h2 class="h2">Review item</h2>
      <div class="queue-item" style="margin-top:16px">
        <div class="mini-row" style="justify-content:space-between">
          <strong>${escapeHtml(d.name || "Inside_No9_S08E04")}</strong>
          <span class="badge" style="background:var(--lime)">${qualityLabel(d.quality)}</span>
        </div>
        <div class="mono muted">${escapeHtml(extractHost(d.curl) || "cdn.streamhub.net")} · ready for queue</div>
      </div>
      ${d.preparing ? `<div class="note" style="margin-top:12px">Preparing item and checking playlist...</div>` : ""}
      ${d.prepareError ? `<div class="note danger-note" style="margin-top:12px">${escapeHtml(d.prepareError)}</div>` : ""}
      <div style="display:flex;justify-content:space-between;margin-top:16px">
        ${btn("Back", "download-back", "", "arrowL")}
        ${btn(d.preparing ? "Preparing" : "Add to batch", "add-download-item", "primary", "plus", d.preparing ? "disabled" : "")}
      </div>
    </div>
  `;
}

function renderDownloadRunning() {
  const selectedItem = selectedDownloadItem();
  const busyStatuses = ["active", "preparing", "muxing"];
  const activeCount = state.download.items.filter((item) => busyStatuses.includes(item.status)).length;
  const queuedCount = state.download.items.filter((item) => item.status === "queued").length;
  const doneCount = state.download.items.filter((item) => item.status === "done").length;
  return `
    <section class="screen">
      <div class="top-row">
        <div>
          <div class="eyebrow">01 · GRAB</div>
          <h1 class="h1">Downloading batch</h1>
        </div>
        <div style="display:flex;gap:8px">
          ${doneCount ? btn("Clear done", "clear-finished-downloads", "", "x") : ""}
          ${btn("Edit batch", "edit-batch", "", "arrowL")}
          ${btn("Home", "go-home", "ghost", "home")}
        </div>
      </div>
      <div class="download-status-strip">
        <span>${activeCount} running</span>
        <span>${queuedCount} queued</span>
        <span>${doneCount} done</span>
        <span>1 at a time</span>
      </div>
      ${state.download.actionError ? `<div class="note danger-note download-action-error">${escapeHtml(state.download.actionError)}</div>` : ""}
      <div class="download-workbench">
        <div class="running-list">
        ${state.download.items.map((item, index) => {
          const status = item.status;
          const progress = status === "done" ? 100 : Math.round(item.progress || 0);
          const rowClass = item.id === selectedItem?.id ? "selected" : "";
          const isBusy = busyStatuses.includes(status);
          const canRemove = !isBusy;
          const itemAttrs = `data-id="${escapeAttr(item.id)}"`;
          return `
            <div class="running-row ${rowClass}" data-action="select-download-log" data-id="${escapeAttr(item.id)}">
              <div class="running-row-main">
                <span class="step-index">${index + 1}</span>
                <div style="min-width:0">
                  <div style="font-weight:900">${escapeHtml(item.name)}</div>
                  <div class="mono muted">${phaseLabel(item.phase)} · ${escapeHtml(progressMeta(item))}</div>
                  <div class="mono muted">${qualityLabel(item.quality)} · ${statusLabel(status)}</div>
                </div>
                <div class="download-row-actions">
                  ${isBusy ? btn("Cancel", "cancel-download", "danger", "x", itemAttrs) : ""}
                  ${["failed", "canceled"].includes(status) ? btn("Retry", "retry-download", "primary", "download", itemAttrs) : ""}
                  ${status === "done" && item.output ? btn("Open", "open-download-output", "primary", "play", itemAttrs) : ""}
                  ${status === "done" && item.output ? btn("Folder", "reveal-download-output", "", "folder", itemAttrs) : ""}
                  ${status === "done" ? `<span class="badge" style="background:var(--lime)">✓ ready</span>${btn("Subtitle this", "subtitle-downloaded", "violet", "sub", `data-index="${index}"`)}` : `<span class="badge" style="background:var(--paper)">${Math.round(progress)}%</span>`}
                  ${canRemove ? btn("Remove", "remove-download", "ghost", "x", itemAttrs) : ""}
                </div>
              </div>
              <div class="row-progress"><div style="width:${progress}%"></div></div>
            </div>
          `;
        }).join("") || `<div class="empty">No downloads in this batch.</div>`}
        </div>
        ${renderDownloadTerminal(selectedItem)}
      </div>
    </section>
  `;
}

function renderDownloadTerminal(item) {
  const lines = item?.logs?.length ? item.logs.slice(-80) : ["Queue is ready."];
  return `
    <aside class="download-terminal-panel">
      <div class="mini-row" style="justify-content:space-between">
        <h3 class="h3">Terminal</h3>
        <span class="badge" style="background:var(--paper)">${escapeHtml(item?.status || "idle")}</span>
      </div>
      <div class="mono muted" style="margin:4px 0 10px">${escapeHtml(item?.name || "No item selected")}</div>
      <div class="terminal download-terminal">
        ${lines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
      </div>
      ${item?.output ? `<div class="mono muted terminal-output">${escapeHtml(item.output)}</div>` : ""}
    </aside>
  `;
}

function renderSubtitle() {
  const s = state.subtitle;
  return `
    <section class="screen tight">
      ${screenHeader("02 · SUB", "Subtitle · Set up", "STEP 1 of 2", "home")}
      <div class="subtitle-layout">
        <div>
          <div class="eyebrow">A</div>
          <h3 class="h3" style="margin-bottom:10px">Drop your video</h3>
          <div class="drop-zone" id="dropZone">
            ${renderMediaThumb(s.fileName, 0, 6, "video-card")}
            <div class="video-meta">
              <div style="min-width:0">
                <div style="font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.fileName)}</div>
                <div class="mono muted">41:22 · 1.2 GB · path locked after select</div>
              </div>
              ${btn("Choose", "choose-video", "", "folder")}
            </div>
          </div>

          <div class="field">
            <label for="movieTitle">Movie / show title</label>
            <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px">
              <input class="input" id="movieTitle" data-bind="subtitle.movieTitle" value="${escapeAttr(s.movieTitle)}">
              <span class="badge" style="align-self:center;background:${s.movieEdited ? "var(--rose)" : "var(--lime)"}">${s.movieEdited ? "edited" : "auto"}</span>
            </div>
          </div>
        </div>

        <div>
          <div class="eyebrow">B</div>
          <h3 class="h3" style="margin-bottom:10px">Who is in it?</h3>
          <div class="form-panel" style="max-width:none;box-shadow:none">
            <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px">
              <input class="input" data-bind="subtitle.castDraft" value="${escapeAttr(s.castDraft)}" placeholder="Actor / actress name">
              ${btn("Add", "add-cast", "primary", "plus")}
            </div>
            <div class="cast-list">
              ${s.cast.map((name, index) => `
                <div class="cast-row">
                  <span class="avatar">${escapeHtml(name[0] || "?")}</span>
                  <strong>${escapeHtml(name)}</strong>
                  <button class="btn ghost icon" data-action="remove-cast" data-index="${index}" title="Remove">${icon("x")}</button>
                </div>
              `).join("")}
            </div>
          </div>
          <div class="note" style="margin-top:14px">
            <strong>Visubly will figure out the rest.</strong> Source language is detected automatically. Vietnamese tone stays phổ thông, and the model learns from each approve, ChatGPT pick, or custom fix.
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:18px">
            ${btn("Generate subtitles", "start-processing", "primary", "arrowR")}
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderProcessing() {
  const p = state.subtitle.processing;
  const steps = [
    ["Research + style guide", "Claude Opus", "Finds title/cast context and writes translation guideline.", "var(--rose)", p.values[0]],
    ["Audio → source subtitles", "Whisper v3", "Segments speech into source captions.", "var(--paper)", p.values[1]],
    ["Translate to Vietnamese", "Claude Sonnet", "Translates with the Opus style guide.", "var(--violet)", p.values[2]],
    ["QC vs scene and character", "Claude Opus", "Fixes context, pacing, and character voice.", "var(--lime)", p.values[3]],
    ["Native-tone check", "ChatGPT", "Flags lines that sound less natural in spoken Vietnamese.", "var(--mint)", p.values[4]]
  ];
  return `
    <section class="screen tight">
      ${screenHeader("02 · SUB", "Subtitle · Working on it", "STEP 2 of 2", "subtitle")}
      <div class="pipeline-layout">
        <div class="pipeline-list">
          ${steps.map(([title, model, copy, color, value], index) => `
            <div class="pipeline-step">
              <div class="pipeline-head">
                <span class="step-index">${String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3 class="h3">${title}</h3>
                  <div class="muted" style="font-size:13px">${copy}</div>
                </div>
                <span class="badge" style="background:${color};color:${color === "var(--violet)" ? "var(--paper)" : "var(--ink)"}">${model}</span>
              </div>
              <div class="progress-track" style="margin-top:12px"><div class="progress-fill" style="width:${value}%;background:${color === "var(--paper)" ? "var(--coral)" : color}"></div></div>
              <div class="mono muted" style="margin-top:6px">${Math.round(value)}%</div>
            </div>
          `).join("")}
          <div style="display:flex;justify-content:flex-end">
            ${p.done ? btn("Review flagged lines", "go-approve", "primary", "arrowR") : btn("Processing", "noop", "ghost", "clock")}
          </div>
        </div>
        <aside class="terminal">
          ${pipelineLogs(p.values).map((line) => `<div>${line}</div>`).join("")}
        </aside>
      </div>
    </section>
  `;
}

function renderApprove() {
  const a = state.approvals;
  if (a.cursor >= flaggedSegments.length) return renderApproveDone();
  const seg = flaggedSegments[a.cursor];
  const prior = a.decisions[a.cursor];
  const canBack = a.cursor > 0;
  const canNext = Boolean(a.decisions[a.cursor + 1]);
  return `
    <section class="screen tight">
      ${screenHeader("03 · REVIEW", "Approve · Native-tone choices", `${a.cursor + 1} of ${flaggedSegments.length}`, "processing")}
      <div class="approval-layout">
        <div class="approval-stage">
          ${canBack ? `<button class="nav-arrow left" data-action="approval-back" title="Back">${icon("arrowL")}</button>` : ""}
          ${canNext ? `<button class="nav-arrow right" data-action="approval-next" title="Next">${icon("arrowR")}</button>` : ""}
          <div class="approval-card">
            ${prior ? `<div class="badge" style="display:inline-block;background:var(--lime);margin-bottom:12px">YOU PICKED · ${decisionLabel(prior.pick)}</div>` : `<div class="badge" style="display:inline-block;background:var(--mint);margin-bottom:12px">ChatGPT vs Claude</div>`}
            ${renderMediaThumb(seg.source, a.cursor * 6, a.cursor * 6 + 6, "approval-preview")}
            <div class="mono muted">${seg.id}</div>
            <h2 class="h2" style="margin-top:6px">${escapeHtml(seg.source)}</h2>
            <p class="muted">${escapeHtml(seg.hint)}</p>
            ${prior && prior.pick === "custom" ? `<div class="queue-item" style="background:var(--rose);margin:12px 0"><div class="mono">YOUR EDIT</div><strong>${escapeHtml(prior.text)}</strong></div>` : ""}
            <div class="choice-grid">
              ${choice("claude", "Claude option", seg.claude, prior)}
              ${choice("chatgpt", "ChatGPT option", seg.chatgpt, prior)}
            </div>
            <div class="custom-box">
              <div class="mini-row" style="justify-content:space-between;margin-bottom:8px">
                <strong>Write your own</strong>
                <span class="mono muted">trains Sonnet next time</span>
              </div>
              <textarea class="textarea" style="min-height:90px" data-bind="approvals.customText" placeholder="Type a better Vietnamese line...">${escapeHtml(a.customText)}</textarea>
              <div style="display:flex;justify-content:flex-end;margin-top:10px">
                ${btn("Use my edit", "choose-custom", "primary", "edit")}
              </div>
            </div>
          </div>
        </div>
        <aside class="side-panel" style="border-left:var(--line);border-top:0">
          <div class="mini-row" style="justify-content:space-between">
            <h3 class="h3">Decisions</h3>
            <span class="badge" style="background:var(--lime)">${a.decisions.filter(Boolean).length}/${flaggedSegments.length}</span>
          </div>
          <div class="queue-list">
            ${flaggedSegments.map((item, index) => {
              const d = a.decisions[index];
              return `<button class="decision-item ${index === a.cursor ? "active" : ""}" data-action="jump-approval" data-index="${index}" ${!d && index > a.cursor ? "disabled" : ""}>
                <div class="mini-row" style="justify-content:space-between">
                  <strong>${item.id}</strong>
                  <span class="badge" style="background:${d ? decisionColor(d.pick) : "var(--paper)"}">${d ? decisionShort(d.pick) : "open"}</span>
                </div>
                <div class="mono muted" style="margin-top:5px">${escapeHtml(item.source)}</div>
              </button>`;
            }).join("")}
          </div>
          <div class="note" style="margin-top:14px;background:var(--bg)">
            Click Claude, click ChatGPT, or write your own. Back is always available after a decision; Next appears only for cards already reviewed.
          </div>
        </aside>
      </div>
    </section>
  `;
}

function choice(pick, label, text, prior) {
  const selected = prior && prior.pick === pick;
  return `
    <button class="choice ${pick} ${selected ? "selected" : ""}" data-action="choose-approval" data-pick="${pick}">
      <span class="badge" style="background:${pick === "claude" ? "var(--violet);color:var(--paper)" : "var(--mint)"}">${label}</span>
      <p style="font-size:20px;font-weight:900;line-height:1.35">${escapeHtml(text)}</p>
    </button>
  `;
}

function renderApproveDone() {
  const decisions = state.approvals.decisions.filter(Boolean);
  const c = decisions.filter((d) => d.pick === "claude").length;
  const g = decisions.filter((d) => d.pick === "chatgpt").length;
  const e = decisions.filter((d) => d.pick === "custom").length;
  return `
    <section class="screen">
      <div class="form-panel" style="margin:40px auto;max-width:720px;text-align:center">
        <div style="display:flex;justify-content:center;margin-bottom:18px">${logo()}</div>
        <h1 class="h1">Subtitle pass complete</h1>
        <p class="muted">Visubly saved these choices locally so Sonnet can need fewer fixes next time.</p>
        <div class="grid-3" style="margin:22px 0">
          ${stat("Claude", String(c), "var(--violet)")}
          ${stat("ChatGPT", String(g), "var(--mint)")}
          ${stat("Your edits", String(e), "var(--rose)")}
        </div>
        <div style="display:flex;justify-content:center;gap:10px">
          ${btn("Review decisions", "review-decisions", "", "arrowL")}
          ${btn("Open player", "open-player", "primary", "play")}
        </div>
      </div>
    </section>
  `;
}

function renderPlayer() {
  const lines = [
    ["00:14:22", "Bình tĩnh nào ông tướng, làm gì căng vậy."],
    ["00:18:09", "Mọi thứ rối tinh rối mù hết rồi, phải không?"],
    ["00:27:46", "Thôi, tao đi cái đã."],
    ["00:31:04", "Cậu ấy đang bắt nhầm hướng rồi."]
  ];
  return `
    <section class="screen">
      <div class="top-row">
        <div>
          <div class="eyebrow">03 · WATCH</div>
          <h1 class="h1">Player preview</h1>
        </div>
        <div style="display:flex;gap:8px">
          ${btn("VI", "player-vi", state.playerMode === "vi" ? "lime" : "")}
          ${btn("EN", "player-en", state.playerMode === "en" ? "lime" : "")}
        </div>
      </div>
      <div class="player-layout">
        <div class="player-frame">
          <span class="play-dot">${icon("play")}</span>
          <div class="subtitle-overlay">${state.playerMode === "vi" ? "Bình tĩnh nào ông tướng, làm gì căng vậy." : "Don't get your knickers in a twist, mate."}</div>
          <div class="scrubber"><div></div></div>
        </div>
        <aside>
          <h3 class="h3">Transcript</h3>
          <div class="queue-list">
            ${lines.map(([time, text]) => `<div class="subtitle-line"><div class="mono muted">${time}</div><strong>${text}</strong></div>`).join("")}
          </div>
        </aside>
      </div>
    </section>
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
    videoName: p.displayName || (p.videoPath ? pathBaseName(p.videoPath) : "No video selected"),
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
        <div>
          <div class="eyebrow">03 · WATCH</div>
          <h1 class="h1">Player studio</h1>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;align-items:center">
          ${m.folderIndex >= 0 ? btn("Back to folder", "back-to-folder-context", "", "folder") : ""}
          ${m.folderIndex >= 0 ? `<span class="player-now-playing" title="${escapeAttr(m.videoName)}"><span>Playing</span><strong>${escapeHtml(m.videoName)}</strong></span>` : ""}
          ${btn("Choose MP4", "choose-video", "primary", "folder")}
          ${btn("Load SRT", "choose-srt", "", "captions")}
          ${btn("VI", "player-vi", state.playerMode === "vi" ? "lime" : "")}
          ${btn("EN", "player-en", state.playerMode === "en" ? "lime" : "")}
        </div>
      </div>
      <div class="${layoutClasses}">
        <div class="player-workbench" data-player-workbench>
          ${renderPlayerStage(m)}

          ${renderPlayerMediaSummary(m.videoName, m.srtName, m.hasSubtitles, m.showFolderPanel)}

          ${m.hasSubtitles ? `<div class="player-style-panel">
            <div>
              <div class="mono muted">SUBTITLE STYLE</div>
              <h3 class="h3">Sticker caption</h3>
            </div>
            <div class="style-actions">
              ${btn(p.subtitleOn ? "Sub on" : "Sub off", "subtitle-toggle", p.subtitleOn ? "lime" : "", "captions")}
              ${btn(p.style.background ? "BG on" : "BG off", "subtitle-bg", p.style.background ? "lime" : "")}
              ${btn(p.style.outline ? "Outline" : "No outline", "subtitle-outline", p.style.outline ? "lime" : "")}
              ${btn("A-", "subtitle-size-down", "", "minus")}
              ${btn("A+", "subtitle-size-up", "", "plus")}
              ${btn("Lower", "subtitle-bottom-down", "")}
              ${btn("Raise", "subtitle-bottom-up", "")}
            </div>
          </div>` : ""}
        </div>
        ${m.showFolderPanel ? renderPlayerFolderSidebar(m.folderIndex) : ""}
        ${m.hasSubtitles && !m.showFolderPanel ? `<aside class="player-transcript">
          <div class="mini-row" style="justify-content:space-between">
            <h3 class="h3">Transcript</h3>
            <span class="badge" style="background:var(--mint)">${cues.length} cues</span>
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
        <h3 class="h3">Choose an MP4 to preview subtitles</h3>
        <div class="muted">Drop an MP4 here to play, or drop SRT to load captions.</div>
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
  const titleLabel = m.folderIndex >= 0 ? `Playing · ${m.folderIndex + 1}/${m.folderCount}` : "Playing";

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
  const fullscreenLabel = m.fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)";
  const theaterLabel = p.theater ? "Exit theater mode (T)" : "Theater mode (T)";

  return `
    <div class="player-console" data-player-console role="group" aria-label="Player controls">
      <div class="player-transport">
        ${inFolder ? playerControlButton("player-prev", "skipPrev", "Previous video (Shift+P)", { disabled: !hasPrev }) : ""}
        ${playerControlButton("seek-back", "rewind", "Back 5 seconds (Left arrow)", { disabled: noVideo })}
        ${playerControlButton("toggle-player", p.playing ? "pause" : "play", p.playing ? "Pause (Space)" : "Play (Space)", { disabled: noVideo, className: "primary player-play" })}
        ${playerControlButton("seek-forward", "forward", "Forward 5 seconds (Right arrow)", { disabled: noVideo })}
        ${inFolder ? playerControlButton("player-next", "skipNext", "Next video (Shift+N)", { disabled: !hasNext }) : ""}
      </div>
      <div class="volume-control">
        ${playerControlButton("toggle-mute", p.muted ? "volumeOff" : "volume", p.muted ? "Unmute (M)" : "Mute (M)", { disabled: noVideo, pressed: p.muted, className: p.muted ? "danger" : "" })}
        <input class="volume-slider" data-volume-slider type="range" min="0" max="1" step="0.01" value="${visibleVolume}" style="--volume-level:${visibleVolume * 100}%" aria-label="Volume" aria-valuetext="${Math.round(visibleVolume * 100)}%" ${noVideo ? "disabled" : ""}>
        <span class="volume-value mono">${Math.round(visibleVolume * 100)}%</span>
      </div>
      <div class="player-scrubber" data-player-scrubber role="slider" tabindex="${noVideo ? "-1" : "0"}" aria-label="Seek" aria-valuemin="0" aria-valuemax="${Math.round(p.duration || 0)}" aria-valuenow="${Math.round(p.currentTime || 0)}" aria-valuetext="${formatClock(p.currentTime)} of ${formatClock(p.duration)}">
        <div class="player-scrubber-fill" data-player-scrubber-fill style="width:${progress}%"></div>
        <span class="player-scrubber-tooltip mono" data-player-scrubber-tooltip>${formatHoverClock(p.currentTime)}</span>
      </div>
      <span class="player-time mono">${formatClock(p.currentTime)} / ${formatClock(p.duration)}</span>
      <div class="player-view-actions">
        ${m.hasSubtitles ? playerControlButton("subtitle-toggle", "captions", p.subtitleOn ? "Hide subtitles" : "Show subtitles", { pressed: p.subtitleOn, className: p.subtitleOn ? "lime" : "" }) : ""}
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
          ${canOpenExternally ? btn("Open in system player", "open-video-externally", "primary", "play") : ""}
          ${hasNext ? btn("Next video", "player-next", "", "skipNext") : ""}
          ${btn("Choose another", "choose-video", canOpenExternally ? "" : "primary", "folder")}
          ${isWarning ? btn("Dismiss", "dismiss-media-error", "ghost", "x") : ""}
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
        <div class="mono muted">VIDEO</div>
        <strong title="${escapeAttr(videoName)}">${escapeHtml(videoName)}</strong>
      </div>
      ${hasSubtitles ? `<div class="queue-item">
        <div class="mono muted">SUBTITLE</div>
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
            <div class="mono muted">FOLDER PLAYLIST</div>
            <strong>${escapeHtml(activeVideo?.groupName || "Other")}</strong>
          </div>
          ${btn("Back", "back-to-folder-context", "ghost", "arrowL")}
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
          <div class="mono muted">FOLDER PLAYLIST</div>
          <strong title="${escapeAttr(activeVideo?.groupName || "Other")}">${escapeHtml(activeVideo?.groupName || "Other")}</strong>
        </div>
        <span class="badge" style="background:var(--lime)">${state.folder.videos.length}</span>
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
    const folderName = video.folderName || video.folder || "This folder";
    const groupName = video.groupName || "Other";
    if (folderName !== currentFolder) {
      currentFolder = folderName;
      currentGroup = null;
      html += `<div class="player-folder-section">${escapeHtml(folderName)}</div>`;
    }
    if (groupName !== currentGroup) {
      currentGroup = groupName;
      html += `<div class="player-folder-group">${escapeHtml(groupName)}</div>`;
    }

    html += renderPlayerFolderItem(video, index, index === activeIndex);
  });

  return html;
}

function renderPlayerFolderItem(video, index, isActive) {
  const title = video.name || pathBaseName(video.path);
  const resolution = video.resolutionLabel || inferResolutionFromName(title) || "";
  const subLabel = hasFolderVideoSubtitle(video) ? "sub" : "no sub";
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
    ? `${f.videos.length} videos${f.truncated ? " · capped at 1000" : ""}${f.skippedFolders ? ` · ${f.skippedFolders} folders skipped` : ""}`
    : "Choose a folder to scan";

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
          groupedHtml += `<h2 class="folder-group-title" style="margin: 24px 0 12px; font-size: 18px; border-bottom: var(--line); padding-bottom: 8px;">${escapeHtml(video.folderName)}</h2>`;
          currentFolder = video.folderName;
          currentGroup = null;
        }
        
        if (video.groupName && (isNewFolder || video.groupName !== currentGroup)) {
          groupedHtml += `<h3 class="folder-prefix-title" style="margin: 16px 0 12px; font-size: 14px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0;">${escapeHtml(video.groupName)}</h3>`;
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
        <div>
          <div class="eyebrow">Folder Player</div>
          <h1 class="h1">Watch by folder</h1>
        </div>
        <div class="folder-actions">
          ${hasFolder ? btn("Rescan", "rescan-video-folder", "", "search", f.scanning ? "disabled" : "") : ""}
          ${btn(hasFolder ? "Choose other" : "Choose Folder", "choose-video-folder", "primary", "folder", f.scanning ? "disabled" : "")}
          ${hasFolder ? btn("Clear", "clear-video-folder", "ghost", "x", f.scanning ? "disabled" : "") : ""}
        </div>
      </div>

      ${f.error ? `<div class="note danger-note folder-note"><strong>Folder scan failed.</strong><br>${escapeHtml(f.error)}</div>` : ""}

      ${!hasFolder && !f.scanning ? `
        <div class="folder-empty empty">
          <span class="play-dot">${icon("folder")}</span>
          <h3 class="h3">Choose a folder</h3>
          <div class="muted">Visubly will scan video files and keep this tab on that folder until you close the app, clear it, or choose another folder.</div>
          <div style="margin-top:16px">${btn("Choose Folder", "choose-video-folder", "primary", "folder")}</div>
        </div>
      ` : ""}

      ${f.scanning ? `
        <div class="folder-empty empty">
          <span class="play-dot">${icon("search")}</span>
          <h3 class="h3">Scanning folder</h3>
          <div class="muted">${escapeHtml(f.path || "Waiting for folder selection...")}</div>
        </div>
      ` : ""}

      ${hasFolder && !f.scanning ? `
        <div class="folder-summary">
          <div>
            <div class="mono muted">CURRENT FOLDER</div>
            <strong title="${escapeAttr(f.path)}">${escapeHtml(f.name || f.path)}</strong>
            <div class="mono muted folder-path">${escapeHtml(f.path)}</div>
          </div>
          <div class="folder-summary-stats">
            <span class="badge" style="background:var(--lime)">${escapeHtml(status)}</span>
            ${f.scannedAt ? `<span class="badge" style="background:var(--paper)">Scanned ${escapeHtml(formatShortDate(f.scannedAt))}</span>` : ""}
          </div>
        </div>

        ${hasVideos && !renderReady ? `
          <div class="folder-empty empty compact">
            <span class="play-dot">${icon("folder")}</span>
            <h3 class="h3">Opening folder</h3>
            <div class="muted">Preparing the grid without interrupting video playback cleanup.</div>
          </div>
        ` : hasVideos ? `
          ${groupedHtml}
          ${hiddenCount ? `
            <div class="folder-load-more">
              ${btn(`Show ${Math.min(folderPageSize, hiddenCount)} more`, "load-more-folder-videos", "", "plus")}
              <span class="mono muted">${visibleVideos.length} of ${f.videos.length} rendered</span>
            </div>
          ` : ""}
        ` : `
          <div class="folder-empty empty">
            <span class="play-dot">${icon("video")}</span>
            <h3 class="h3">No videos found</h3>
            <div class="muted">Try another folder or add MP4, MOV, MKV, WEBM, AVI, WMV, or TS files here.</div>
          </div>
        `}
      ` : ""}
    </section>
  `;
}

function renderFolderVideoCard(video, selectedPath, index) {
  const folder = video.folder ? video.folder : "This folder";
  const isActive = selectedPath && selectedPath === video.path;
  const title = video.name || pathBaseName(video.path);
  const meta = [folder, formatBytes(video.size), video.modifiedAt ? formatShortDate(video.modifiedAt) : ""].filter(Boolean).join(" · ");
  const resolution = video.resolutionLabel || inferResolutionFromName(title) || "Checking";
  const isSubbed = hasFolderVideoSubtitle(video);
  const subLabel = video.subtitlePath || video.subtitleName ? "Sub file" : isSubbed ? "-vs sub" : "No sub";

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

function renderLibrary() {
  return `
    <section class="screen">
      <div class="top-row">
        <div><div class="eyebrow">Library</div><h1 class="h1">My videos</h1></div>
        ${btn("Import video", "choose-video", "primary", "folder")}
      </div>
      <div class="grid-3">
        ${recent("Inside No.9 · S08E04", "subtitles approved", "Done", "var(--lime)", "player")}
        ${recent("Le Mans 24h Highlight", "downloaded · needs subtitles", "Ready", "var(--mint)", "subtitle")}
        ${recent("Conan_OVA_2024.mkv", "download queue", "Queued", "var(--paper)", "download")}
      </div>
    </section>
  `;
}

function renderSettings() {
  return `
    <section class="screen">
      <div class="top-row">
        <div><div class="eyebrow">Settings</div><h1 class="h1">Integration hooks</h1></div>
      </div>
      <div class="grid-2">
        <div class="form-panel">
          <h2 class="h2">Download engine</h2>
          <p class="muted">Wire your tested cURL parser and downloader through the preload bridge.</p>
          <div class="field"><label>Adapter status</label><input class="input" value="stub · ready for integration" readonly></div>
        </div>
        <div class="form-panel">
          <h2 class="h2">Subtitle engine</h2>
          <p class="muted">Connect Opus, Sonnet, Whisper, and ChatGPT orchestration behind the same UI contract.</p>
          <div class="field"><label>Adapter status</label><input class="input" value="stub · dummy pipeline active" readonly></div>
        </div>
      </div>
    </section>
  `;
}

function renderIntro() {
  return `
    <div class="intro" data-action="dismiss-intro">
      <div class="float-blob blob-a">vi-VN ✓</div>
      <div class="float-blob blob-b">1080p · 4K</div>
      <div class="float-blob blob-c">+12 phrases learned</div>
      <div class="float-blob blob-d">cURL → mp4</div>
      <div class="intro-card">
        <div class="intro-logo">
          <img class="intro-brand-icon" src="./assets/brand/visubly-app-logo-concept-v2.png" alt="ViSUBLY logo">
          <span class="intro-tile">S</span>
          <span class="intro-tile">U</span>
          <span class="intro-tile">B</span>
          <span class="intro-tile">L</span>
          <span class="intro-tile">Y</span>
        </div>
        <h1 class="intro-tagline">Grab. <em>Sub.</em> Watch.</h1>
        <p class="intro-subtag">Vietnamese subtitle and video studio</p>
        <div class="intro-features">
          <span>${icon("download")} grab videos</span>
          <span>${icon("sub")} vi subtitles</span>
          <span>${icon("brain")} local learning</span>
        </div>
        <div class="tap-start"><span></span>TAP ANYWHERE TO START</div>
      </div>
    </div>
  `;
}

function screenHeader(eyebrow, title, meta, backScreen) {
  return `
    <header class="screen-header">
      <div class="mini-row">
        ${btn("Back", `back-to-${backScreen}`, "", "arrowL")}
        <div>
          <div class="eyebrow">${eyebrow}</div>
          <h2 class="h2">${title}</h2>
        </div>
      </div>
      <span class="mono muted">${meta}</span>
    </header>
  `;
}

function attachDynamicHandlers(options = {}) {
  const drop = document.getElementById("dropZone");
  if (drop) {
    drop.addEventListener("dragover", (event) => {
      event.preventDefault();
      drop.classList.add("dragging");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
    drop.addEventListener("drop", async (event) => {
      event.preventDefault();
      drop.classList.remove("dragging");
      const file = event.dataTransfer.files?.[0];
      if (file) {
        await loadVideoPath(file.path || file.name);
        render();
      }
    });
  }
  attachPlayerStage();
  attachMainPlayer();
  attachPlayerFolderRail(options.folderListMemory || null);
  syncPlayerControlsVisibility();
  attachMiniPlayers();
  if (state.screen === "folder") {
    scheduleFolderThumbs();
    scrollPendingFolderVideoIntoView();
  } else {
    cancelFolderThumbs();
  }
}

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

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-screen]");
  if (nav) {
    setScreen(nav.dataset.screen);
    return;
  }

  const actionEl = event.target.closest("[data-action]");
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  // A mouse click must not leave focus on a player control, otherwise Space would
  // re-activate that button instead of toggling playback. Keyboard clicks keep focus.
  if (event.detail > 0 && actionEl.closest("[data-player-stage]")) actionEl.blur();

  if (action === "minimize") return desktop.minimize();
  if (action === "maximize") return desktop.toggleMaximize();
  if (action === "close") return desktop.close();
  if (action === "dismiss-intro") {
    state.intro = false;
    render();
    return;
  }
  if (action.startsWith("back-to-")) return setScreen(action.replace("back-to-", ""));
  if (action === "go-home") return setScreen("home");
  if (action === "noop") return;

  if (action === "start-remote") {
    state.remote.loading = true;
    render();
    desktop.airplay.start().then(info => {
      state.remote.qrUrl = info.qrUrl;
      state.remote.testUrl = `${info.baseUrl}/?token=${info.pairingToken}`;
      state.remote.loading = false;
      render();
    }).catch(err => {
      console.error(err);
      state.remote.loading = false;
      render();
    });
    return;
  }
  if (action === "copy-remote-link") {
    if (state.remote.testUrl) {
      navigator.clipboard.writeText(state.remote.testUrl);
      const b = actionEl.closest("button");
      if (b) {
        const old = b.innerHTML;
        b.innerHTML = "Đã Copy!";
        setTimeout(() => b.innerHTML = old, 1500);
      }
    }
    return;
  }

  if (action === "close-remote") {
    state.remote.qrUrl = null;
    state.remote.testUrl = null;
    state.remote.loading = false;
    state.remote.pairingActive = false;
    state.remote.pairingPin = null;
    return render();
  }

  if (action === "use-sample-curl") {
    state.download.curl = sampleCurl;
    return render();
  }
  if (action === "download-next") {
    if (state.download.step === 0 && !state.download.curl.trim()) state.download.curl = sampleCurl;
    if (state.download.step === 1 && !state.download.name.trim()) state.download.name = suggestNameFromCurl(state.download.curl);
    
    if (state.download.step === 1) {
      if (state.download.loadingQualities) return;
      state.download.loadingQualities = true;
      state.download.qualityError = "";
      render();
      
      desktop.download.prepareItem({
        source: state.download.curl,
        name: state.download.name,
        type: "m3u8",
        noPreflight: true
      }).then(res => {
        const item = res.item || res;
        state.download.preparedItem = item;
        let variants = item.variants || [];
        
        if (variants.length > 0) {
          state.download.dynamicQualities = variants.map(v => {
            let resParts = (v.resolution || "").split("x");
            let height = parseInt(resParts[1] || resParts[0]) || 0;
            return {
              id: v.resolution || String(height),
              label: height ? `${height}p` : "Unknown",
              note: `Res: ${v.resolution || "N/A"}` + (v.bandwidth ? ` · ${Math.round(v.bandwidth/1024)} kbps` : ""),
              height: height
            };
          }).sort((a, b) => b.height - a.height);
          
          let exact1080 = state.download.dynamicQualities.find(q => q.height === 1080 || q.id === "1080");
          let bestQuality = state.download.dynamicQualities[0];
          
          state.download.quality = exact1080 ? exact1080.id : (bestQuality ? bestQuality.id : "1080");
          state.download.maxHeight = bestQuality ? bestQuality.height : 0;
        } else {
          state.download.dynamicQualities = qualities;
          state.download.quality = "1080";
          state.download.maxHeight = 1080;
        }
        
        state.download.step = 2;
        state.download.loadingQualities = false;
        render();
      }).catch(err => {
        state.download.qualityError = err.message;
        state.download.loadingQualities = false;
        render();
      });
      return;
    }

    state.download.step = Math.min(3, state.download.step + 1);
    return render();
  }
  if (action === "download-back") {
    state.download.step = Math.max(0, state.download.step - 1);
    return render();
  }
  if (action === "download-cancel-record") {
    state.download.curl = "";
    state.download.name = "";
    state.download.quality = "1080";
    state.download.step = 0;
    state.download.dynamicQualities = null;
    state.download.maxHeight = 0;
    state.download.preparedItem = null;
    return render();
  }
  if (action === "pick-quality") {
    state.download.quality = actionEl.dataset.quality;
    return render();
  }
  if (action === "add-download-item") {
    await addDownloadItem();
    return;
  }
  if (action === "remove-download") {
    const id = actionEl.dataset.id || state.download.items[Number(actionEl.dataset.index)]?.id;
    state.download.actionError = "";
    if (id) {
      const result = await desktop.download.removeItem(id);
      applyDownloadResult(result);
    }
    else state.download.items.splice(Number(actionEl.dataset.index), 1);
    return render();
  }
  if (action === "start-downloads") {
    state.download.actionError = "";
    await desktop.download.startQueue({ parallelItems: 1 });
    state.download.phase = "running";
    await refreshDownloadState();
    render();
    return;
  }
  if (action === "edit-batch") {
    state.download.phase = "input";
    return render();
  }
  if (action === "select-download-log") {
    state.download.terminalItemId = actionEl.dataset.id || "";
    return render();
  }
  if (action === "cancel-download") {
    await desktop.download.cancelItem(actionEl.dataset.id);
    return refreshDownloadState();
  }
  if (action === "retry-download") {
    await desktop.download.retryItem(actionEl.dataset.id);
    state.download.phase = "running";
    return refreshDownloadState();
  }
  if (action === "clear-finished-downloads") {
    state.download.actionError = "";
    const result = await desktop.download.clearCompleted();
    applyDownloadResult(result);
    return render();
  }
  if (action === "open-download-output" || action === "reveal-download-output") {
    state.download.actionError = "";
    const id = actionEl.dataset.id;
    const command = action === "open-download-output" ? desktop.download.openOutput : desktop.download.revealOutput;
    const result = command ? await command(id) : { ok: false, error: "This action is not available." };
    if (result?.ok === false) state.download.actionError = result.error || "Could not open the downloaded file.";
    return render();
  }
  if (action === "subtitle-downloaded") {
    const item = state.download.items[Number(actionEl.dataset.index)];
    await loadVideoPath(item.output || `D:\\Downloads\\${item.name}.mp4`, { displayName: item.name });
    return setScreen("subtitle");
  }

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
      state.folder.visibleLimit = Math.max(
        Number(state.folder.visibleLimit || folderPageSize),
        index + 1
      );
      state.folder.pendingScrollPath = state.player.videoPath;
    }
    return setScreen("folder");
  }
  if (action === "add-cast") {
    const name = state.subtitle.castDraft.trim();
    if (name) state.subtitle.cast.push(name);
    state.subtitle.castDraft = "";
    return render();
  }
  if (action === "remove-cast") {
    state.subtitle.cast.splice(Number(actionEl.dataset.index), 1);
    return render();
  }
  if (action === "start-processing") {
    await desktop.integrations.generateSubtitle({
      videoPath: state.subtitle.videoPath,
      movieTitle: state.subtitle.movieTitle,
      cast: state.subtitle.cast
    });
    startProcessingSimulation();
    return;
  }
  if (action === "go-approve") {
    state.screen = "approve";
    state.approvals.cursor = 0;
    return render();
  }
  if (action === "choose-approval") return chooseApproval(actionEl.dataset.pick);
  if (action === "choose-custom") return chooseApproval("custom");
  if (action === "approval-back") {
    state.approvals.cursor = Math.max(0, state.approvals.cursor - 1);
    state.approvals.customText = "";
    return render();
  }
  if (action === "approval-next") {
    if (state.approvals.decisions[state.approvals.cursor + 1]) state.approvals.cursor += 1;
    state.approvals.customText = "";
    return render();
  }
  if (action === "jump-approval") {
    const index = Number(actionEl.dataset.index);
    if (index <= state.approvals.cursor || state.approvals.decisions[index]) {
      state.approvals.cursor = index;
      state.approvals.customText = "";
      render();
    }
    return;
  }
  if (action === "review-decisions") {
    state.approvals.cursor = 0;
    return render();
  }
  if (action === "open-player") return setScreen("player");
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
  if (action === "player-vi") {
    state.playerMode = "vi";
    return render();
  }
  if (action === "player-en") {
    state.playerMode = "en";
    return render();
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  const bind = target.dataset.bind;
  if (!bind) return;
  const value = target.value;
  if (bind === "download.curl") state.download.curl = value;
  if (bind === "download.name") state.download.name = value;
  if (bind === "subtitle.movieTitle") {
    state.subtitle.movieTitle = value;
    state.subtitle.movieEdited = true;
  }
  if (bind === "subtitle.castDraft") state.subtitle.castDraft = value;
  if (bind === "approvals.customText") state.approvals.customText = value;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Tab") playerKeyboardModality = true;
  if (handlePlayerShortcut(event)) return;

  const tag = document.activeElement?.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return;

  if (state.screen !== "approve") return;
  if (event.key === "ArrowLeft" && state.approvals.cursor > 0) {
    event.preventDefault();
    state.approvals.cursor -= 1;
    render();
  }
  if (event.key === "ArrowRight" && state.approvals.decisions[state.approvals.cursor + 1]) {
    event.preventDefault();
    state.approvals.cursor += 1;
    render();
  }
});

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
  if (remoteModalKey() || state.intro) return false;

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

function initDownloadBridge() {
  desktop.download?.onState?.((snapshot) => {
    syncDownloadState(snapshot);
    scheduleDownloadRender();
  });
  desktop.download?.onEvent?.((event) => {
    if (event?.event === "item-started" && event.itemId) state.download.terminalItemId = event.itemId;
  });
  refreshDownloadState();
}

async function refreshDownloadState() {
  try {
    const snapshot = await desktop.download.getState();
    syncDownloadState(snapshot);
    if (state.screen === "download") render({ preserveScroll: true });
  } catch {
    // The browser fallback keeps the UI usable without Electron IPC.
  }
}

function scheduleDownloadRender() {
  if (state.screen !== "download") return;
  if (downloadRenderTimer) return;
  downloadRenderTimer = window.setTimeout(() => {
    downloadRenderTimer = null;
    if (state.screen !== "download") return;
    render({ preserveScroll: true });
  }, 180);
}

function applyDownloadResult(result = {}) {
  if (result?.state) syncDownloadState(result.state);
  if (result?.ok === false) state.download.actionError = result.error || "Download action failed.";
}

function syncDownloadState(snapshot = {}) {
  if (!Array.isArray(snapshot.items)) return;
  state.download.items = snapshot.items;
  state.download.parallelItems = 1;
  const activeItem = state.download.items.find((item) => ["active", "preparing", "muxing"].includes(item.status));
  if (activeItem) state.download.phase = "running";
  if (!state.download.terminalItemId || !state.download.items.some((item) => item.id === state.download.terminalItemId)) {
    state.download.terminalItemId = activeItem?.id || state.download.items[0]?.id || "";
  }
}

function selectedDownloadItem() {
  return (
    state.download.items.find((item) => item.id === state.download.terminalItemId) ||
    state.download.items.find((item) => ["active", "preparing", "muxing"].includes(item.status)) ||
    state.download.items[0] ||
    null
  );
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

async function addDownloadItem() {
  const d = state.download;
  const source = d.curl.trim();
  if (!source) {
    d.prepareError = "Paste a URL or full cURL command first.";
    render();
    return;
  }

  d.preparing = true;
  d.prepareError = "";
  render();
  try {
    const prepared = await desktop.download.prepareItem({
      source,
      name: d.name.trim() || suggestNameFromCurl(source),
      quality: d.quality,
      type: "m3u8",
      workers: 8
    });
    const item = prepared.item || prepared;
    await desktop.download.enqueueItems([item]);
    await refreshDownloadState();
    d.curl = "";
    d.name = "";
    d.quality = "1080";
    d.step = 0;
    d.prepareError = "";
  } catch (error) {
    d.prepareError = error?.message || "Could not prepare this download item.";
  } finally {
    d.preparing = false;
    render();
  }
}

function startDownloadSimulation() {
  stopDownloadSimulation();
  state.download.phase = "running";
  state.download.active = 0;
  state.download.items.forEach((item, index) => {
    item.status = index === 0 ? "active" : "queued";
    item.progress = 0;
  });
  render();
  downloadTimer = setInterval(() => {
    const active = state.download.items[state.download.active];
    if (!active) {
      stopDownloadSimulation();
      return;
    }
    active.progress = Math.min(100, active.progress + 7 + Math.random() * 9);
    if (active.progress >= 100) {
      active.progress = 100;
      active.status = "done";
      state.download.active += 1;
      const next = state.download.items[state.download.active];
      if (next) next.status = "active";
    }
    render();
  }, 450);
}

function stopDownloadSimulation() {
  if (downloadTimer) clearInterval(downloadTimer);
  downloadTimer = null;
}

function startProcessingSimulation() {
  stopProcessingSimulation();
  state.screen = "processing";
  state.subtitle.processing = { running: true, values: [0, 0, 0, 0, 0], done: false };
  render();
  processingTimer = setInterval(() => {
    const p = state.subtitle.processing;
    for (let i = 0; i < p.values.length; i += 1) {
      const priorDone = i === 0 || p.values[i - 1] >= 80;
      if (priorDone && p.values[i] < 100) {
        p.values[i] = Math.min(100, p.values[i] + 4 + Math.random() * 8);
        break;
      }
    }
    p.done = p.values.every((v) => v >= 100);
    if (p.done) stopProcessingSimulation();
    // Progress only shows on the processing screen; re-rendering other screens every
    // 420 ms (e.g. the player while a video plays) rebuilds their controls for nothing.
    if (state.screen === "processing") render();
  }, 420);
}

function stopProcessingSimulation() {
  if (processingTimer) clearInterval(processingTimer);
  processingTimer = null;
}

function chooseApproval(pick) {
  const cursor = state.approvals.cursor;
  const seg = flaggedSegments[cursor];
  const text = pick === "claude" ? seg.claude : pick === "chatgpt" ? seg.chatgpt : state.approvals.customText.trim();
  if (!text) return;
  state.approvals.decisions[cursor] = { pick, text };
  state.approvals.customText = "";
  state.approvals.cursor = cursor + 1;
  render();
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
  };
  video.ontimeupdate = syncState;
  video.onplay = () => {
    syncState();
    showPlayerControls();
  };
  video.onpause = () => {
    syncState();
    showPlayerControls();
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
      title: "Can't read this video file",
      detail: "The file could not be opened. It may have been moved, renamed, deleted, or is still being written by a download.",
      technical
    };
  }
  if (code === 3) {
    return {
      kind: "error",
      title: "Playback stopped: decode error",
      detail: `Part of this ${ext} file is damaged or uses a codec the built-in player can't decode. Try a system player, or convert it to MP4 (H.264 + AAC).`,
      technical
    };
  }
  const legacy = ["AVI", "WMV", "FLV", "ASF", "MPG", "MPEG", "VOB", "TS", "M2TS", "MTS", "3GP", "RM", "RMVB", "DIVX"];
  return {
    kind: "error",
    title: `This ${ext} can't play in the built-in player`,
    detail: legacy.includes(ext)
      ? `${ext} uses a container or codec that Chromium can't decode. Open it in a system player, or convert it to MP4 (H.264 + AAC).`
      : "The video or audio codec isn't supported here (often HEVC/H.265 video or AC3/DTS audio). Open it in a system player, or convert it to MP4 (H.264 + AAC).",
    technical
  };
}

function describeMissingVideoTrack() {
  return {
    kind: "warning",
    title: "No picture: the video track can't be decoded",
    detail: "Audio may still play, but the video codec (often HEVC/H.265 without hardware support) isn't supported by the built-in player. Open it in a system player, or convert it to MP4 (H.264 + AAC).",
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
      title: "Couldn't open a system player",
      detail: error?.message || "No application is registered for this file type.",
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

function attachMiniPlayers() {
  document.querySelectorAll(".mini-player").forEach((holder) => {
    const video = holder.querySelector("video");
    if (!video) return;
    const start = Number(holder.dataset.clipStart || 0);
    const end = Number(holder.dataset.clipEnd || start + 6);

    const resetClip = () => {
      try {
        video.currentTime = start;
      } catch {
        // Metadata may not be ready yet.
      }
    };

    video.addEventListener("loadedmetadata", resetClip);
    holder.addEventListener("mouseenter", () => {
      video.muted = true;
      resetClip();
      video.play().catch(() => {});
    });
    holder.addEventListener("mouseleave", () => {
      video.pause();
      resetClip();
    });
    video.addEventListener("timeupdate", () => {
      if (video.currentTime >= end) {
        video.pause();
        resetClip();
      }
    });
  });
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
    scrubber.setAttribute("aria-valuetext", `${formatClock(p.currentTime)} of ${formatClock(p.duration)}`);
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
    const label = p.playing ? "Pause (Space)" : "Play (Space)";
    playButton.dataset.state = playState;
    playButton.innerHTML = icon(p.playing ? "pause" : "play");
    playButton.title = label;
    playButton.setAttribute("aria-label", label);
  }

  const muteButton = document.querySelector('[data-action="toggle-mute"]');
  const muteState = p.muted ? "muted" : "sound";
  if (muteButton && muteButton.dataset.state !== muteState) {
    const label = p.muted ? "Unmute (M)" : "Mute (M)";
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
    state.folder = { ...state.folder, scanning: false, error: error?.message || "Could not scan this folder." };
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
    state.folder = { ...state.folder, scanning: false, error: error?.message || "Could not rescan this folder." };
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
    v.folderName = v.folder || "This folder";
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
    text = await desktop.readTextFile(pathValue);
  } catch {
    text = "";
  }
  if (sourceToken !== state.player.sourceToken) return false;
  const cues = parseSrt(text);
  if (!cues.length) {
    // Keep whatever track is already loaded and tell the user why nothing changed.
    state.player.subtitleNotice = `Couldn't read any subtitle cues from ${pathBaseName(pathValue)}. Check that it is a UTF-8 SRT or WebVTT file.`;
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
  state.subtitle.videoPath = pathValue;
  state.subtitle.fileName = displayFileName;
  state.subtitle.movieTitle = parseMovieTitle(displayFileName);
  state.subtitle.movieEdited = false;
  state.player.videoPath = pathValue;
  state.player.displayName = displayFileName;
  state.player.videoUrl = localPathToFileUrl(pathValue);
  state.player.currentTime = 0;
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

function parseMovieTitle(fileName) {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\bS(\d{2})E(\d{2})\b/i, "· S$1E$2")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHost(curl) {
  const match = String(curl || "").match(/https?:\/\/([^\/'"\s]+)/);
  return match ? match[1].replace(/^www\./, "") : "";
}

function suggestNameFromCurl(curl) {
  const host = extractHost(curl);
  if (!host) return "Inside_No9_S08E04";
  return host.split(".")[0].replace(/[^a-z0-9]+/gi, "_") + "_clip";
}

function qualityLabel(id) {
  if (state.download && state.download.dynamicQualities) {
      const q = state.download.dynamicQualities.find(x => x.id === id);
      if (q) return q.label;
  }
  const q = qualities.find((x) => x.id === id);
  return q ? q.label : id;
}

function qualityToResolution(id) {
  return {
    "2160": "3840x2160",
    "1440": "2560x1440",
    "1080": "1920x1080",
    "720": "1280x720",
    "480": "854x480"
  }[String(id || "1080")] || "1920x1080";
}

function statusLabel(status) {
  if (status === "done") return "ready for subtitle";
  if (status === "preparing") return "checking playlist";
  if (status === "muxing") return "muxing mp4";
  if (status === "active") return "downloading now";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  return "queued";
}

function phaseLabel(phase) {
  return {
    queued: "queued",
    starting: "starting",
    preflight: "preflight",
    download_segments: "segments",
    ffmpeg_download: "ffmpeg",
    combine_segments: "combine",
    mux_ts_to_mp4: "TS to MP4",
    done: "done",
    failed: "failed",
    canceled: "canceled"
  }[phase] || phase || "queued";
}

function progressMeta(item) {
  if (!item) return "";
  const bits = [];
  if (item.speed) bits.push(item.speed);
  if (Number.isFinite(Number(item.eta))) bits.push(`eta ${formatClock(Number(item.eta))}`);
  if (item.completedSegments && item.totalSegments) bits.push(`${item.completedSegments}/${item.totalSegments} segments`);
  if (item.error) bits.push(item.error);
  return bits.join(" · ") || item.output || "";
}

function pipelineLogs(values) {
  const logs = [];
  if (values[0] > 3) logs.push("[OPUS] resolved title from filename + user edit field");
  if (values[0] > 35) logs.push("[OPUS] matched cast names and built style guide");
  if (values[1] > 15) logs.push("[WHISPER] listening · 412 source segments");
  if (values[2] > 20) logs.push("[SONNET] translating with protected proper nouns");
  if (values[3] > 30) logs.push("[OPUS-QC] scene context pass · character voice fixed");
  if (values[4] > 20) logs.push("[CHATGPT] native-tone scan found 5 review candidates");
  if (values.every((v) => v >= 100)) logs.push("[WRITE] subtitles and learning notes saved locally");
  return logs.length ? logs : ["[READY] pipeline waiting for first task"];
}

function decisionLabel(pick) {
  return { claude: "Claude", chatgpt: "ChatGPT", custom: "Your edit" }[pick] || "Open";
}

function decisionShort(pick) {
  return { claude: "C", chatgpt: "G", custom: "✎" }[pick] || "open";
}

function decisionColor(pick) {
  return { claude: "var(--violet)", chatgpt: "var(--mint)", custom: "var(--rose)" }[pick] || "var(--paper)";
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

initDownloadBridge();
initAirPlayPairingBridge();
loadPlayerPrefs();
render();
