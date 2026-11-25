// "Nâng cấp video" tab (renderer). Loaded after app.js and uses its globals:
// state, render, refreshSidebar, setScreen, icon, escapeHtml, escapeAttr, showToast, formatBytes,
// loadVideoPath, modalKey, desktop. Live stats and job progress patch the DOM in place (no full re-render).
"use strict";

const upscaleApi = desktop.upscale;

const UP_PRESETS = {
  auto: { name: "Tự động", desc: "ViSUBLY chọn cách đẹp nhất mà máy này chạy ổn." },
  fast: { name: "Nhanh", desc: "Chỉ nâng nét. Xong sớm nhất." },
  balanced: { name: "Cân bằng", desc: "Khử nhiễu, nâng nét rồi làm nét." },
  best: { name: "Đẹp nhất", desc: "Khử nhiễu kỹ, nâng nét rồi làm nét. Chậm hơn." }
};
const UP_ENGINE_TEXT = {
  default: "ViSUBLY tự chọn công nghệ theo mức nâng cấp và sức máy.",
  rtx: "AI có sẵn trong driver NVIDIA, cùng công nghệ với trình phát. Nhanh nhất trên card RTX. Mức chất lượng lấy theo NVIDIA App.",
  intel: "Nâng nét bằng driver Intel trên card Arc / Iris Xe. Đang thử nghiệm: nếu lỗi, ViSUBLY tự chuyển sang FFmpeg.",
  amd: "Bộ nâng nét của AMD, chạy trên card AMD Radeon. Đang thử nghiệm: nếu lỗi, ViSUBLY tự chuyển sang FFmpeg.",
  onnx: "Mô hình AI nhỏ chạy trên mọi card hỗ trợ DirectX 12 (NVIDIA, AMD, Intel). Chi tiết hơn bộ lọc, chậm hơn RTX.",
  cugan: "AI chi tiết nhất cho hoạt hình, chạy bằng TensorRT trên card NVIDIA RTX. Chậm, cần tải thêm gói AI.",
  ffmpeg: "Phóng to sắc nét bằng bộ lọc, không dùng AI. Chạy trên mọi máy."
};
const UP_EXTRA_TEXT = {
  smooth: "RIFE tạo thêm khung hình để video mượt như 60 khung/giây. Không làm nét hơn; thời gian và dung lượng gần gấp đôi.",
  anime: "Ưu tiên cách xử lý hợp với hoạt hình: khử nhiễu nhẹ hơn để giữ nét viền, làm nét mạnh hơn.",
  deblock: "AI xoá các khối vuông do nén nặng, chạy bằng TensorRT trên card NVIDIA RTX. Chậm, cần tải thêm gói AI."
};
const UP_ENGINE_ORDER = ["default", "rtx", "intel", "amd", "onnx", "cugan", "ffmpeg"];
const UP_EXTRA_ORDER = ["smooth", "anime", "deblock"];
const UP_FIT = {
  ok: { text: "Phù hợp với máy", cls: "is-ok", note: "Máy chạy ổn với cách này." },
  heavy: { text: "Nặng: máy sẽ nóng", cls: "is-heavy", note: "Chạy được nhưng chậm, máy nóng và quạt kêu to." },
  over: { text: "Quá sức máy", cls: "is-over", note: "Máy có thể bị treo hoặc ViSUBLY phải dừng giữa chừng." }
};
const UP_SIZES = [["small", "Nhỏ gọn"], ["balanced", "Vừa"], ["high", "Chất lượng cao"]];
const UP_ACTIVE = new Set(["starting", "running", "paused", "cancelling"]);

state.upscale = {
  deviceStatus: "idle", device: null, deviceError: null, helper: true, stats: null,
  video: null, choice: { preset: "auto", engine: "default", extras: {}, target: "auto", size: "balanced" },
  describe: null, explain: null, job: { status: "idle" }, busy: "", error: "",
  compare: null, closeRequest: null
};
const up = state.upscale;

// ---- small helpers -----------------------------------------------------------------------------------

function upGb(mb) {
  return (mb / 1024).toFixed(1).replace(".", ",");
}

function upDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return "dưới 1 phút";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} phút`;
  return `${Math.floor(m / 60)} giờ ${m % 60} phút`;
}

function upClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function upJobActive() {
  return UP_ACTIVE.has(up.job && up.job.status);
}

function upTier(device) {
  const b = (device && device.bench) || {};
  const score = Math.max((b.vsrFps || 0) / 185, (b.ffmpegFps || 0) / 64);
  if (score >= 1.6) return "Mạnh";
  if (score >= 0.8) return "Mạnh vừa";
  if (score >= 0.4) return "Trung bình";
  return score > 0 ? "Yếu" : "Đang đo";
}

// ---- bridge ------------------------------------------------------------------------------------------

function applyUpscaleState(s) {
  if (!s) return;
  up.helper = s.helper !== false;
  up.deviceStatus = s.deviceStatus || up.deviceStatus;
  up.device = s.device || up.device;
  up.deviceError = s.deviceError || null;
  if (s.video) up.video = s.video;
  if (s.job) up.job = s.job;
  if (s.stats) up.stats = s.stats;
}

function upscaleRerender() {
  if (state.screen === "upscale" || modalKey().startsWith("up-")) render();
  else if (typeof refreshSidebar === "function") refreshSidebar();
}

if (upscaleApi) {
  upscaleApi.onDevice(({ status, device, error } = {}) => {
    up.deviceStatus = status || up.deviceStatus;
    if (device) up.device = device;
    up.deviceError = error || null;
    if (status === "ready") refreshUpscalePlan();
    else upscaleRerender();
  });
  upscaleApi.onStats((s) => {
    up.stats = s;
    if (state.screen === "upscale") patchUpscaleStats();
  });
  upscaleApi.onJob((job) => {
    const prev = up.job || {};
    up.job = job;
    const structural = prev.status !== job.status || prev.notice !== job.notice || prev.label !== job.label;
    if (structural) upscaleRerender();
    else patchUpscaleProgress();
  });
  upscaleApi.onCompareProgress((p) => {
    if (!up.compare || up.compare.status !== "running") return;
    up.compare.progress = p;
    const el = document.querySelector("[data-up-compare-progress]");
    if (el) el.textContent = upCompareProgressText(p);
  });
  upscaleApi.onCloseRequest((info) => {
    up.closeRequest = info || {};
    render();
  });
  upscaleApi.getState().then((s) => { applyUpscaleState(s); if (upJobActive()) upscaleRerender(); }).catch(() => {});
}

function upscaleEnter() {
  if (!upscaleApi) return;
  upscaleApi.watchStats(true);
  if (!up.device && up.deviceStatus !== "probing") {
    up.deviceStatus = "probing";
    upscaleApi.probe(false).then((s) => { applyUpscaleState(s); refreshUpscalePlan(); }).catch(() => {});
  } else {
    refreshUpscalePlan();
  }
}

function upscaleLeave() {
  if (upscaleApi) upscaleApi.watchStats(false);
}

async function refreshUpscalePlan() {
  if (!upscaleApi || !up.video) {
    up.describe = null;
    upscaleRerender();
    return;
  }
  try {
    up.describe = await upscaleApi.describe(up.choice);
  } catch (error) {
    up.error = error.message;
  }
  upscaleRerender();
}

async function setUpscaleVideo(result) {
  up.busy = "";
  if (result && result.ok) {
    up.video = result.video;
    up.error = "";
    up.explain = null;
    if (up.job && ["done", "cancelled", "error"].includes(up.job.status)) await upscaleApi.dismiss();
    await refreshUpscalePlan();
    return;
  }
  if (result && !result.canceled) {
    up.error = result.error || "Không mở được video này.";
    showToast(up.error);
  }
  upscaleRerender();
}

async function upscaleOnDrop(filePath, droppedCount) {
  if (upJobActive()) return showToast("Đang nâng cấp một video. Chờ xong hoặc hủy rồi chọn video khác.");
  up.busy = "pick";
  render();
  const result = await upscaleApi.setVideo(filePath);
  if (droppedCount > 1 && result.ok) showToast("Mỗi lần nâng cấp một video: đã chọn video đầu tiên.");
  return setUpscaleVideo(result);
}

// ---- actions -----------------------------------------------------------------------------------------

function upExplain(title, text) {
  up.explain = { title, text };
}

async function handleUpscaleAction(action, el) {
  const value = el.dataset.value || "";
  const caps = up.describe && up.describe.capabilities;
  switch (action) {
    case "pick": {
      if (upJobActive()) return;
      up.busy = "pick";
      render();
      return setUpscaleVideo(await upscaleApi.selectVideo());
    }
    case "preset":
      up.choice = { ...up.choice, preset: value };
      upExplain(UP_PRESETS[value].name, UP_PRESETS[value].desc);
      return refreshUpscalePlan();
    case "engine": {
      const info = caps && caps.engines[value];
      const name = value === "default" ? "Theo mức nâng cấp" : (up.describe.engineNames[value] || value);
      if (value !== "default" && info && !info.available) {
        upExplain(`${name} · không dùng được`, info.reason);
        return render();
      }
      up.choice = { ...up.choice, engine: value };
      upExplain(name, UP_ENGINE_TEXT[value] || "");
      return refreshUpscalePlan();
    }
    case "extra": {
      const info = caps && caps.extras[value];
      const name = (up.describe && up.describe.extraNames[value]) || value;
      if (info && !info.available) {
        upExplain(`${name} · không dùng được`, info.reason);
        return render();
      }
      up.choice = { ...up.choice, extras: { ...up.choice.extras, [value]: !up.choice.extras[value] } };
      upExplain(name, UP_EXTRA_TEXT[value] || "");
      return refreshUpscalePlan();
    }
    case "target":
      up.choice = { ...up.choice, target: value };
      return refreshUpscalePlan();
    case "size":
      up.choice = { ...up.choice, size: value };
      return refreshUpscalePlan();
    case "start":
      return startUpscale();
    case "pause":
      up.job = await upscaleApi.pause();
      return render();
    case "resume":
      up.job = await upscaleApi.resume();
      return render();
    case "cancel":
      if (!window.confirm("Hủy nâng cấp video này? Phần đã làm sẽ bị xoá.")) return;
      return upscaleApi.cancel();
    case "dismiss":
      up.job = await upscaleApi.dismiss();
      return refreshUpscalePlan();
    case "reveal":
      return upscaleApi.reveal(up.job.output);
    case "play-output": {
      const output = up.job.output;
      await loadVideoPath(output);
      return setScreen("player");
    }
    case "reprobe":
      up.deviceStatus = "probing";
      render();
      applyUpscaleState(await upscaleApi.probe(true));
      return refreshUpscalePlan();
    case "compare-open":
      return openUpscaleCompare();
    case "compare-run":
      return runUpscaleCompare();
    case "compare-pos":
      up.compare.position = value;
      return runUpscaleCompare();
    case "compare-len":
      up.compare.seconds = Number(value);
      return runUpscaleCompare();
    case "compare-tab":
      up.compare.tab = value;
      return render();
    case "compare-frame":
      up.compare.frame = Number(value);
      return render();
    case "compare-use": {
      const variant = up.compare.data && up.compare.data.variants.find((v) => v.key === up.compare.tab);
      if (variant && variant.apply) up.choice = { ...up.choice, ...variant.apply };
      await closeUpscaleCompare();
      return refreshUpscalePlan();
    }
    case "compare-cancel":
      return upscaleApi.compareCancel();
    case "compare-close":
      return closeUpscaleCompare();
    case "close-stay":
      up.closeRequest = null;
      return render();
    case "close-quit":
      up.closeRequest = null;
      render();
      return upscaleApi.confirmClose("quit");
    default:
      return undefined;
  }
}

async function startUpscale() {
  const plan = up.describe && up.describe.plan;
  if (!plan || upJobActive()) return;
  if (plan.fit === "over" && !window.confirm("Cách này vượt sức máy: máy có thể bị treo hoặc quá nóng. Vẫn bắt đầu?")) return;
  if (plan.diskShort && !window.confirm("Ổ lưu có thể không đủ chỗ cho file mới. Vẫn bắt đầu?")) return;
  up.busy = "start";
  render();
  const result = await upscaleApi.start(up.choice);
  up.busy = "";
  if (!result.ok) showToast(result.error || "Không bắt đầu được.");
  else up.job = result.state;
  render();
}

document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-up]");
  if (!el || el.disabled) return;
  handleUpscaleAction(el.dataset.up, el).catch((error) => showToast(error.message || String(error)));
});

document.addEventListener("input", (event) => {
  if (!event.target.matches("[data-up-split]")) return;
  const split = Number(event.target.value) || 0;
  if (up.compare) up.compare.split = split;
  const after = document.querySelector("[data-up-after]");
  const divider = document.querySelector("[data-up-divider]");
  if (after) after.style.clipPath = `inset(0 0 0 ${split}%)`;
  if (divider) divider.style.left = `${split}%`;
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (up.closeRequest) { up.closeRequest = null; render(); }
  else if (up.compare && up.compare.status !== "running") closeUpscaleCompare();
});

// ---- compare -----------------------------------------------------------------------------------------

function openUpscaleCompare() {
  if (!up.video || upJobActive()) return;
  up.compare = { status: "running", position: "start", seconds: 10, tab: "chosen", frame: 1, split: 50, progress: null, data: null, error: "" };
  runUpscaleCompare();
}

async function runUpscaleCompare() {
  if (!up.compare) return;
  const c = up.compare;
  const d = up.video.duration || 0;
  const start = c.position === "middle" ? d * 0.5 : c.position === "end" ? d * 0.85 : d * 0.15;
  c.status = "running";
  c.progress = null;
  c.error = "";
  render();
  const result = await upscaleApi.compare({ choice: up.choice, start, seconds: c.seconds });
  if (!up.compare) return;
  if (result.cancelled) { await closeUpscaleCompare(); return; }
  if (!result.ok) {
    c.status = "error";
    c.error = result.error || "Không thử được đoạn này.";
  } else {
    c.status = "done";
    c.data = result;
    if (!result.variants.some((v) => v.key === c.tab && v.ok)) c.tab = (result.variants.find((v) => v.ok) || {}).key || "chosen";
  }
  render();
}

async function closeUpscaleCompare() {
  if (up.compare && up.compare.status === "running") await upscaleApi.compareCancel();
  up.compare = null;
  await upscaleApi.compareClose();
  render();
}

function upCompareProgressText(p) {
  if (!p) return "Đang chuẩn bị…";
  if (p.phase === "frames") return "Đang chụp ảnh trước / sau…";
  return `Đang xử lý ${p.step}/${p.steps}: ${p.label}…`;
}

// ---- rendering ---------------------------------------------------------------------------------------

function renderUpscaleNavItem() {
  const active = state.screen === "upscale";
  const running = upJobActive();
  const badge = running ? `${Math.floor(up.job.percent || 0)}%` : "Mới";
  return `
    <button type="button" class="nav-item ${active ? "active" : ""}" data-screen="upscale" ${active ? 'aria-current="page"' : ""}>
      ${icon("sparkle", { size: 20, stroke: 2 })}
      <span>Nâng cấp video</span>
      <span class="up-nav-badge ${running ? "is-running" : ""}" data-up-nav-badge>${badge}</span>
    </button>
  `;
}

function renderUpscale() {
  const helperMissing = !up.helper;
  return `
    <section class="screen up-screen">
      <div class="up-head">
        <h1 class="h1">Nâng cấp video</h1>
        <p class="muted">Làm nét video 360p / 480p thành bản mới, từng video một. File gốc giữ nguyên.</p>
      </div>
      ${helperMissing ? `<div class="inline-error">Thiếu bộ xử lý nâng cấp đi kèm ViSUBLY. Hãy cài lại ViSUBLY bản mới nhất.</div>` : ""}
      <div class="up-layout">
        <div class="up-main">
          ${renderUpscaleVideoCard()}
          ${renderUpscaleBody()}
        </div>
        ${renderUpscaleDevice()}
      </div>
    </section>
  `;
}

function renderUpscaleVideoCard() {
  const v = up.video;
  const busy = up.busy === "pick";
  if (!v) {
    return `
      <button type="button" class="card up-drop" data-up="pick" ${busy ? "disabled" : ""}>
        ${icon("plus", { size: 26, stroke: 2 })}
        <strong>${busy ? "Đang đọc video…" : "Chọn video cần nâng cấp"}</strong>
        <span class="muted">Hoặc kéo thả file video vào đây. MP4, MKV, MOV, WEBM, AVI…</span>
      </button>
    `;
  }
  const locked = upJobActive();
  return `
    <section class="card up-video" aria-label="Video cần nâng cấp">
      <div class="up-thumb">${v.thumbnail ? `<img src="${escapeAttr(v.thumbnail)}" alt="">` : `<span class="mono">${v.height}p</span>`}</div>
      <div class="up-video-text">
        <strong class="up-video-name" title="${escapeAttr(v.path)}">${escapeHtml(v.name)}</strong>
        <span class="muted">${v.width}×${v.height} · ${Math.round(v.fps)} khung/giây · dài ${upClock(v.duration)}${v.hasAudio ? "" : " · không có tiếng"}</span>
        <span class="muted up-path">${escapeHtml(v.outputDir || "")}</span>
      </div>
      ${locked ? "" : `<button type="button" class="btn" data-up="pick" ${busy ? "disabled" : ""}>${busy ? "Đang đọc…" : "Đổi video"}</button>`}
    </section>
  `;
}

function renderUpscaleBody() {
  const job = up.job || {};
  if (upJobActive()) return renderUpscaleRunning();
  if (job.status === "done") return renderUpscaleDone();
  if (job.status === "error") return renderUpscaleError();
  if (!up.video) return "";
  if (up.deviceStatus === "probing" && !up.device) {
    return `<section class="card up-card"><h2 class="h2">Đang đo máy…</h2><p class="muted">ViSUBLY kiểm tra card đồ hoạ và đo nhanh tốc độ (vài giây, chỉ lần đầu).</p><div class="up-bar is-indeterminate"><span></span></div></section>`;
  }
  return renderUpscaleSetup();
}

function renderUpscaleSetup() {
  const d = up.describe;
  if (!d || !d.plan) {
    const tooSmall = d && !d.targets.length;
    return `<section class="card up-card"><p class="muted">${tooSmall ? "Video này đã có độ phân giải cao, không cần nâng cấp." : "Đang chuẩn bị…"}</p></section>`;
  }
  const p = d.plan;
  const c = up.choice;
  const caps = d.capabilities;
  const fit = UP_FIT[p.fit] || UP_FIT.ok;
  const autoTarget = d.auto ? d.auto.target : p.target;
  const explain = up.explain || { title: "Gợi ý", text: "Để Tự động là đủ cho hầu hết video. Bấm vào một lựa chọn để xem giải thích tại đây." };
  const presetCard = (key) => {
    const on = c.preset === key;
    const f = UP_FIT[d.presets[key]] || UP_FIT.ok;
    return `
      <button type="button" class="up-preset ${on ? "is-on" : ""}" data-up="preset" data-value="${key}" aria-pressed="${on}">
        <span class="up-preset-title"><span class="up-radio" aria-hidden="true"></span><strong>${UP_PRESETS[key].name}</strong></span>
        <span class="up-preset-desc">${UP_PRESETS[key].desc}</span>
        <span class="up-fit ${f.cls}">${key === "auto" ? "Đề xuất · " : ""}${f.text}</span>
      </button>`;
  };
  const chip = (action, key, label, on, blocked) => `
    <button type="button" class="up-chip ${on ? "is-on" : ""} ${blocked ? "is-blocked" : ""}" data-up="${action}" data-value="${key}" aria-pressed="${on}" ${blocked ? 'aria-disabled="true"' : ""}>${label}</button>`;
  const extras = UP_EXTRA_ORDER.map((k) => {
    const info = caps.extras[k];
    const on = Boolean(c.extras[k]) && info.available;
    return chip("extra", k, `${!info.available ? "✕" : on ? "✓" : "+"} ${escapeHtml(d.extraNames[k])}`, on, !info.available);
  }).join("");
  const engines = UP_ENGINE_ORDER.map((k) => {
    if (k === "default") return chip("engine", k, "Theo mức nâng cấp", c.engine === "default", false);
    const info = caps.engines[k];
    return chip("engine", k, escapeHtml(d.engineNames[k]), c.engine === k && info.available, !info.available);
  }).join("");
  const targets = [chip("target", "auto", `Tự động (${autoTarget})`, c.target === "auto", false)]
    .concat(d.targets.map((t) => chip("target", t, t, c.target === t, false))).join("");
  const sizes = UP_SIZES.map(([k, label]) => chip("size", k, label, c.size === k, false)).join("");
  const warn = p.fit === "over"
    ? "Cách này vượt sức máy. Nên chọn mức nhẹ hơn hoặc độ phân giải thấp hơn. Bấm Tự động để ViSUBLY chọn lại cho vừa máy."
    : p.fit === "heavy" ? "Cách này nặng với máy. Không nên dùng máy cho việc nặng khác trong lúc chạy." : "";
  const out = d.output || {};
  return `
    <section class="card up-card" aria-label="Cách nâng cấp">
      <div class="up-block">
        <h2 class="h2">Mức nâng cấp</h2>
        <div class="up-presets">${["auto", "fast", "balanced", "best"].map(presetCard).join("")}</div>
        <div class="up-uses">Sẽ dùng: <strong>${escapeHtml(p.label)}</strong>${p.experimental ? ` <span class="up-tag">thử nghiệm</span>` : ""}</div>
      </div>
      <div class="up-block">
        <div class="up-label">Thêm tuỳ chọn <span class="muted">· bấm để bật hoặc tắt</span></div>
        <div class="up-chips">${extras}</div>
      </div>
      <div class="up-block">
        <div class="up-label">Công nghệ nâng nét <span class="muted">· để mặc định nếu không chắc</span></div>
        <div class="up-chips">${engines}</div>
      </div>
      <div class="up-explain" role="note"><span class="up-i" aria-hidden="true">i</span><span><strong>${escapeHtml(explain.title)}.</strong> ${escapeHtml(explain.text)}</span></div>
      <div class="up-two">
        <div class="up-block"><div class="up-label">Độ phân giải mới</div><div class="up-chips">${targets}</div></div>
        <div class="up-block"><div class="up-label">Dung lượng file mới</div><div class="up-chips">${sizes}</div></div>
      </div>
      <div class="muted up-small">Giữ nguyên âm thanh gốc và chép kèm phụ đề (.srt, .ass…) nếu có. Lưu thành <span class="mono">${escapeHtml(out.file ? out.file.split(/[\\/]/).pop() : "")}</span> cạnh file gốc.</div>
      <div class="up-summary">
        <div class="up-fit-row"><span class="up-fit is-big ${fit.cls}">${fit.text}</span><span class="muted">${fit.note}</span></div>
        ${warn ? `<div class="up-warn ${p.fit === "over" ? "is-over" : ""}" role="alert">${icon("warn", { size: 16 })}<span>${warn}</span></div>` : ""}
        ${p.diskShort ? `<div class="up-warn is-over" role="alert">${icon("warn", { size: 16 })}<span>Ổ lưu có thể không đủ chỗ cho file mới (cần khoảng ${formatBytes(p.sizeBytes)}).</span></div>` : ""}
        <div class="up-actions">
          <div class="up-est">Mất khoảng <strong>${upDuration(p.seconds)}</strong> · file mới khoảng <strong>${formatBytes(p.sizeBytes)}</strong>${out.freeBytes ? ` · ổ còn ${formatBytes(out.freeBytes)}` : ""}</div>
          <button type="button" class="btn outline up-accent-btn" data-up="compare-open">${icon("compare", { size: 16 })}<span>Thử &amp; so sánh</span></button>
          <button type="button" class="btn ${p.fit === "over" ? "danger-text up-over-btn" : "primary"}" data-up="start" ${up.busy === "start" ? "disabled" : ""}>${p.fit === "over" ? "Vẫn bắt đầu (không khuyến nghị)" : "Bắt đầu nâng cấp"}</button>
        </div>
      </div>
    </section>
  `;
}

function renderUpscaleRunning() {
  const j = up.job;
  const paused = j.status === "paused";
  const fps = (j.video && j.video.fps) || 30;
  const pausedText = j.pausedReason === "hot" ? "Tạm dừng để máy nguội" : j.pausedReason === "disk" ? "Tạm dừng: ổ sắp đầy" : "Đã tạm dừng";
  return `
    <section class="card up-card up-running" aria-label="Đang nâng cấp">
      <div class="up-run-head">
        <h2 class="h2">${j.status === "cancelling" ? "Đang hủy…" : paused ? pausedText : "Đang nâng cấp"}</h2>
        <span class="up-tag is-accent">${escapeHtml(UP_PRESETS[up.choice.preset] ? UP_PRESETS[up.choice.preset].name : "")}</span>
      </div>
      <div class="muted">${escapeHtml(j.label || "")}</div>
      ${j.notice ? `<div class="up-warn" role="status">${icon("warn", { size: 16 })}<span>${escapeHtml(j.notice)}</span></div>` : ""}
      <div class="up-progress">
        <div class="up-progress-row"><span class="muted" data-up-done>Đã xong ${upClock((j.frame || 0) / fps)} / ${upClock(((j.total || 0) / fps))}</span><strong data-up-eta>${j.etaSec != null && !paused ? `Còn khoảng ${upDuration(j.etaSec)}` : ""}</strong></div>
        <div class="up-bar ${paused ? "is-paused" : ""}"><span data-up-bar style="width:${Math.min(100, j.percent || 0).toFixed(1)}%"></span></div>
        <div class="up-progress-row muted"><span data-up-percent>${Math.floor(j.percent || 0)}%</span><span data-up-fps>${j.fps ? `${j.fps} khung/giây` : ""}</span></div>
      </div>
      <div class="up-run-actions">
        ${paused ? `<button type="button" class="btn primary" data-up="resume">${icon("play", { size: 16 })}<span>Tiếp tục</span></button>` : `<button type="button" class="btn" data-up="pause" ${j.status !== "running" ? "disabled" : ""}>${icon("pause", { size: 16 })}<span>Tạm dừng</span></button>`}
        <button type="button" class="btn danger-text" data-up="cancel" ${j.status === "cancelling" ? "disabled" : ""}>Hủy</button>
        <span class="muted up-small up-run-tip">Vẫn dùng app bình thường được. Nếu đóng app, ViSUBLY sẽ hỏi lại.</span>
      </div>
    </section>
  `;
}

function renderUpscaleDone() {
  const j = up.job;
  const took = j.finishedAt && j.startedAt ? (j.finishedAt - j.startedAt) / 1000 : 0;
  return `
    <section class="card up-card up-done" aria-label="Đã nâng cấp xong">
      <h2 class="h2">${icon("check", { size: 20 })} Đã nâng cấp xong</h2>
      <div><strong>${escapeHtml((j.output || "").split(/[\\/]/).pop())}</strong></div>
      <div class="muted">${escapeHtml(j.label || "")} · ${formatBytes(j.sizeBytes || 0)} · mất ${upDuration(took)}${j.subtitles && j.subtitles.length ? ` · đã chép ${j.subtitles.length} file phụ đề` : ""}</div>
      ${j.notice ? `<div class="up-warn">${icon("warn", { size: 16 })}<span>${escapeHtml(j.notice)}</span></div>` : ""}
      <div class="up-run-actions">
        <button type="button" class="btn primary" data-up="play-output">${icon("play", { size: 16 })}<span>Xem trong ViSUBLY</span></button>
        <button type="button" class="btn" data-up="reveal">${icon("folder", { size: 16 })}<span>Mở thư mục</span></button>
        <button type="button" class="btn ghost" data-up="dismiss">Nâng cấp tiếp</button>
      </div>
    </section>
  `;
}

function renderUpscaleError() {
  const j = up.job;
  return `
    <section class="card up-card" aria-label="Lỗi">
      <h2 class="h2">Chưa nâng cấp được</h2>
      <div class="inline-error">${escapeHtml(j.error || "Bộ xử lý gặp lỗi.")}</div>
      ${j.errorDetail ? `<details class="up-small"><summary>Chi tiết kỹ thuật</summary><pre class="mono up-pre">${escapeHtml(j.errorDetail)}</pre></details>` : ""}
      <div class="up-run-actions"><button type="button" class="btn primary" data-up="dismiss">Chọn lại cấu hình</button></div>
    </section>
  `;
}

function upMeters() {
  const s = up.stats || {};
  const g = s.gpu;
  const rows = [];
  if (g) {
    rows.push(["gpuUtil", "GPU đang dùng", g.util != null ? `${g.util}%` : "—", g.util || 0, "is-accent"]);
    if (g.memTotalMb) rows.push(["gpuMem", "Bộ nhớ GPU", `${upGb(g.memUsedMb || 0)} / ${upGb(g.memTotalMb)} GB`, ((g.memUsedMb || 0) / g.memTotalMb) * 100, "is-accent"]);
    rows.push(["gpuTemp", "Nhiệt độ GPU", g.tempC != null ? `${g.tempC}°C` : "—", g.tempC || 0, g.tempC >= 80 ? "is-warn" : "is-mint"]);
    if (g.powerLimitW) rows.push(["gpuPower", "Công suất GPU", `${g.powerW || 0} / ${g.powerLimitW} W`, ((g.powerW || 0) / g.powerLimitW) * 100, "is-mint"]);
  } else {
    rows.push(["gpuNa", "Card đồ hoạ", "Card này không báo thông số", 0, "is-mint"]);
  }
  if (s.cpu) rows.push(["cpu", `CPU · ${s.cpu.threads} luồng`, `${s.cpu.percent}%`, s.cpu.percent, "is-muted"]);
  if (s.ram) rows.push(["ram", "RAM", `${upGb(s.ram.usedMb)} / ${upGb(s.ram.totalMb)} GB`, (s.ram.usedMb / s.ram.totalMb) * 100, "is-muted"]);
  if (s.battery) rows.push(["battery", "Pin", `${s.battery.percent}%${s.battery.onBattery ? " · đang dùng pin" : " · đang cắm sạc"}`, s.battery.percent, s.battery.onBattery ? "is-warn" : "is-mint"]);
  return rows;
}

function renderUpscaleDevice() {
  const d = up.device;
  const probing = up.deviceStatus === "probing";
  const adapter = d && d.adapters && d.adapters[0];
  const caps = up.describe && up.describe.capabilities;
  const enc = (d && d.encoders) || {};
  const chips = d ? [
    ["RTX Video", caps ? caps.engines.rtx.available : (d.vsr || []).some((v) => v.vendor === "nvidia" && v.effective)],
    ["Intel AI", caps ? caps.engines.intel.available : false],
    ["AMD FSR", caps ? caps.engines.amd.available : false],
    ["Bộ lọc GPU (Vulkan)", Boolean(d.vulkan)],
    [enc.hevc_nvenc ? "Mã hoá NVENC" : enc.hevc_amf ? "Mã hoá AMF" : enc.hevc_qsv ? "Mã hoá Quick Sync" : "Mã hoá bằng CPU", Boolean(enc.hevc_nvenc || enc.hevc_amf || enc.hevc_qsv)]
  ] : [];
  const outRoot = up.video && up.video.outputDir ? up.video.outputDir.slice(0, 2).toUpperCase() : "";
  const disks = ((up.stats && up.stats.disks) || []).map((k) => {
    const used = k.total ? ((k.total - k.free) / k.total) * 100 : 0;
    const main = k.root.toUpperCase() === outRoot;
    return `
      <div class="up-meter" data-up-disk="${escapeAttr(k.root)}">
        <div class="up-meter-row"><span>${escapeHtml(k.root)}${main ? " · lưu file mới" : ""}</span><span class="mono" data-up-value>${formatBytes(k.free)} / ${formatBytes(k.total)} trống</span></div>
        <div class="up-meter-bar"><span class="${used > 90 ? "is-warn" : "is-muted"}" data-up-fill style="width:${used.toFixed(0)}%"></span></div>
      </div>`;
  }).join("");
  const plan = up.describe && up.describe.plan;
  return `
    <aside class="card up-device" aria-label="Thiết bị">
      <div class="up-device-head">
        <h2 class="h2">Thiết bị</h2>
        <span class="up-status ${probing ? "is-busy" : ""}"><span class="up-dot"></span>${probing ? "Đang đo máy…" : upJobActive() ? "Đang xử lý" : "Sẵn sàng"}</span>
      </div>
      <div class="up-gpu">
        ${icon("gpu", { size: 30, stroke: 1.6 })}
        <div>
          <div class="up-gpu-name">${escapeHtml((adapter && adapter.name) || (d && d.gpu) || "Đang đọc card đồ hoạ…")}</div>
          <div class="mono muted up-small">${[d && d.driver ? `Driver ${escapeHtml(d.driver)}` : "", adapter ? (adapter.vramMb >= 1024 ? `${Math.round(adapter.vramMb / 1024)} GB VRAM` : "dùng chung RAM") : ""].filter(Boolean).join(" · ")}</div>
        </div>
      </div>
      ${d ? `<div class="up-small">Sức máy: <strong>${upTier(d)}</strong>.${plan && up.describe.auto ? ` Tự động chọn: ${escapeHtml(plan.auto ? plan.label : "")}` : ""}</div>` : ""}
      ${d && d.cpu ? `<div class="muted up-small">${escapeHtml(d.cpu.model)} · ${Math.round((d.ramMb || 0) / 1024)} GB RAM</div>` : ""}
      <div class="up-chips is-tight">${chips.map(([label, ok]) => `<span class="up-cap ${ok ? "is-ok" : ""}">${ok ? "✓" : "✕"} ${escapeHtml(label)}</span>`).join("")}</div>
      ${d && (d.vsr || []).some((v) => v.vendor === "nvidia" && v.accepted && !v.effective) ? `<div class="up-warn">${icon("warn", { size: 16 })}<span>RTX Video đang tắt trong NVIDIA App. Bật RTX Video Enhancement → Super Resolution rồi bấm Đo lại.</span></div>` : ""}
      <div class="up-meters">
        <div class="up-label-mono">Đang chạy · cập nhật mỗi giây</div>
        ${upMeters().map(([key, label, value, pct, cls]) => `
          <div class="up-meter" data-up-meter="${key}">
            <div class="up-meter-row"><span>${label}</span><span class="mono" data-up-value>${escapeHtml(value)}</span></div>
            <div class="up-meter-bar"><span class="${cls}" data-up-fill style="width:${Math.max(0, Math.min(100, pct)).toFixed(0)}%"></span></div>
          </div>`).join("")}
      </div>
      ${disks ? `<div class="up-meters"><div class="up-label-mono">Ổ đĩa</div>${disks}</div>` : ""}
      <div class="up-safety">${icon("warn", { size: 16 })}<span>Tự tạm dừng khi máy quá nóng hoặc ổ đĩa sắp hết chỗ. Card đồ hoạ lỗi thì chuyển sang FFmpeg và báo lý do.</span></div>
      <button type="button" class="btn ghost small" data-up="reprobe" ${probing || upJobActive() ? "disabled" : ""}>Đo lại máy</button>
    </aside>
  `;
}

function patchUpscaleStats() {
  const meters = upMeters();
  const existing = document.querySelectorAll("[data-up-meter]");
  if (existing.length !== meters.length) return render();
  for (const [key, , value, pct] of meters) {
    const el = document.querySelector(`[data-up-meter="${key}"]`);
    if (!el) return render();
    el.querySelector("[data-up-value]").textContent = value;
    el.querySelector("[data-up-fill]").style.width = `${Math.max(0, Math.min(100, pct)).toFixed(0)}%`;
  }
  for (const k of (up.stats && up.stats.disks) || []) {
    const el = document.querySelector(`[data-up-disk="${k.root}"]`);
    if (!el) continue;
    el.querySelector("[data-up-value]").textContent = `${formatBytes(k.free)} / ${formatBytes(k.total)} trống`;
  }
}

function patchUpscaleProgress() {
  const badge = document.querySelector("[data-up-nav-badge]");
  if (badge && upJobActive()) badge.textContent = `${Math.floor(up.job.percent || 0)}%`;
  if (state.screen !== "upscale") return;
  const j = up.job;
  const fps = (j.video && j.video.fps) || 30;
  const set = (sel, text) => { const el = document.querySelector(sel); if (el) el.textContent = text; };
  const bar = document.querySelector("[data-up-bar]");
  if (bar) bar.style.width = `${Math.min(100, j.percent || 0).toFixed(1)}%`;
  set("[data-up-done]", `Đã xong ${upClock((j.frame || 0) / fps)} / ${upClock((j.total || 0) / fps)}`);
  set("[data-up-eta]", j.etaSec != null && j.status === "running" ? `Còn khoảng ${upDuration(j.etaSec)}` : "");
  set("[data-up-percent]", `${Math.floor(j.percent || 0)}%`);
  set("[data-up-fps]", j.fps ? `${j.fps} khung/giây` : "");
}

// ---- modals ------------------------------------------------------------------------------------------

function upscaleModalKey() {
  if (up.closeRequest) return "up-close";
  if (up.compare) return `up-compare:${up.compare.status}`;
  return "";
}

function renderUpscaleModals() {
  if (up.closeRequest) return renderUpscaleCloseDialog();
  if (up.compare) return renderUpscaleCompare();
  return "";
}

function renderUpscaleCloseDialog() {
  const r = up.closeRequest || {};
  return `
    <div class="dialog-overlay" role="presentation">
      <section class="dialog is-narrow up-close" role="alertdialog" aria-labelledby="upCloseTitle" aria-describedby="upCloseText">
        <span class="up-tag is-warn">ĐANG NÂNG CẤP ${r.percent || 0}%</span>
        <h2 class="h2" id="upCloseTitle">Thoát ViSUBLY bây giờ?</h2>
        <p class="muted" id="upCloseText">${escapeHtml(r.name || "Video")} đang được nâng cấp${r.etaSec ? `, còn khoảng ${upDuration(r.etaSec)}` : ""}. Nếu thoát, phần đã làm sẽ bị xoá và lần sau phải chạy lại từ đầu.</p>
        <div class="up-dialog-actions">
          <button type="button" class="btn danger-text up-over-btn" data-up="close-quit">Dừng và thoát</button>
          <button type="button" class="btn primary" data-up="close-stay" autofocus>Tiếp tục nâng cấp</button>
        </div>
      </section>
    </div>
  `;
}

function renderUpscaleCompare() {
  const c = up.compare;
  const chips = (action, items, current) => items.map(([k, label]) => `<button type="button" class="up-chip ${String(current) === String(k) ? "is-on" : ""}" data-up="${action}" data-value="${k}" ${c.status === "running" ? "disabled" : ""}>${label}</button>`).join("");
  let body = "";
  if (c.status === "running") {
    body = `
      <div class="up-compare-wait">
        <div class="up-bar is-indeterminate"><span></span></div>
        <div data-up-compare-progress>${upCompareProgressText(c.progress)}</div>
        <div class="muted up-small">Chỉ chạy trên một đoạn ngắn, mất khoảng nửa phút.</div>
        <button type="button" class="btn" data-up="compare-cancel">Hủy</button>
      </div>`;
  } else if (c.status === "error") {
    body = `<div class="inline-error">${escapeHtml(c.error)}</div><div class="up-dialog-actions"><button type="button" class="btn primary" data-up="compare-run">Thử lại</button></div>`;
  } else if (c.data) {
    const data = c.data;
    const ok = data.variants.filter((v) => v.ok);
    const current = data.variants.find((v) => v.key === c.tab) || ok[0];
    const frame = data.frames[c.frame] || data.frames[0];
    const after = frame && current ? frame.after[current.key] : null;
    const realtime = current && current.fps && up.video ? (current.fps / up.video.fps).toFixed(1).replace(".", ",") : "";
    body = `
      <div class="up-compare-tabs" role="tablist" aria-label="Cấu hình so sánh">
        ${data.variants.map((v) => `<button type="button" role="tab" class="up-chip ${v.key === c.tab ? "is-on" : ""} ${v.ok ? "" : "is-blocked"}" aria-selected="${v.key === c.tab}" data-up="compare-tab" data-value="${v.key}" ${v.ok ? "" : 'aria-disabled="true"'}>${escapeHtml(v.label)}</button>`).join("")}
      </div>
      <div class="up-compare-grid">
        <div class="up-compare-main">
          <div class="up-viewer" style="aspect-ratio:${data.width} / ${data.height}">
            ${frame && frame.before ? `<img class="up-viewer-img" src="${escapeAttr(frame.before)}" alt="Khung hình gốc">` : ""}
            ${after ? `<img class="up-viewer-img" data-up-after src="${escapeAttr(after)}" alt="Khung hình sau khi nâng cấp" style="clip-path:inset(0 0 0 ${c.split}%)">` : ""}
            <span class="up-viewer-divider" data-up-divider style="left:${c.split}%"></span>
            <span class="up-viewer-label is-left">TRƯỚC · ${up.video ? up.video.height : ""}P GỐC</span>
            <span class="up-viewer-label is-right">SAU · ${escapeHtml(current ? current.label.toUpperCase() : "")}</span>
          </div>
          <label class="up-split"><span class="muted up-small">Kéo để so sánh</span><input type="range" min="0" max="100" value="${c.split}" data-up-split aria-label="Kéo để so sánh trước và sau"></label>
          <div class="up-frames">
            ${data.frames.map((f, i) => `<button type="button" class="up-frame ${i === c.frame ? "is-on" : ""}" data-up="compare-frame" data-value="${i}" aria-pressed="${i === c.frame}">${f.after[current && current.key] ? `<img src="${escapeAttr(f.after[current.key])}" alt="">` : ""}<span class="mono">${upClock(f.time)}</span></button>`).join("")}
          </div>
        </div>
        <aside class="up-compare-side">
          <h3 class="h2">Kết quả trên máy này</h3>
          <div class="muted up-small">${escapeHtml(current ? current.steps : "")}</div>
          <div class="up-kv"><span>Tốc độ</span><strong>${current ? `${current.fps} khung/giây${realtime ? ` (${realtime}× thời gian thực)` : ""}` : "—"}</strong></div>
          <div class="up-kv"><span>Cả video</span><strong>khoảng ${current ? upDuration(current.wholeSeconds) : "—"}</strong></div>
          <div class="up-kv"><span>File mới</span><strong>khoảng ${current && current.wholeBytes ? formatBytes(current.wholeBytes) : "—"}</strong></div>
          <p class="muted up-small">Khác biệt rõ nhất ở chữ, đường viền và chi tiết nhỏ. Video vốn đã nét thì nâng cấp ít tác dụng.</p>
          <button type="button" class="btn primary" data-up="compare-use" ${current && current.ok ? "" : "disabled"}>Dùng cấu hình này</button>
          <div class="muted up-small">Đoạn thử và ảnh chụp chỉ lưu tạm, tự xoá khi đóng.</div>
        </aside>
      </div>`;
  }
  return `
    <div class="dialog-overlay" role="presentation">
      <section class="dialog up-compare" role="dialog" aria-labelledby="upCompareTitle">
        <div class="dialog-head">
          <div class="dialog-titles">
            <h2 class="h2" id="upCompareTitle">Thử &amp; so sánh</h2>
            <span class="muted up-small">${escapeHtml(up.video ? up.video.name : "")} · chỉ chạy khi bạn bấm</span>
          </div>
          <button type="button" class="btn icon ghost" data-up="compare-close" aria-label="Đóng">${icon("x", { size: 18 })}</button>
        </div>
        <div class="up-compare-controls">
          <span class="up-label">Đoạn thử</span>
          <div class="up-chips">${chips("compare-pos", [["start", "Đầu video"], ["middle", "Giữa video"], ["end", "Cuối video"]], c.position)}</div>
          <div class="up-chips">${chips("compare-len", [[5, "5 giây"], [10, "10 giây"], [20, "20 giây"]], c.seconds)}</div>
        </div>
        ${body}
      </section>
    </div>
  `;
}
