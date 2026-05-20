"use strict";

const desktop = window.visublyDesktop || {
  platform: navigator.platform.toLowerCase().includes("mac") ? "darwin" : "win32",
  minimize: () => {},
  toggleMaximize: () => {},
  close: () => {},
  selectVideo: async () => null,
  selectSubtitle: async () => null,
  readTextFile: async () => "",
  toFileUrl: async (filePath) => localPathToFileUrl(filePath),
  findMatchingSubtitle: async () => null,
  integrations: {
    startDownloadBatch: async (items) => ({ ok: true, items }),
    generateSubtitle: async (payload) => ({ ok: true, payload })
  }
};

const root = document.getElementById("app-root");

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

const sampleSrt = `1
00:00:02,000 --> 00:00:06,200
Bình tĩnh nào ông tướng, làm gì căng vậy.

2
00:00:07,400 --> 00:00:11,600
Mọi thứ rối tinh rối mù hết rồi, phải không?

3
00:00:13,000 --> 00:00:17,500
Thôi, tao đi cái đã.

4
00:00:19,000 --> 00:00:23,400
Cậu ấy đang bắt nhầm hướng rồi.

5
00:00:25,000 --> 00:00:30,400
Xong xuôi rồi đó, dễ như húp cháo!`;

const sampleCues = parseSrt(sampleSrt);

const state = {
  screen: "home",
  intro: true,
  download: {
    phase: "input",
    step: 0,
    curl: "",
    name: "",
    quality: "2160",
    items: [
      { name: "Le_Mans_2025_Highlight", quality: "1080", host: "le-mans.live", status: "queued", progress: 0 },
      { name: "Inside_No9_S08E04", quality: "720", host: "iplayer.bbc", status: "queued", progress: 0 }
    ],
    active: -1
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
    srtPath: "",
    cues: sampleCues,
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
    style: {
      fontSize: 19,
      bottom: 58,
      background: true,
      outline: true
    }
  },
  playerMode: "vi"
};

let downloadTimer = null;
let processingTimer = null;

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
    minus: '<path d="M5 12h14"/>'
  };
  return `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.home}</svg>`;
}

function logo() {
  return `<div class="logo"><span class="logo-mark">Vi${starSvg("logo-star")}</span><span class="logo-word">subly</span></div>`;
}

function starSvg(className = "") {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12,1.5 14.85,8.95 22.85,9.4 16.6,14.4 18.7,22.2 12,17.85 5.3,22.2 7.4,14.4 1.15,9.4 9.15,8.95" fill="var(--vi-star)" stroke="var(--ink)" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
}

function btn(label, action, classes = "", iconName = "", attrs = "") {
  const iconHtml = iconName ? icon(iconName) : "";
  return `<button class="btn ${classes}" data-action="${action}" ${attrs}>${iconHtml}<span>${label}</span></button>`;
}

function setScreen(screen) {
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
    library: "Visubly · Library",
    settings: "Visubly · Settings"
  }[state.screen] || "Visubly";
}

function render() {
  root.innerHTML = `
    <div class="shell">
      ${renderTitlebar()}
      <div class="app">
        ${renderSidebar()}
        <main class="main">${renderScreen()}</main>
      </div>
      ${state.intro ? renderIntro() : ""}
    </div>
  `;
  attachDynamicHandlers();
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
  const cue = state.player.cues.find((item) => item.start >= clipStart) || state.player.cues[0];
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
                  <button class="btn ghost icon" data-action="remove-download" data-index="${index}" title="Remove">${icon("x")}</button>
                </div>
                <div class="mono muted">${qualityLabel(item.quality)} · ${escapeHtml(item.host || "parsed host")}</div>
              </div>
            `).join("") || `<div class="empty">No items yet.</div>`}
          </div>
          <div style="margin-top:18px;display:grid;gap:10px">
            ${btn("Start downloads", "start-downloads", "primary", "download", state.download.items.length ? "" : "disabled")}
            ${btn("Add sample item", "add-sample", "", "plus")}
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
        <p class="muted">The real parser can be connected later. This UI currently simulates quality extraction.</p>
        <div class="field">
          <label for="curlInput">cURL command</label>
          <textarea class="textarea" id="curlInput" data-bind="download.curl" placeholder="${escapeAttr(sampleCurl)}">${escapeHtml(d.curl)}</textarea>
        </div>
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
        <div style="display:flex;justify-content:space-between;margin-top:16px">
          ${btn("Back", "download-back", "", "arrowL")}
          ${btn("Next", "download-next", "primary", "arrowR")}
        </div>
      </div>
    `;
  }
  if (d.step === 2) {
    return `
      <div class="form-panel">
        <h2 class="h2">Pick quality</h2>
        <p class="muted">Highest quality is selected by default after cURL parsing.</p>
        <div class="quality-grid" style="margin-top:16px">
          ${qualities.map((q) => `
            <button class="quality-option ${d.quality === q.id ? "selected" : ""}" data-action="pick-quality" data-quality="${q.id}">
              <div style="font-weight:900;font-size:18px">${q.label}</div>
              <div class="mono muted">${q.note}</div>
            </button>
          `).join("")}
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:16px">
          ${btn("Back", "download-back", "", "arrowL")}
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
      <div style="display:flex;justify-content:space-between;margin-top:16px">
        ${btn("Back", "download-back", "", "arrowL")}
        ${btn("Add to batch", "add-download-item", "primary", "plus")}
      </div>
    </div>
  `;
}

function renderDownloadRunning() {
  return `
    <section class="screen">
      <div class="top-row">
        <div>
          <div class="eyebrow">01 · GRAB</div>
          <h1 class="h1">Downloading batch</h1>
        </div>
        <div style="display:flex;gap:8px">
          ${btn("Edit batch", "edit-batch", "", "arrowL")}
          ${btn("Home", "go-home", "ghost", "home")}
        </div>
      </div>
      <div class="running-list">
        ${state.download.items.map((item, index) => {
          const status = item.status;
          const progress = status === "done" ? 100 : status === "active" ? item.progress : 0;
          return `
            <div class="running-row">
              <div class="running-row-main">
                <span class="step-index">${index + 1}</span>
                <div style="min-width:0">
                  <div style="font-weight:900">${escapeHtml(item.name)}</div>
                  <div class="mono muted">${qualityLabel(item.quality)} · ${statusLabel(status)}</div>
                </div>
                <div style="display:flex;align-items:center;gap:8px">
                  ${status === "done" ? `<span class="badge" style="background:var(--lime)">✓ ready</span>${btn("Subtitle this", "subtitle-downloaded", "violet", "sub", `data-index="${index}"`)}` : `<span class="badge" style="background:var(--paper)">${Math.round(progress)}%</span>`}
                </div>
              </div>
              <div class="row-progress"><div style="width:${progress}%"></div></div>
            </div>
          `;
        }).join("")}
      </div>
    </section>
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

function renderPlayerStudio() {
  const p = state.player;
  const hasSubtitles = hasRealSubtitleTrack();
  const cues = hasSubtitles ? p.cues : [];
  const subtitleText = hasSubtitles ? activeSubtitleText(p.currentTime) : "";
  const progress = p.duration ? Math.min(100, Math.max(0, (p.currentTime / p.duration) * 100)) : 0;
  const visibleVolume = p.muted ? 0 : p.volume;
  const fullscreenActive = isDocumentFullscreen();
  state.player.fullscreen = fullscreenActive;
  const videoName = p.videoPath ? pathBaseName(p.videoPath) : "No MP4 selected";
  const srtName = p.srtPath ? pathBaseName(p.srtPath) : "";
  const overlayClasses = [
    "subtitle-overlay",
    "visubly-subtitle",
    p.style.background ? "with-bg" : "",
    p.style.outline ? "with-outline" : ""
  ].filter(Boolean).join(" ");
  const overlayStyle = `--subtitle-font-size:${p.style.fontSize}px;--subtitle-bottom:${p.style.bottom}px`;

  return `
    <section class="screen player-screen ${p.theater ? "is-theater" : ""}">
      <div class="top-row">
        <div>
          <div class="eyebrow">03 · WATCH</div>
          <h1 class="h1">Player studio</h1>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          ${btn("Choose MP4", "choose-video", "primary", "folder")}
          ${btn("Load SRT", "choose-srt", "", "captions")}
          ${btn("VI", "player-vi", state.playerMode === "vi" ? "lime" : "")}
          ${btn("EN", "player-en", state.playerMode === "en" ? "lime" : "")}
        </div>
      </div>
      <div class="player-layout ${hasSubtitles ? "" : "no-transcript"} ${p.theater ? "theater" : ""}">
        <div class="player-workbench" data-player-workbench>
          <div class="player-frame ${p.videoUrl ? "has-video" : ""}" data-player-drop>
            ${p.videoUrl ? `<video id="mainPlayerVideo" class="main-player-video" src="${escapeAttr(p.videoUrl)}" playsinline preload="metadata"></video>` : `
              <div class="player-empty">
                <span class="play-dot">${icon("play")}</span>
                <h3 class="h3">Choose an MP4 to preview subtitles</h3>
                <div class="muted">Drop an MP4 here to play, or drop SRT to load captions.</div>
              </div>
            `}
            ${hasSubtitles && p.subtitleOn ? `<div class="${overlayClasses} ${subtitleText ? "" : "is-empty"}" style="${overlayStyle}"><span class="main-subtitle-text">${escapeHtml(subtitleText)}</span></div>` : ""}
            <div class="player-drop-hint">
              <strong>Drop MP4 / SRT</strong>
              <span>MP4 plays immediately. SRT updates captions.</span>
            </div>
          </div>

          <div class="player-console">
            <button class="btn icon" data-action="seek-back" title="Back 5 seconds" ${p.videoUrl ? "" : "disabled"}>${icon("arrowL")}</button>
            <button class="btn icon primary" data-action="toggle-player" title="${p.playing ? "Pause" : "Play"}" ${p.videoUrl ? "" : "disabled"}>${icon(p.playing ? "minus" : "play")}</button>
            <button class="btn icon" data-action="seek-forward" title="Forward 5 seconds" ${p.videoUrl ? "" : "disabled"}>${icon("arrowR")}</button>
            <div class="volume-control">
              <button class="btn icon ${p.muted ? "danger" : ""}" data-action="toggle-mute" title="${p.muted ? "Unmute" : "Mute"}" aria-pressed="${p.muted ? "true" : "false"}" ${p.videoUrl ? "" : "disabled"}>${icon(p.muted ? "volumeOff" : "volume")}</button>
              <input class="volume-slider" data-volume-slider type="range" min="0" max="1" step="0.01" value="${visibleVolume}" style="--volume-level:${visibleVolume * 100}%" aria-label="Volume" ${p.videoUrl ? "" : "disabled"}>
              <span class="volume-value mono">${Math.round(visibleVolume * 100)}%</span>
            </div>
            <div class="player-scrubber" data-player-scrubber role="slider" aria-label="Video timeline">
              <div style="width:${progress}%"></div>
            </div>
            <span class="player-time mono">${formatClock(p.currentTime)} / ${formatClock(p.duration)}</span>
            <div class="player-view-actions">
              <button class="btn icon ${p.theater ? "lime" : ""}" data-action="toggle-theater" title="${p.theater ? "Exit theater mode" : "Theater mode"}" aria-label="${p.theater ? "Exit theater mode" : "Theater mode"}" aria-pressed="${p.theater ? "true" : "false"}" ${p.videoUrl ? "" : "disabled"}>${icon("theater")}</button>
              <button class="btn icon ${fullscreenActive ? "lime" : ""}" data-action="toggle-fullscreen" title="${fullscreenActive ? "Exit fullscreen" : "Fullscreen"}" aria-label="${fullscreenActive ? "Exit fullscreen" : "Fullscreen"}" aria-pressed="${fullscreenActive ? "true" : "false"}" ${p.videoUrl ? "" : "disabled"}>${icon(fullscreenActive ? "fullscreenExit" : "fullscreen")}</button>
            </div>
          </div>

          <div class="player-meta-grid ${hasSubtitles ? "" : "single"}">
            <div class="queue-item">
              <div class="mono muted">VIDEO</div>
              <strong>${escapeHtml(videoName)}</strong>
            </div>
            ${hasSubtitles ? `<div class="queue-item">
              <div class="mono muted">SUBTITLE</div>
              <strong>${escapeHtml(srtName)}</strong>
            </div>` : ""}
          </div>

          ${hasSubtitles ? `<div class="player-style-panel">
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
        ${hasSubtitles ? `<aside class="player-transcript">
          <div class="mini-row" style="justify-content:space-between">
            <h3 class="h3">Transcript</h3>
            <span class="badge" style="background:var(--mint)">${cues.length} cues</span>
          </div>
          <div class="queue-list">
            ${cues.map((cue, index) => `
              <button class="subtitle-line transcript-line ${p.currentTime >= cue.start && p.currentTime <= cue.end ? "active" : ""}" data-action="seek-cue" data-time="${cue.start}" data-cue-index="${index}" data-cue-start="${cue.start}" data-cue-end="${cue.end}">
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
          <span class="intro-tile vi">Vi${starSvg("intro-star")}</span>
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

function attachDynamicHandlers() {
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
  attachPlayerDropTarget();
  attachMainPlayer();
  attachMiniPlayers();
}

function attachPlayerDropTarget() {
  const playerDrop = document.querySelector("[data-player-drop]");
  if (!playerDrop) return;

  playerDrop.addEventListener("dragover", (event) => {
    event.preventDefault();
    playerDrop.classList.add("dragging");
  });
  playerDrop.addEventListener("dragleave", (event) => {
    if (!playerDrop.contains(event.relatedTarget)) playerDrop.classList.remove("dragging");
  });
  playerDrop.addEventListener("drop", async (event) => {
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
      await loadVideoPath(filePath);
      state.player.playing = true;
      render();
    }
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

  if (action === "use-sample-curl") {
    state.download.curl = sampleCurl;
    return render();
  }
  if (action === "download-next") {
    if (state.download.step === 0 && !state.download.curl.trim()) state.download.curl = sampleCurl;
    if (state.download.step === 1 && !state.download.name.trim()) state.download.name = suggestNameFromCurl(state.download.curl);
    state.download.step = Math.min(3, state.download.step + 1);
    return render();
  }
  if (action === "download-back") {
    state.download.step = Math.max(0, state.download.step - 1);
    return render();
  }
  if (action === "pick-quality") {
    state.download.quality = actionEl.dataset.quality;
    return render();
  }
  if (action === "add-download-item") {
    addDownloadItem();
    return render();
  }
  if (action === "add-sample") {
    state.download.items.push({ name: `Sample_clip_${state.download.items.length + 1}`, quality: "1080", host: "cdn.demo.local", status: "queued", progress: 0 });
    return render();
  }
  if (action === "remove-download") {
    state.download.items.splice(Number(actionEl.dataset.index), 1);
    return render();
  }
  if (action === "start-downloads") {
    await desktop.integrations.startDownloadBatch(state.download.items);
    startDownloadSimulation();
    return;
  }
  if (action === "edit-batch") {
    stopDownloadSimulation();
    state.download.phase = "input";
    return render();
  }
  if (action === "subtitle-downloaded") {
    const item = state.download.items[Number(actionEl.dataset.index)];
    await loadVideoPath(`D:\\Downloads\\${item.name}.mp4`);
    return setScreen("subtitle");
  }

  if (action === "choose-video") {
    const picked = await desktop.selectVideo();
    if (picked) await loadVideoPath(picked);
    return render();
  }
  if (action === "choose-srt") {
    const picked = await desktop.selectSubtitle();
    if (picked) await loadSubtitlePath(picked);
    return render();
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
  if (action === "seek-back") return seekMainPlayer(state.player.currentTime - 5);
  if (action === "seek-forward") return seekMainPlayer(state.player.currentTime + 5);
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
  const tag = document.activeElement?.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return;

  if (state.screen === "player") {
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      toggleMainPlayer();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekMainPlayer(state.player.currentTime - 5);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      seekMainPlayer(state.player.currentTime + 5);
      return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "t") {
      event.preventDefault();
      toggleTheaterMode();
      return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      togglePlayerFullscreen();
      return;
    }
  }

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

document.addEventListener("fullscreenchange", syncFullscreenState);
document.addEventListener("webkitfullscreenchange", syncFullscreenState);
document.addEventListener("MSFullscreenChange", syncFullscreenState);

function addDownloadItem() {
  const d = state.download;
  d.items.push({
    name: d.name.trim() || suggestNameFromCurl(d.curl),
    quality: d.quality,
    host: extractHost(d.curl) || "cdn.demo.local",
    status: "queued",
    progress: 0
  });
  d.curl = "";
  d.name = "";
  d.quality = "2160";
  d.step = 0;
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
    render();
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

function attachMainPlayer() {
  const video = document.getElementById("mainPlayerVideo");
  if (!video) return;

  video.muted = state.player.muted;
  video.volume = state.player.volume;

  const syncState = () => {
    state.player.currentTime = video.currentTime || 0;
    state.player.duration = Number.isFinite(video.duration) ? video.duration : state.player.duration;
    state.player.playing = !video.paused && !video.ended;
    updatePlayerUi();
  };

  video.addEventListener("loadedmetadata", () => {
    state.player.duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (state.player.currentTime > 0 && state.player.currentTime < state.player.duration) {
      video.currentTime = state.player.currentTime;
    }
    updatePlayerUi();
  });
  video.addEventListener("timeupdate", syncState);
  video.addEventListener("play", syncState);
  video.addEventListener("pause", syncState);
  video.addEventListener("ended", syncState);
  video.addEventListener("volumechange", () => {
    state.player.muted = video.muted || video.volume === 0;
    state.player.volume = video.volume;
    if (video.volume > 0) state.player.lastVolume = video.volume;
    updatePlayerUi();
  });

  const scrubber = document.querySelector("[data-player-scrubber]");
  scrubber?.addEventListener("click", (event) => {
    if (!state.player.duration) return;
    const rect = scrubber.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    seekMainPlayer(ratio * state.player.duration);
  });

  const playerFrame = document.querySelector("[data-player-drop]");
  playerFrame?.addEventListener("click", () => {
    toggleMainPlayer();
  });

  const volumeSlider = document.querySelector("[data-volume-slider]");
  volumeSlider?.addEventListener("input", (event) => {
    const value = Math.min(1, Math.max(0, Number(event.target.value) || 0));
    video.volume = value;
    video.muted = value === 0;
    state.player.volume = value;
    state.player.muted = video.muted;
    if (value > 0) state.player.lastVolume = value;
    updatePlayerUi();
  });

  if (state.player.playing) {
    video.play().catch(() => {
      state.player.playing = false;
      updatePlayerUi();
    });
  }
  updatePlayerUi();
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

function updatePlayerUi() {
  const p = state.player;
  const text = hasRealSubtitleTrack() ? activeSubtitleText(p.currentTime) : "";
  const subtitleBox = document.querySelector(".visubly-subtitle");
  if (subtitleBox) subtitleBox.classList.toggle("is-empty", !text);

  const subtitle = document.querySelector(".main-subtitle-text");
  if (subtitle) subtitle.textContent = text || "";

  const time = document.querySelector(".player-time");
  if (time) time.textContent = `${formatClock(p.currentTime)} / ${formatClock(p.duration)}`;

  const fill = document.querySelector(".player-scrubber > div");
  if (fill) {
    const progress = p.duration ? Math.min(100, Math.max(0, (p.currentTime / p.duration) * 100)) : 0;
    fill.style.width = `${progress}%`;
  }

  const cueIndex = hasRealSubtitleTrack() ? state.player.cues.findIndex((cue) => p.currentTime >= cue.start && p.currentTime <= cue.end) : -1;
  document.querySelectorAll(".transcript-line").forEach((line) => {
    line.classList.toggle("active", Number(line.dataset.cueIndex) === cueIndex);
  });
  if (cueIndex !== state.player.activeCueIndex) {
    state.player.activeCueIndex = cueIndex;
    const activeLine = document.querySelector(`.transcript-line[data-cue-index="${cueIndex}"]`);
    activeLine?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  const playButton = document.querySelector('[data-action="toggle-player"]');
  if (playButton) {
    playButton.innerHTML = icon(p.playing ? "minus" : "play");
    playButton.title = p.playing ? "Pause" : "Play";
  }

  const muteButton = document.querySelector('[data-action="toggle-mute"]');
  if (muteButton) {
    muteButton.innerHTML = icon(p.muted ? "volumeOff" : "volume");
    muteButton.title = p.muted ? "Unmute" : "Mute";
    muteButton.setAttribute("aria-pressed", p.muted ? "true" : "false");
    muteButton.classList.toggle("danger", p.muted);
  }

  const theaterButton = document.querySelector('[data-action="toggle-theater"]');
  if (theaterButton) {
    theaterButton.title = p.theater ? "Exit theater mode" : "Theater mode";
    theaterButton.setAttribute("aria-label", theaterButton.title);
    theaterButton.setAttribute("aria-pressed", p.theater ? "true" : "false");
    theaterButton.classList.toggle("lime", p.theater);
  }

  p.fullscreen = isDocumentFullscreen();
  const fullscreenButton = document.querySelector('[data-action="toggle-fullscreen"]');
  if (fullscreenButton) {
    fullscreenButton.innerHTML = icon(p.fullscreen ? "fullscreenExit" : "fullscreen");
    fullscreenButton.title = p.fullscreen ? "Exit fullscreen" : "Fullscreen";
    fullscreenButton.setAttribute("aria-label", fullscreenButton.title);
    fullscreenButton.setAttribute("aria-pressed", p.fullscreen ? "true" : "false");
    fullscreenButton.classList.toggle("lime", p.fullscreen);
  }

  const visibleVolume = p.muted ? 0 : p.volume;
  const volumeSlider = document.querySelector("[data-volume-slider]");
  if (volumeSlider) {
    volumeSlider.value = String(visibleVolume);
    volumeSlider.style.setProperty("--volume-level", `${visibleVolume * 100}%`);
  }

  const volumeValue = document.querySelector(".volume-value");
  if (volumeValue) volumeValue.textContent = `${Math.round(visibleVolume * 100)}%`;
}

function toggleMainPlayer() {
  const video = document.getElementById("mainPlayerVideo");
  if (!video) return;
  if (video.paused || video.ended) video.play().catch(() => {});
  else video.pause();
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
  updatePlayerUi();
}

function toggleTheaterMode() {
  if (state.screen !== "player" || !state.player.videoUrl) return;
  state.player.theater = !state.player.theater;

  document.querySelector(".player-screen")?.classList.toggle("is-theater", state.player.theater);
  document.querySelector(".player-layout")?.classList.toggle("theater", state.player.theater);
  updatePlayerUi();
}

async function togglePlayerFullscreen() {
  if (state.screen !== "player" || !state.player.videoUrl) return;
  const activeElement = getFullscreenElement();
  if (activeElement) {
    await exitDocumentFullscreen();
    return;
  }

  const target = document.querySelector("[data-player-workbench]") || document.querySelector("[data-player-drop]");
  if (!target) return;

  try {
    await requestElementFullscreen(target);
  } catch {
    state.player.fullscreen = false;
    updatePlayerUi();
  }
}

function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;
}

function isDocumentFullscreen() {
  return Boolean(getFullscreenElement());
}

function requestElementFullscreen(element) {
  const request = element.requestFullscreen || element.webkitRequestFullscreen || element.msRequestFullscreen;
  if (!request) return Promise.resolve();
  return Promise.resolve(request.call(element));
}

function exitDocumentFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (!exit) return Promise.resolve();
  return Promise.resolve(exit.call(document));
}

function syncFullscreenState() {
  state.player.fullscreen = isDocumentFullscreen();
  updatePlayerUi();
}

function seekMainPlayer(seconds) {
  const video = document.getElementById("mainPlayerVideo");
  const target = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  state.player.currentTime = target;
  if (video) {
    video.currentTime = target;
    updatePlayerUi();
  } else {
    render();
  }
}

async function loadVideoPath(pathValue) {
  if (!pathValue) return;
  setVideoPath(pathValue);
  try {
    const url = await desktop.toFileUrl(pathValue);
    if (url) state.player.videoUrl = url;
  } catch {
    state.player.videoUrl = localPathToFileUrl(pathValue);
  }

  try {
    const matchingSubtitle = await desktop.findMatchingSubtitle(pathValue);
    if (matchingSubtitle) {
      await loadSubtitlePath(matchingSubtitle);
    } else {
      state.player.srtPath = "";
      state.player.cues = sampleCues;
      state.player.activeCueIndex = -1;
    }
  } catch {
    state.player.srtPath = "";
    state.player.cues = sampleCues;
    state.player.activeCueIndex = -1;
  }
}

async function loadSubtitlePath(pathValue) {
  if (!pathValue) return;
  let text = "";
  try {
    text = await desktop.readTextFile(pathValue);
  } catch {
    text = "";
  }
  const cues = parseSrt(text);
  state.player.srtPath = cues.length ? pathValue : "";
  state.player.cues = cues.length ? cues : sampleCues;
  state.player.currentTime = 0;
  state.player.activeCueIndex = -1;
}

function setVideoPath(pathValue) {
  const parts = pathValue.split(/[\\/]/);
  const fileName = parts[parts.length - 1] || "video.mkv";
  state.subtitle.videoPath = pathValue;
  state.subtitle.fileName = fileName;
  state.subtitle.movieTitle = parseMovieTitle(fileName);
  state.subtitle.movieEdited = false;
  state.player.videoPath = pathValue;
  state.player.videoUrl = localPathToFileUrl(pathValue);
  state.player.currentTime = 0;
  state.player.duration = 0;
  state.player.playing = false;
  state.player.activeCueIndex = -1;
}

function hasRealSubtitleTrack() {
  return Boolean(state.player.srtPath && state.player.cues.length);
}

function activeSubtitleText(seconds) {
  if (!state.player.subtitleOn) return "";
  const cue = findActiveCue(seconds);
  if (!cue) return "";
  return cue.text;
}

function findActiveCue(seconds) {
  const time = Number(seconds) || 0;
  return state.player.cues.find((cue) => time >= cue.start && time <= cue.end) || null;
}

function parseSrt(text) {
  const normalized = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .replace(/^WEBVTT[^\n]*\n+/i, "");

  return normalized
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const timeIndex = lines.findIndex((line) => line.includes("-->"));
      if (timeIndex < 0) return null;
      const [startRaw, endRaw] = lines[timeIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
      const start = parseSrtTime(startRaw);
      const end = parseSrtTime(endRaw);
      const cueText = lines.slice(timeIndex + 1).join("\n");
      if (!Number.isFinite(start) || !Number.isFinite(end) || !cueText) return null;
      return { start, end, text: cueText };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

function parseSrtTime(value) {
  const match = String(value || "").match(/(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!match) return Number.NaN;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number(match[4].padEnd(3, "0"));
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

function isSubtitlePath(pathValue) {
  return ["srt", "vtt"].includes(pathExtension(pathValue));
}

function isVideoPath(pathValue) {
  return ["mp4", "m4v", "mov", "mkv", "webm", "avi"].includes(pathExtension(pathValue));
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
  return qualities.find((q) => q.id === id)?.label || id;
}

function statusLabel(status) {
  if (status === "done") return "ready for subtitle";
  if (status === "active") return "downloading now";
  return "queued";
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

render();
