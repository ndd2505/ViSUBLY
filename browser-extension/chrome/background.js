import { probe, pair, sendCapture, setToken, probeStream } from './app-client.js';
import {
  MIN_MP4_BYTES, NOISE_EXT, classifyUrl, classifyContentType, upsertStream, markPlaybackStart,
  buildGroups, isShortGroup, needsProbe, rankGroups, pickBestGroup, describeGroups,
  isSegmentLike, noteSegment, findPlayingGroup,
} from './lib/streams.js';

const OWN_PORTS = new Set(['47653', '47654', '47655', '47656']);
const BADGE_COLOR = '#FF8B6E';
const REQ_TYPES = ['xmlhttprequest', 'media', 'other', 'object', 'sub_frame', 'main_frame'];
const POPUP_PROBE_LIMIT = 8;
const PILL_PROBE_ROUNDS = 3;
const PROBE_CONCURRENCY = 2;
const PROBE_SPACING_MS = 350; // stays under the app's 3 probes/second limit
const PROBE_RETRY_MS = 60000; // a playlist the app could not read is retried after this

// ---------- storage (chrome.storage.session, serialized) ----------
// tabs[tabId] = { streams: [...], probes: { [streamKey]: probe result }, playback: {...} }
let cache = null;
let chain = Promise.resolve();
async function load() {
  if (cache) return cache;
  try { cache = (await chrome.storage.session.get('tabs')).tabs || {}; } catch { cache = {}; }
  return cache;
}
function withState(fn) {
  const run = chain.then(async () => {
    const tabs = await load();
    const r = await fn(tabs);
    try { await chrome.storage.session.set({ tabs }); } catch { /* ignore */ }
    return r;
  });
  chain = run.catch(() => {});
  return run;
}
function readTab(tabs, tabId) {
  let t = tabs[tabId];
  if (Array.isArray(t)) t = { streams: t }; // 1.0.x layout
  t = t && typeof t === 'object' ? t : {};
  return {
    streams: Array.isArray(t.streams) ? t.streams : [],
    probes: t.probes && typeof t.probes === 'object' ? t.probes : {},
    playback: t.playback || { playing: false },
    navId: Number(t.navId) || 1, // page session: bumped when the site changes URL without reloading
  };
}
function tabState(tabs, tabId) {
  const t = readTab(tabs, tabId);
  tabs[tabId] = t;
  return t;
}
// Groups of the current page session (older ones only show under "Đã thấy trước đó").
const currentGroups = (groups, t) => { const c = groups.filter((g) => (g.navId || 1) >= t.navId); return c.length ? c : groups; };
const normalCount = (t) => buildGroups(t.streams, t.probes).filter((g) => !isShortGroup(g) && (g.navId || 1) >= t.navId).length;

// ---------- detection ----------
function isOwn(d) {
  if ((d.initiator || '').startsWith('chrome-extension://')) return true;
  try {
    const p = new URL(d.url);
    if (p.protocol === 'chrome-extension:') return true;
    if ((p.hostname === '127.0.0.1' || p.hostname === 'localhost') && OWN_PORTS.has(p.port)) return true;
  } catch { return true; }
  return false;
}
function getHeader(list, name) {
  const h = (list || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : undefined;
}

// Requests made by a page's service worker carry tabId -1. Attribute them to the tab showing that
// origin (the active one if several), instead of dropping them: some players fetch media that way.
let activeTabId = -1;
chrome.tabs.onActivated?.addListener?.((info) => { activeTabId = info.tabId; });
const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
function tabFor(d) {
  if (d.tabId >= 0) return d.tabId;
  const origin = /^https?:/i.test(d.initiator || '') ? d.initiator : '';
  if (!origin) return -1;
  const matches = [...lastUrl.entries()].filter(([, u]) => originOf(u) === origin).map(([id]) => id);
  if (!matches.length) return -1;
  noteDiag(matches.includes(activeTabId) ? activeTabId : matches[matches.length - 1], (g) => { g.workerRequests += 1; });
  return matches.includes(activeTabId) ? activeTabId : matches[matches.length - 1];
}

// ---------- diagnostics (popup "Không thấy video? Chẩn đoán"), kept in memory only ----------
const diag = new Map(); // tabId -> counters
function noteDiag(tabId, fn) {
  if (tabId < 0) return;
  let g = diag.get(tabId);
  if (!g) { g = { workerRequests: 0, mediaRequests: 0, segments: 0, sniffed: 0, unknown: [], mse: '', drm: '', frames: 0 }; diag.set(tabId, g); }
  fn(g);
}

const reqHeaders = new Map(); // requestId -> {headers, t}
function pruneReqHeaders() {
  if (reqHeaders.size < 200) return;
  const cut = Date.now() - 60000;
  for (const [k, v] of reqHeaders) if (v.t < cut) reqHeaders.delete(k);
}

function updateBadge(tabId, count) {
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
  chrome.tabs.sendMessage(tabId, { type: 'count', count }).catch(() => {});
}
function notifyPopup(tabId) {
  chrome.runtime.sendMessage({ type: 'tabState', tabId }).catch(() => {}); // no popup open: ignore
}

async function addStream(tabId, entry) {
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  const count = await withState((tabs) => {
    const t = tabState(tabs, tabId);
    upsertStream(t.streams, entry, {
      pageUrl: (tab && (tab.url || tab.pendingUrl)) || '', pageTitle: (tab && tab.title) || '',
      playing: !!t.playback.playing, navId: t.navId,
    });
    return normalCount(t);
  });
  updateBadge(tabId, count);
  notifyPopup(tabId);
}

chrome.webRequest.onBeforeSendHeaders.addListener((raw) => {
  if (isOwn(raw)) return;
  const tabId = tabFor(raw);
  if (tabId < 0) return;
  const d = { ...raw, tabId };
  const range = getHeader(d.requestHeaders, 'range');
  if (range && !/^bytes=0-/i.test(range.trim())) return; // byte-range follow-up
  const h = {
    referer: getHeader(d.requestHeaders, 'referer'), origin: getHeader(d.requestHeaders, 'origin'),
    userAgent: getHeader(d.requestHeaders, 'user-agent'), cookie: getHeader(d.requestHeaders, 'cookie'),
  };
  for (const k of Object.keys(h)) if (!h[k]) delete h[k];
  const type = classifyUrl(d.url);
  // Playlists are added immediately; everything else (incl. mp4, needing size) waits for response headers.
  if (type === 'hls' || type === 'dash') { addStream(d.tabId, { url: d.url, type, headers: h }); return; }
  pruneReqHeaders();
  reqHeaders.set(d.requestId, { headers: h, t: Date.now() });
}, { urls: ['<all_urls>'], types: REQ_TYPES }, ['requestHeaders', 'extraHeaders']);

// A reload or a new page load (main_frame request) starts a fresh list, even for the same URL:
// otherwise the previous load's videos pile up next to the new ones.
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0 || d.frameId !== 0) return;
  pendingSegments.delete(d.tabId);
  diag.delete(d.tabId);
  withState((tabs) => { delete tabs[d.tabId]; }).then(() => { updateBadge(d.tabId, 0); notifyPopup(d.tabId); });
}, { urls: ['<all_urls>'], types: ['main_frame'] });

// Segment requests show which playlist is being played. They are frequent, so they are batched
// (last segment URL per folder) and written at most every few seconds.
const pendingSegments = new Map(); // tabId -> Map(folder -> url)
let segmentFlushTimer = 0;
function queueSegment(tabId, url) {
  let byDir = pendingSegments.get(tabId);
  if (!byDir) { byDir = new Map(); pendingSegments.set(tabId, byDir); }
  byDir.set(url.slice(0, url.lastIndexOf('/') + 1), url);
  if (!segmentFlushTimer) segmentFlushTimer = setTimeout(flushSegments, 2500);
}
function flushSegments() {
  segmentFlushTimer = 0;
  const batch = [...pendingSegments.entries()];
  pendingSegments.clear();
  for (const [tabId, byDir] of batch) {
    withState((tabs) => {
      if (!tabs[tabId]) return false;
      const t = tabState(tabs, tabId);
      let hit = false;
      for (const url of byDir.values()) hit = Boolean(noteSegment(t.streams, url)) || hit;
      return hit;
    }).then((hit) => { if (hit) notifyPopup(tabId); });
  }
}

chrome.webRequest.onHeadersReceived.addListener((raw) => {
  const saved = reqHeaders.get(raw.requestId);
  reqHeaders.delete(raw.requestId);
  if (isOwn(raw)) return;
  const tabId = tabFor(raw);
  if (tabId < 0) return;
  const d = { ...raw, tabId };
  if (d.statusCode && d.statusCode >= 400) return;
  let pathname = '';
  try { pathname = new URL(d.url).pathname; } catch { return; }
  const contentType = getHeader(d.responseHeaders, 'content-type');
  if (isSegmentLike(pathname, contentType)) { noteDiag(tabId, (g) => { g.segments += 1; }); queueSegment(d.tabId, d.url); return; }
  if (NOISE_EXT.test(pathname)) return;
  const type = classifyContentType(contentType) || classifyUrl(d.url);
  if (!type) {
    // Media-looking responses we could not classify: listed (host + type only) in the diagnostics.
    const ct = String(contentType || '').toLowerCase().split(';')[0];
    if (/^(video|audio)\/|octet-stream|mpegurl|dash/.test(ct) || d.type === 'media') {
      noteDiag(tabId, (g) => {
        const item = `${originOf(d.url).replace(/^https?:\/\//, '')} · ${ct || 'không rõ loại'} · ${(pathname.match(/\.[a-z0-9]{1,5}$/i) || ['không đuôi'])[0]}`;
        if (!g.unknown.includes(item)) g.unknown = [...g.unknown, item].slice(-12);
      });
    }
    return;
  }
  noteDiag(tabId, (g) => { g.mediaRequests += 1; });
  let size = parseInt(getHeader(d.responseHeaders, 'content-length') || '0', 10) || 0;
  const cr = getHeader(d.responseHeaders, 'content-range');
  if (cr) { const m = /\/(\d+)$/.exec(cr); size = m ? parseInt(m[1], 10) : 0; }
  if (type === 'mp4' && size && size < MIN_MP4_BYTES) return;
  addStream(d.tabId, { url: d.url, type, headers: saved ? saved.headers : {}, sizeHint: type === 'mp4' ? size : 0 });
}, { urls: ['<all_urls>'], types: REQ_TYPES }, ['responseHeaders']);

// ---------- tab lifecycle ----------
const lastUrl = new Map();
const stripHash = (u) => (u || '').split('#')[0];
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  const u = stripHash(info.url);
  const before = lastUrl.get(tabId);
  lastUrl.set(tabId, u);
  if (info.status === 'loading' && u !== before) {
    withState((tabs) => { delete tabs[tabId]; }).then(() => updateBadge(tabId, 0));
  } else if (before && u !== before) {
    // Same document, new URL (single-page site switched video): keep the list, but what was seen
    // before now belongs to the previous page ("Đã thấy trước đó" in the popup).
    withState((tabs) => {
      if (!tabs[tabId]) return;
      const t = tabState(tabs, tabId);
      t.navId += 1;
      t.playback = { playing: false };
    }).then(() => notifyPopup(tabId));
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  lastUrl.delete(tabId);
  diag.delete(tabId);
  withState((tabs) => { delete tabs[tabId]; });
});

// ---------- probing (the app reads playlists; the extension cannot see response bodies) ----------
const probing = new Map(); // `${tabId}|${streamKey}` -> Promise<result>
const probeQueue = [];
let probeActive = 0;
let lastProbeStart = 0;
let pumpTimer = 0;
let appNote = ''; // why quality info is missing: 'not-running' | 'not-paired' | 'unsupported'

function requestHeaders(s, tab) {
  const headers = { ...s.headers };
  if (!headers.userAgent) headers.userAgent = navigator.userAgent;
  const pageUrl = (tab && tab.url) || s.pageUrl;
  if (!headers.referer && pageUrl) headers.referer = pageUrl;
  return headers;
}

function queueProbe(tabId, stream) {
  const id = `${tabId}|${stream.key}`;
  if (probing.has(id)) return probing.get(id);
  const p = new Promise((resolve) => { probeQueue.push({ tabId, stream, resolve }); });
  probing.set(id, p);
  p.finally(() => probing.delete(id));
  pumpProbes();
  return p;
}

function pumpProbes() {
  while (probeActive < PROBE_CONCURRENCY && probeQueue.length) {
    const wait = lastProbeStart + PROBE_SPACING_MS - Date.now();
    if (wait > 0) {
      if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = 0; pumpProbes(); }, wait);
      return;
    }
    const job = probeQueue.shift();
    probeActive += 1;
    lastProbeStart = Date.now();
    runProbeJob(job).catch(() => job.resolve({ ok: false, code: 'failed' })).finally(() => { probeActive -= 1; pumpProbes(); });
  }
}

async function runProbeJob({ tabId, stream, resolve }) {
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { resolve({ ok: false, code: 'gone' }); return; }
  const payload = { url: stream.url, type: stream.type, headers: requestHeaders(stream, tab) };
  let r = await probeStream(payload);
  for (let i = 0; i < 2 && r.code === 'rate-limited'; i++) {
    await new Promise((ok) => setTimeout(ok, 1100));
    r = await probeStream(payload);
  }
  if (r.ok) appNote = '';
  else if (['not-running', 'not-paired', 'unsupported'].includes(r.code)) appNote = r.code;
  if (r.ok || r.code === 'failed') {
    const stored = r.ok
      ? {
        ok: true, kind: r.kind || '', durationSec: Number(r.durationSec) || 0, isLive: !!r.isLive, isShort: !!r.isShort,
        renditions: Array.isArray(r.renditions) ? r.renditions.slice(0, 20) : [],
        variants: (Array.isArray(r.variants) ? r.variants : []).slice(0, 12).map((v) => ({
          url: String(v.url || ''), height: Number(v.height) || 0, resolution: String(v.resolution || ''),
          bandwidth: Number(v.bandwidth) || 0, estBytes: Number(v.estBytes) || 0,
        })),
        at: Date.now(),
      }
      : { ok: false, code: 'failed', at: Date.now() };
    const count = await withState((tabs) => {
      if (!tabs[tabId]) return null; // tab navigated away meanwhile
      const t = tabState(tabs, tabId);
      if (!t.streams.some((s) => s.key === stream.key)) return null;
      t.probes[stream.key] = stored;
      return normalCount(t);
    });
    if (count !== null) updateBadge(tabId, count);
  }
  notifyPopup(tabId);
  resolve(r);
}

function probingKeys(tabId) {
  const prefix = `${tabId}|`;
  return new Set([...probing.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
}

function ensureProbes(tabId, t, groups, limit) {
  let n = 0;
  for (const g of rankGroups(groups)) {
    if (n >= limit) break;
    if (!needsProbe(g)) continue;
    const prev = t.probes[g.key];
    if (prev && !prev.ok && Date.now() - prev.at < PROBE_RETRY_MS) continue;
    n += 1;
    queueProbe(tabId, g.root);
  }
}

// ---------- "Dò video ẩn" switch: sniff.js (page world) is registered at runtime ----------
// On by default. Turning it off unregisters the script, so pages that misbehave with it load
// without any of our code in their JS world (takes effect on the next page load).
const SNIFF_ID = 'visubly-sniff';
const SNIFF_KEY = 'sniffEnabled';
let sniffChain = Promise.resolve();

async function sniffEnabled() {
  try { return (await chrome.storage.local.get(SNIFF_KEY))[SNIFF_KEY] !== false; } catch { return true; }
}

async function applySniff() {
  const api = chrome.scripting;
  if (!api || !api.registerContentScripts) return;
  const want = await sniffEnabled();
  try {
    const have = (await api.getRegisteredContentScripts({ ids: [SNIFF_ID] })).length > 0;
    if (want && !have) {
      await api.registerContentScripts([{
        id: SNIFF_ID, js: ['sniff.js'], matches: ['<all_urls>'], runAt: 'document_start',
        allFrames: true, world: 'MAIN', persistAcrossSessions: true,
      }]);
    } else if (!want && have) {
      await api.unregisterContentScripts({ ids: [SNIFF_ID] });
    }
  } catch { /* a page that can't take scripts must not break the rest */ }
}
const syncSniff = () => (sniffChain = sniffChain.then(applySniff, applySniff));
syncSniff();

// ---------- diagnosis: why no video shows (popup button) ----------
async function diagnose(tabId) {
  const tabs = await load();
  const t = readTab(tabs, tabId);
  const g = diag.get(tabId) || { workerRequests: 0, mediaRequests: 0, segments: 0, sniffed: 0, unknown: [], mse: '', drm: '' };
  const groups = buildGroups(t.streams, t.probes);
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* ignore */ }
  const reasons = [];
  const v = g.video;
  const sniffOn = await sniffEnabled();
  if (g.drm) reasons.push(`Trang dùng DRM (${g.drm}): video được mã hoá bản quyền, ViSUBLY không tải được.`);
  if (!v) reasons.push('Chưa thấy thẻ video nào đang phát. Hãy bấm phát video rồi mở lại phần này. Nếu video nằm trong một khung (iframe) bị chặn, tiện ích có thể không nhìn thấy nó.');
  else if (v.inFrame) reasons.push('Video nằm trong một khung (iframe) của trang khác. Tiện ích vẫn theo dõi khung đó.');
  if (v && v.srcKind === 'blob' && !groups.length && !g.segments) reasons.push('Trình phát dựng video từ dữ liệu tải về theo cách riêng, có thể qua WebSocket hoặc P2P, nên không lộ đường dẫn tải được.');
  if (g.segments && !groups.length) reasons.push(`Thấy ${g.segments} đoạn video được tải nhưng không thấy danh sách phát. Trang có thể giấu danh sách phát; hãy tải lại trang rồi phát lại để tiện ích bắt từ đầu.`);
  if (g.unknown.length) reasons.push('Có tệp giống video nhưng ở định dạng lạ. Xem danh sách bên dưới.');
  if (!sniffOn && !groups.length) reasons.push('"Dò video ẩn" đang tắt nên tiện ích không nhận ra danh sách phát bị đổi tên và không báo được DRM. Bật lại ở cuối popup rồi tải lại trang nếu cần.');
  if (!reasons.length && groups.length) reasons.push('Tiện ích đã thấy video trên trang này.');
  if (!reasons.length) reasons.push('Không thấy yêu cầu tải video nào. Hãy tải lại trang và phát lại video.');
  const report = [
    `ViSUBLY Grabber ${chrome.runtime.getManifest ? chrome.runtime.getManifest().version : ''}`,
    `Trang: ${originOf((tab && tab.url) || '')}`,
    `Video trên trang: ${v ? `${v.playing ? 'đang phát' : 'đang dừng'}, nguồn ${v.srcKind || 'không rõ'}${v.inFrame ? ', trong iframe' : ''}` : 'chưa thấy'}`,
    `MSE: ${g.mse || 'không'} · DRM: ${g.drm || 'không'} · Dò video ẩn: ${sniffOn ? 'bật' : 'tắt'}`,
    `Danh sách phát: ${groups.length} (nhận qua nội dung: ${g.sniffed}) · Đoạn video: ${g.segments} · Yêu cầu từ service worker: ${g.workerRequests}`,
    ...g.unknown.map((u) => `Định dạng lạ: ${u}`),
  ].join('\n');
  return { ok: true, reasons, unknown: g.unknown, report };
}

// ---------- messaging ----------
async function getState(tabId) {
  const tabs = await load();
  const t = readTab(tabs, tabId);
  const st = await probe();
  const groups = buildGroups(t.streams, t.probes);
  if (st.running && st.paired) ensureProbes(tabId, t, groups, POPUP_PROBE_LIMIT);
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* ignore */ }
  const pageTitle = (tab && tab.title) || (t.streams[0] && t.streams[0].pageTitle) || '';
  const current = groups.filter((g) => (g.navId || 1) >= t.navId);
  const playing = findPlayingGroup(current, t.playback);
  const playState = t.playback.playing ? 'playing' : 'paused';
  const view = describeGroups(groups, { pageTitle, probing: probingKeys(tabId), playingId: playing ? playing.id : '', playState, navId: t.navId });
  let note = '';
  if (view.groups.length + view.short.length) {
    if (!st.running || !st.paired) note = 'Mở và ghép nối ViSUBLY để xem chất lượng và dung lượng.';
    else if (appNote === 'unsupported') note = 'Cập nhật ViSUBLY để xem chất lượng và dung lượng.';
  }
  const d = diag.get(tabId);
  return { ...view, running: st.running, paired: st.paired, note, drm: d ? d.drm : '', sniff: await sniffEnabled() };
}

async function sendGroup(tabId, opts = {}) {
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* ignore */ }
  let t = readTab(await load(), tabId);
  let groups = buildGroups(t.streams, t.probes);
  if (!groups.length) return { ok: false, error: 'Chưa thấy video nào trên trang này' };
  let g = null;
  if (opts.groupId) {
    g = groups.find((x) => x.id === opts.groupId) || groups.find((x) => x.members.some((m) => m.id === opts.groupId));
    if (!g) return { ok: false, error: 'Video này không còn trên trang, hãy mở lại popup' };
  } else {
    // Floating pill: read the front-runner first so a preview or a rendition is not sent by mistake.
    for (let i = 0; i < PILL_PROBE_ROUNDS; i++) {
      g = pickBestGroup(currentGroups(groups, t), t.playback);
      const prev = g && t.probes[g.key];
      if (!g || !needsProbe(g) || (prev && !prev.ok && Date.now() - prev.at < PROBE_RETRY_MS)) break;
      const r = await queueProbe(tabId, g.root);
      if (!r || (!r.ok && r.code !== 'failed')) break; // app unreachable: send what we have
      t = readTab(await load(), tabId);
      groups = buildGroups(t.streams, t.probes);
      if (!groups.length) return { ok: false, error: 'Chưa thấy video nào trên trang này' };
    }
    g = pickBestGroup(currentGroups(groups, t), t.playback);
  }
  const s = g.root;
  const pageUrl = (tab && tab.url) || s.pageUrl;
  const payload = {
    url: s.url, type: s.type, headers: requestHeaders(s, tab), pageUrl,
    pageTitle: (tab && tab.title) || s.pageTitle || '', detectedAt: s.detectedAt,
  };
  if (opts.variantUrl) payload.preferredVariantUrl = String(opts.variantUrl);
  if (opts.height) payload.preferredHeight = Math.round(Number(opts.height)) || 0;
  return sendCapture(payload);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const senderTab = sender.tab && sender.tab.id;
    switch (msg && msg.type) {
      case 'getState': return getState(msg.tabId);
      case 'count': return { count: normalCount(readTab(await load(), senderTab)) };
      case 'send':
        return sendGroup(msg.tabId != null ? msg.tabId : senderTab, { groupId: msg.groupId, variantUrl: msg.variantUrl, height: msg.height });
      case 'playback': {
        if (senderTab == null) return { ok: false };
        await withState((tabs) => {
          const t = tabState(tabs, senderTab);
          const now = Date.now();
          const playing = !!msg.playing;
          if (playing && !t.playback.playing) markPlaybackStart(t.streams, now);
          t.playback = {
            playing, at: now,
            duration: Number.isFinite(Number(msg.duration)) ? Number(msg.duration) : 0,
            src: typeof msg.src === 'string' ? msg.src.slice(0, 2048) : '',
          };
        });
        noteDiag(senderTab, (g) => { g.video = { playing: !!msg.playing, srcKind: String(msg.srcKind || ''), inFrame: (sender.frameId || 0) > 0 }; });
        return { ok: true };
      }
      // From sniff.js (page world) via content.js: a playlist recognised by its content, DRM, MSE.
      case 'sniffed': {
        if (senderTab == null || !['hls', 'dash'].includes(msg.kind) || !/^https?:/i.test(String(msg.url || ''))) return { ok: false };
        noteDiag(senderTab, (g) => { g.sniffed += 1; });
        await addStream(senderTab, { url: String(msg.url).slice(0, 4096), type: msg.kind, headers: {} });
        return { ok: true };
      }
      case 'drm':
        if (senderTab != null) { noteDiag(senderTab, (g) => { g.drm = String(msg.keySystem || 'DRM').slice(0, 80); }); notifyPopup(senderTab); }
        return { ok: true };
      case 'mse':
        if (senderTab != null) noteDiag(senderTab, (g) => { g.mse = String(msg.mime || 'MSE').slice(0, 120); });
        return { ok: true };
      case 'diag':
        return diagnose(msg.tabId);
      case 'setSniff':
        await chrome.storage.local.set({ [SNIFF_KEY]: !!msg.enabled });
        await syncSniff();
        return { ok: true, sniff: await sniffEnabled() };
      case 'pair': return pair(String(msg.code || '').trim());
      case 'unpair': await setToken(''); return { ok: true };
      default: return { ok: false, error: 'unknown message' };
    }
  })().then(sendResponse).catch(() => sendResponse({ ok: false, error: 'Lỗi không xác định' }));
  return true;
});
