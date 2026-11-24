import { probe, pair, sendCapture, setToken } from './app-client.js';

const MAX_PER_TAB = 30;
const OWN_PORTS = new Set(['47653', '47654', '47655', '47656']);
const MIN_MP4_BYTES = 200 * 1024;
const BADGE_COLOR = '#FF8B6E';
const REQ_TYPES = ['xmlhttprequest', 'media', 'other', 'object', 'sub_frame', 'main_frame'];

// ---------- storage (chrome.storage.session, serialized) ----------
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

// ---------- detection ----------
const NOISE_EXT = /\.(ts|m4s|aac|m4a|mp3|vtt|webvtt|srt|jpg|jpeg|png|gif|webp|css|js|json|key|cmfv|cmfa)$/i;
function classifyUrl(u) {
  let p;
  try { p = new URL(u); } catch { return null; }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
  const path = p.pathname.toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  if (path.endsWith('.mp4')) return 'mp4';
  return null;
}
function classifyContentType(ct) {
  ct = (ct || '').toLowerCase().split(';')[0].trim();
  if (ct === 'application/vnd.apple.mpegurl' || ct === 'application/x-mpegurl' || ct === 'audio/mpegurl' || ct === 'audio/x-mpegurl') return 'hls';
  if (ct === 'application/dash+xml') return 'dash';
  if (ct === 'video/mp4') return 'mp4';
  return null;
}
function dedupeKey(u) {
  try { const p = new URL(u); return p.origin + p.pathname; } catch { return u; }
}
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
function score(s) {
  let sc = s.type === 'mp4' ? 20 : 50;
  const name = (s.url.split('?')[0].split('/').pop() || '').toLowerCase();
  if (/master|index|playlist|manifest/.test(name)) sc += 20;
  if (/(^|[_\-.])(\d{3,4}p?|audio|video|chunk|segment|frag)([_\-.]|$)/.test(name)) sc -= 15;
  if (s.sizeHint) sc += Math.min(10, Math.log10(s.sizeHint));
  return sc;
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

async function addStream(tabId, entry) {
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  const key = dedupeKey(entry.url);
  const count = await withState((tabs) => {
    const list = tabs[tabId] || [];
    const ex = list.find((s) => s.key === key);
    if (ex) {
      Object.assign(ex, { url: entry.url, headers: { ...ex.headers, ...entry.headers }, detectedAt: Date.now() });
      if (entry.sizeHint) ex.sizeHint = entry.sizeHint;
    } else {
      list.push({
        id: Math.random().toString(36).slice(2, 10), key, url: entry.url, type: entry.type, headers: entry.headers,
        pageUrl: (tab && (tab.url || tab.pendingUrl)) || '', pageTitle: (tab && tab.title) || '',
        detectedAt: Date.now(), sizeHint: entry.sizeHint || 0,
      });
    }
    list.sort((a, b) => score(b) - score(a) || b.detectedAt - a.detectedAt);
    tabs[tabId] = list.slice(0, MAX_PER_TAB);
    return tabs[tabId].length;
  });
  updateBadge(tabId, count);
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

// ---------- messaging ----------
const publicStream = (s) => ({ id: s.id, url: s.url, type: s.type, detectedAt: s.detectedAt, sizeHint: s.sizeHint });

async function sendStream(tabId, streamId) {
  const tabs = await load();
  const list = tabs[tabId] || [];
  const s = streamId ? list.find((x) => x.id === streamId) : list[0];
  if (!s) return { ok: false, error: 'Chưa thấy video nào trên trang này' };
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* ignore */ }
  const headers = { ...s.headers };
  if (!headers.userAgent) headers.userAgent = navigator.userAgent;
  const pageUrl = (tab && tab.url) || s.pageUrl;
  if (!headers.referer && pageUrl) headers.referer = pageUrl;
  return sendCapture({
    url: s.url, type: s.type, headers, pageUrl,
    pageTitle: (tab && tab.title) || s.pageTitle || '', detectedAt: s.detectedAt,
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const senderTab = sender.tab && sender.tab.id;
    switch (msg && msg.type) {
      case 'getState': {
        const tabs = await load();
        const st = await probe();
        return { streams: (tabs[msg.tabId] || []).map(publicStream), running: st.running, paired: st.paired };
      }
      case 'count': {
        const tabs = await load();
        return { count: (tabs[senderTab] || []).length };
      }
      case 'send': return sendStream(msg.tabId != null ? msg.tabId : senderTab, msg.streamId);
      case 'pair': return pair(String(msg.code || '').trim());
      case 'unpair': await setToken(''); return { ok: true };
      default: return { ok: false, error: 'unknown message' };
    }
  })().then(sendResponse).catch(() => sendResponse({ ok: false, error: 'Lỗi không xác định' }));
  return true;
});
