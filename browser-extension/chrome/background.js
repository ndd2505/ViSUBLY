import { probe, pair, sendCapture, setToken, probeStream } from './app-client.js';
import {
  MIN_MP4_BYTES, NOISE_EXT, classifyUrl, classifyContentType, upsertStream, markPlaybackStart,
  buildGroups, isShortGroup, needsProbe, rankGroups, pickBestGroup, describeGroups,
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
  };
}
function tabState(tabs, tabId) {
  const t = readTab(tabs, tabId);
  tabs[tabId] = t;
  return t;
}
const normalCount = (t) => buildGroups(t.streams, t.probes).filter((g) => !isShortGroup(g)).length;

// ---------- detection ----------
function isOwn(d) {
  if (d.tabId < 0) return true;
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
      playing: !!t.playback.playing,
    });
    return normalCount(t);
  });
  updateBadge(tabId, count);
  notifyPopup(tabId);
}

chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
  if (isOwn(d)) return;
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

chrome.webRequest.onHeadersReceived.addListener((d) => {
  const saved = reqHeaders.get(d.requestId);
  reqHeaders.delete(d.requestId);
  if (isOwn(d)) return;
  if (d.statusCode && d.statusCode >= 400) return;
  let pathname = '';
  try { pathname = new URL(d.url).pathname; } catch { return; }
  if (NOISE_EXT.test(pathname)) return;
  const type = classifyContentType(getHeader(d.responseHeaders, 'content-type')) || classifyUrl(d.url);
  if (!type) return;
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
  if (info.status === 'loading' && u !== lastUrl.get(tabId)) {
    lastUrl.set(tabId, u);
    withState((tabs) => { delete tabs[tabId]; }).then(() => updateBadge(tabId, 0));
  } else {
    lastUrl.set(tabId, u);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  lastUrl.delete(tabId);
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
  const view = describeGroups(groups, { pageTitle, probing: probingKeys(tabId) });
  let note = '';
  if (view.groups.length + view.short.length) {
    if (!st.running || !st.paired) note = 'Mở và ghép nối ViSUBLY để xem chất lượng và dung lượng.';
    else if (appNote === 'unsupported') note = 'Cập nhật ViSUBLY để xem chất lượng và dung lượng.';
  }
  return { ...view, running: st.running, paired: st.paired, note };
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
      g = pickBestGroup(groups, t.playback);
      const prev = g && t.probes[g.key];
      if (!g || !needsProbe(g) || (prev && !prev.ok && Date.now() - prev.at < PROBE_RETRY_MS)) break;
      const r = await queueProbe(tabId, g.root);
      if (!r || (!r.ok && r.code !== 'failed')) break; // app unreachable: send what we have
      t = readTab(await load(), tabId);
      groups = buildGroups(t.streams, t.probes);
      if (!groups.length) return { ok: false, error: 'Chưa thấy video nào trên trang này' };
    }
    g = pickBestGroup(groups, t.playback);
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
        return { ok: true };
      }
      case 'pair': return pair(String(msg.code || '').trim());
      case 'unpair': await setToken(''); return { ok: true };
      default: return { ok: false, error: 'unknown message' };
    }
  })().then(sendResponse).catch(() => sendResponse({ ok: false, error: 'Lỗi không xác định' }));
  return true;
});
