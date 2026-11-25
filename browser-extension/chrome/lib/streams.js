// Pure stream bookkeeping for the ViSUBLY Grabber: detection helpers, grouping of
// playlists into "one video" groups, preview detection and best-group selection.
// No chrome.* here, so scripts/test-extension-streams.mjs can run it under Node.

export const MAX_STREAMS_PER_TAB = 40;
export const MIN_MP4_BYTES = 200 * 1024;
export const SHORT_MP4_BYTES = 20 * 1024 * 1024; // mp4 without a known duration: smaller = preview
export const PLAY_START_WINDOW_MS = 4000; // players fetch the manifest just before 'play' fires
export const ACTIVE_WINDOW_MS = 12000; // a playlist whose segments were fetched this recently is being played

// ---------- detection ----------
export const NOISE_EXT = /\.(ts|m4s|aac|m4a|mp3|vtt|webvtt|srt|jpg|jpeg|png|gif|webp|css|js|json|key|cmfv|cmfa)$/i;
// Media segments: never listed as videos, but they show which playlist the player is fetching right now.
const SEGMENT_EXT = /\.(ts|m4s|m4v|m4a|aac|cmfv|cmfa)$/i;
const SEGMENT_CT = /^(video\/mp2t|video\/iso\.segment|audio\/aac|audio\/mp4|video\/mp4)$/;

export function isSegmentLike(pathname, contentType = '') {
  if (SEGMENT_EXT.test(pathname || '')) return true;
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  // A bare video/mp4 response is a file unless it has no extension (fMP4 fragments often have none).
  return SEGMENT_CT.test(ct) && (ct !== 'video/mp4' || !/\.[a-z0-9]{2,5}$/i.test(pathname || ''));
}

export function classifyUrl(u) {
  let p;
  try { p = new URL(u); } catch { return null; }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
  const path = p.pathname.toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  if (path.endsWith('.mp4')) return 'mp4';
  return null;
}

export function classifyContentType(ct) {
  ct = (ct || '').toLowerCase().split(';')[0].trim();
  if (ct === 'application/vnd.apple.mpegurl' || ct === 'application/x-mpegurl' || ct === 'audio/mpegurl' || ct === 'audio/x-mpegurl') return 'hls';
  if (ct === 'application/dash+xml') return 'dash';
  if (ct === 'video/mp4') return 'mp4';
  return null;
}

export function streamKey(u) {
  try { const p = new URL(u); return p.origin + p.pathname; } catch { return String(u || ''); }
}

export function scoreStream(s) {
  let sc = s.type === 'mp4' ? 20 : 50;
  const name = (s.url.split('?')[0].split('/').pop() || '').toLowerCase();
  if (/master|index|playlist|manifest/.test(name)) sc += 20;
  if (/(^|[_\-.])(\d{3,4}p?|audio|video|chunk|segment|frag)([_\-.]|$)/.test(name)) sc -= 15;
  if (s.sizeHint) sc += Math.min(10, Math.log10(s.sizeHint));
  return sc;
}

// Adds or refreshes a detected stream (deduped by origin+path). Mutates and returns `list`.
// `ctx`: { now, id, pageUrl, pageTitle, playing, navId } — `playing` = the page's main video is playing;
// `navId` = page session (bumped when the site changes video/URL without reloading).
export function upsertStream(list, entry, ctx = {}) {
  const now = ctx.now || Date.now();
  const key = streamKey(entry.url);
  const ex = list.find((s) => s.key === key);
  if (ex) {
    ex.url = entry.url;
    ex.headers = { ...ex.headers, ...entry.headers };
    ex.detectedAt = now;
    if (entry.sizeHint) ex.sizeHint = entry.sizeHint;
    if (ctx.playing) ex.playingAt = now;
    if (ctx.navId) ex.navId = ctx.navId; // requested again on the current page
    return list;
  }
  const seq = list.reduce((m, s) => Math.max(m, s.seq || 0), 0) + 1;
  list.push({
    id: ctx.id || Math.random().toString(36).slice(2, 10),
    key, url: entry.url, type: entry.type, headers: entry.headers || {},
    pageUrl: ctx.pageUrl || '', pageTitle: ctx.pageTitle || '',
    firstSeenAt: now, detectedAt: now, seq, sizeHint: entry.sizeHint || 0,
    playingAt: ctx.playing ? now : 0, activeAt: 0, navId: ctx.navId || 1,
  });
  while (list.length > MAX_STREAMS_PER_TAB) {
    // Drop the weakest, oldest entry (never the one just added).
    let worst = -1;
    for (let i = 0; i < list.length - 1; i++) {
      if (worst < 0 || scoreStream(list[i]) < scoreStream(list[worst]) ||
        (scoreStream(list[i]) === scoreStream(list[worst]) && list[i].detectedAt < list[worst].detectedAt)) worst = i;
    }
    list.splice(worst, 1);
  }
  return list;
}

// The main video just started playing: its manifest was probably fetched a moment before.
export function markPlaybackStart(list, now = Date.now(), windowMs = PLAY_START_WINDOW_MS) {
  for (const s of list) if (s.detectedAt >= now - windowMs) s.playingAt = Math.max(s.playingAt || 0, s.detectedAt);
  return list;
}

// A media segment was fetched: mark the playlist it belongs to as active (being played).
// Match = same origin and the playlist's folder is the longest prefix of the segment's folder,
// or the same signed query string. Returns the matched stream key, or null.
export function noteSegment(list, segUrl, now = Date.now()) {
  let seg;
  try { seg = new URL(segUrl); } catch { return null; }
  const segDir = seg.pathname.slice(0, seg.pathname.lastIndexOf('/') + 1);
  let best = null;
  let bestLen = -1;
  for (const s of list) {
    if (s.type !== 'hls' && s.type !== 'dash') continue;
    let p;
    try { p = new URL(s.url); } catch { continue; }
    if (p.origin !== seg.origin) continue;
    const dir = p.pathname.slice(0, p.pathname.lastIndexOf('/') + 1);
    let len = segDir.startsWith(dir) ? dir.length : -1;
    if (len < 0 && p.search.length > 8 && p.search === seg.search) len = 0;
    if (len > bestLen || (len === bestLen && best && (s.seq || 0) > (best.seq || 0))) { best = s; bestLen = len; }
  }
  if (!best || bestLen < 0) return null;
  best.activeAt = now;
  return best.key;
}

// ---------- pre-probe rendition heuristic ----------
function splitUrl(u) {
  try {
    const p = new URL(u);
    const path = p.pathname;
    const slash = path.lastIndexOf('/');
    return { origin: p.origin, dir: path.slice(0, slash + 1), file: path.slice(slash + 1), search: p.search };
  } catch { return null; }
}

const WORD_SEGMENT = /^(?:hd|sd|fhd|uhd|hq|lq|video|audio|chunklist.*|stream_?\d+|v\d|a\d)$/;
function isHeightToken(tok) {
  const m = /^(\d{3,4})(p?)$/.exec(tok);
  if (!m) return /^\d{3,5}k$/.test(tok); // bitrate folder/file, e.g. 800k, 2500k
  const n = Number(m[1]);
  if (n < 100 || n > 4320) return false;
  return !(n >= 1900 && n <= 2099 && !m[2]); // a bare year is not a rendition
}
const isIdToken = (tok) => /^\d{5,}$/.test(tok) || (/^[a-z0-9]{6,}$/.test(tok) && /[a-z]/.test(tok) && /\d/.test(tok));
const tokens = (s) => s.toLowerCase().split(/[_\-.]+/).filter(Boolean);

function isRenditionDir(seg) {
  const s = seg.toLowerCase();
  if (WORD_SEGMENT.test(s)) return true;
  const t = tokens(s);
  return t.length <= 3 && t.some(isHeightToken) && !t.some(isIdToken);
}
function isRenditionFile(stem) {
  const s = stem.toLowerCase();
  if (WORD_SEGMENT.test(s) || s.startsWith('chunklist')) return true;
  const t = tokens(s);
  return t.some(isHeightToken) && !t.some(isIdToken);
}

// True when HLS `childUrl` looks like a rendition playlist of the earlier HLS `parentUrl`.
export function isRenditionChild(parentUrl, childUrl) {
  const a = splitUrl(parentUrl), b = splitUrl(childUrl);
  if (!a || !b || a.origin !== b.origin || !b.dir.startsWith(a.dir)) return false;
  if (a.dir + a.file === b.dir + b.file) return false;
  const stem = b.file.replace(/\.m3u8$/i, '');
  if (/master/i.test(stem)) return false; // a master is never a rendition
  const dirs = b.dir.slice(a.dir.length).split('/').filter(Boolean);
  if (dirs.length > 2) return false;
  if (dirs.some((d) => tokens(d).some(isIdToken))) return false; // another video's folder
  const looksLikeRendition = dirs.length ? dirs.every(isRenditionDir) : isRenditionFile(stem);
  if (looksLikeRendition) return true;
  return a.search.length > 1 && a.search === b.search; // same signed query = same session/video
}

// ---------- grouping ----------
// streams: stored stream objects; probes: { [streamKey]: probe result from the app }.
// Returns groups (one per video), each with its root stream, members and probe.
export function buildGroups(streams, probes = {}) {
  const ordered = streams.slice().sort((x, y) => (x.seq || 0) - (y.seq || 0));
  const byKey = new Map(ordered.map((s) => [s.key, s]));
  const probeOf = (s) => (probes[s.key] && probes[s.key].ok ? probes[s.key] : null);

  // Children announced by probed master playlists.
  const childOf = new Map();
  for (const s of ordered) {
    const p = probeOf(s);
    if (!p) continue;
    const urls = [...(p.variants || []).map((v) => v.url), ...(p.renditions || [])];
    for (const u of urls) {
      const k = streamKey(u);
      if (k !== s.key && byKey.has(k) && !childOf.has(k)) childOf.set(k, s.key);
    }
  }

  const groups = [];
  const groupOfKey = new Map();
  for (const s of ordered) {
    const own = probeOf(s);
    let parentKey = own && own.kind === 'master' ? null : childOf.get(s.key) || null;
    if (!parentKey && s.type === 'hls' && !(own && own.kind === 'master')) {
      let best = null;
      for (const g of groups) {
        const r = g.root;
        if (r.type !== 'hls' || probeOf(r)) continue; // probed roots rely on their real variant list
        if (!isRenditionChild(r.url, s.url)) continue;
        const depth = (splitUrl(r.url) || { dir: '' }).dir.length;
        if (!best || depth > best.depth || (depth === best.depth && r.seq > best.root.seq)) best = { root: r, depth };
      }
      if (best) parentKey = best.root.key;
    }
    const parent = parentKey ? groupOfKey.get(parentKey) : null;
    if (parent) {
      parent.members.push(s);
      groupOfKey.set(s.key, parent);
      continue;
    }
    const g = { id: s.id, key: s.key, root: s, members: [s], type: s.type, probe: own };
    groups.push(g);
    groupOfKey.set(s.key, g);
  }

  for (const g of groups) {
    g.firstSeenAt = Math.min(...g.members.map((m) => m.firstSeenAt || m.detectedAt || 0));
    g.lastSeenAt = Math.max(...g.members.map((m) => m.detectedAt || 0));
    g.playingAt = Math.max(...g.members.map((m) => m.playingAt || 0));
    g.activeAt = Math.max(...g.members.map((m) => m.activeAt || 0));
    g.navId = Math.max(...g.members.map((m) => m.navId || 1));
    g.sizeHint = g.root.sizeHint || 0;
    g.score = scoreStream(g.root) + (g.probe && g.probe.durationSec >= 600 ? 10 : 0);
  }
  return groups;
}

export function isShortGroup(g) {
  if (g.probe && g.probe.isShort) return true;
  const knownDuration = g.probe && g.probe.durationSec > 0;
  return g.type === 'mp4' && !knownDuration && g.sizeHint > 0 && g.sizeHint < SHORT_MP4_BYTES;
}

export const needsProbe = (g) => g.type !== 'mp4' && !g.probe;

// Display order: likely main video first.
export function rankGroups(groups) {
  return groups.slice().sort((x, y) =>
    (y.playingAt || 0) - (x.playingAt || 0) || y.score - x.score || y.lastSeenAt - x.lastSeenAt);
}

// The group the page is playing right now, or null when nothing points at one.
// `playback`: { playing, duration, src, at } of the page's largest video (content script).
// Evidence, strongest first: same URL as the <video> src, same duration as the probed playlist,
// segments being fetched right now, manifest fetched just before playback started.
export function findPlayingGroup(groups, playback = {}, now = Date.now()) {
  if (!groups.length) return null;
  const normal = groups.filter((g) => !isShortGroup(g));
  const pool = normal.length ? normal : groups;
  const src = /^https?:/i.test(playback.src || '') ? streamKey(playback.src) : '';
  if (src) {
    const hit = pool.find((g) => g.members.some((m) => m.key === src));
    if (hit) return hit;
  }
  const dur = Number(playback.duration) || 0;
  if (dur > 0 && Number.isFinite(dur)) {
    const close = pool.filter((g) => g.probe && g.probe.durationSec > 0 && !g.probe.isLive &&
      Math.abs(g.probe.durationSec - dur) <= Math.max(2, dur * 0.02));
    if (close.length) return close.sort((x, y) => (y.activeAt || 0) - (x.activeAt || 0) || y.lastSeenAt - x.lastSeenAt)[0];
  }
  const active = pool.filter((g) => g.activeAt && now - g.activeAt <= ACTIVE_WINDOW_MS);
  if (active.length) return active.sort((x, y) => y.activeAt - x.activeAt)[0];
  if (playback.playing || playback.at) {
    const started = pool.filter((g) => g.playingAt).sort((x, y) => y.playingAt - x.playingAt);
    if (started.length) return started[0];
  }
  return null;
}

// Best group for the floating pill: the playing one, else the likely main video.
export function pickBestGroup(groups, playback = {}, now = Date.now()) {
  if (!groups.length) return null;
  const playing = findPlayingGroup(groups, playback, now);
  if (playing) return playing;
  const normal = groups.filter((g) => !isShortGroup(g));
  return rankGroups(normal.length ? normal : groups)[0];
}

// ---------- presentation ----------
export function formatDuration(sec) {
  const total = Math.floor(Number(sec) || 0);
  if (total <= 0) return '';
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatApproxSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `~${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  const mb = n / 1024 ** 2;
  return `~${mb >= 10 ? Math.round(mb) : Math.max(0.1, mb).toFixed(1)} MB`;
}

export function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }

// "abc123/index.m3u8" rather than a bare, meaningless "index.m3u8".
export function fileHint(u) {
  try {
    const parts = new URL(u).pathname.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    let n = parts[parts.length - 1] || '';
    if (/^(index|master|playlist|manifest|main|video|stream|chunklist[^.]*)\.(m3u8|mpd|mp4)$/i.test(n) && parts.length > 1) {
      n = `${parts[parts.length - 2]}/${n}`;
    }
    if (n.length > 38) n = n.slice(0, 20) + '…' + n.slice(-15);
    return n || 'video';
  } catch { return 'video'; }
}

export function qualityLabel(v) {
  if (v.height) return `${v.height}p`;
  const m = /x(\d+)$/.exec(v.resolution || '');
  return m ? `${m[1]}p` : (v.resolution && v.resolution !== 'unknown' ? v.resolution : 'Gốc');
}

// View models for the popup: { groups, short, previous } with labels precomputed.
// `playingId` / `playState` ('playing' | 'paused'): the group on screen (findPlayingGroup) and its state.
// `navId`: current page session; groups only seen on an earlier session go to `previous`.
export function describeGroups(groups, { pageTitle = '', probing = new Set(), playingId = '', playState = 'playing', navId = 0 } = {}) {
  const current = navId ? groups.filter((g) => (g.navId || 1) >= navId) : groups;
  const older = navId ? groups.filter((g) => (g.navId || 1) < navId) : [];
  const ranked = rankGroups(current);
  const normalRanked = ranked.filter((g) => !isShortGroup(g) || g.id === playingId);
  const playingFirst = (list) => list.slice().sort((x, y) => (y.id === playingId) - (x.id === playingId));
  const normal = playingFirst(normalRanked);
  const short = ranked.filter((g) => isShortGroup(g) && g.id !== playingId);
  const previous = rankGroups(older).filter((g) => !isShortGroup(g));
  const vm = (g, i, list, kind) => {
    const isShort = kind === 'short';
    const p = g.probe;
    const variants = (p && p.variants ? p.variants.slice() : [])
      .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0))
      .map((v) => ({ url: v.url, height: v.height || 0, label: qualityLabel(v), size: formatApproxSize(v.estBytes) }));
    const title = isShort ? `Video ngắn ${i + 1}`
      : kind === 'previous' ? `Video trước đó ${i + 1}`
        : list.length === 1 ? (pageTitle || hostOf(g.root.pageUrl) || fileHint(g.root.url)) : `Video ${i + 1}`;
    return {
      id: g.id,
      title,
      playing: g.id === playingId ? (playState === 'paused' ? 'paused' : 'playing') : '',
      hint: list.length > 1 || kind !== 'normal' ? fileHint(g.root.url) : '',
      host: hostOf(g.root.url),
      type: g.type,
      duration: p && !p.isLive ? formatDuration(p.durationSec) : '',
      isLive: !!(p && p.isLive),
      size: g.type === 'mp4' && g.sizeHint ? formatApproxSize(g.sizeHint).replace('~', '') : '',
      probing: probing.has(g.key),
      probed: !!p,
      variants,
    };
  };
  return {
    groups: normal.map((g, i) => vm(g, i, normal, 'normal')),
    short: short.map((g, i) => vm(g, i, short, 'short')),
    previous: previous.map((g, i) => vm(g, i, previous, 'previous')),
  };
}
