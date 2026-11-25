// Runs in the page's own JS world ("world": "MAIN", document_start, all frames). Read-only:
// - recognises HLS / DASH playlists by their CONTENT (#EXTM3U, <MPD) when the URL or content type
//   hides them (no .m3u8 extension, text/plain, even fake .png/.jpg names);
// - notices DRM (EME) and MediaSource use, for the popup's diagnosis.
// Results go to content.js with window.postMessage; requests and responses are never changed.
(() => {
  if (window.__visublySniffer) return;
  try { Object.defineProperty(window, '__visublySniffer', { value: true }); } catch { return; }

  // content.js starts later (document_idle): keep recent messages and replay them when it says "ready".
  const queue = [];
  const post = (data) => {
    const m = Object.assign({ __visubly: 'sniff' }, data);
    queue.push(m);
    if (queue.length > 50) queue.shift();
    try { window.postMessage(m, '*'); } catch { /* ignore */ }
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__visubly !== 'ready') return;
    for (const m of queue) { try { window.postMessage(m, '*'); } catch { /* ignore */ } }
  });
  const seen = new Set();
  const OBVIOUS = /\.(m3u8|mpd)(?:[?#]|$)/i; // webRequest already catches these
  const MAX_BYTES = 512 * 1024;
  const decoder = new TextDecoder();

  function inspect(url, head) {
    if (!head || seen.has(url)) return;
    const text = head.replace(/^﻿/, '').trimStart();
    const kind = text.startsWith('#EXTM3U') ? 'hls' : /<MPD[\s>]/.test(text.slice(0, 2048)) ? 'dash' : '';
    if (!kind) return;
    seen.add(url);
    if (seen.size > 500) seen.clear();
    post({ type: 'sniffed', url, kind });
  }

  function worthChecking(url, contentType, length) {
    if (!/^https?:/i.test(url || '') || OBVIOUS.test(url)) return false;
    const ct = String(contentType || '').toLowerCase();
    if (/^(video|audio)\//.test(ct)) return false; // segments, files
    return !(length > MAX_BYTES);
  }

  // fetch(): peek at the first chunk of a clone, then cancel it.
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    const wrapped = function fetch() {
      const p = origFetch.apply(this, arguments);
      p.then((res) => {
        try {
          if (!res || res.type === 'opaque' || !res.body) return;
          const len = Number(res.headers.get('content-length')) || 0;
          if (!worthChecking(res.url, res.headers.get('content-type'), len)) return;
          const reader = res.clone().body.getReader();
          reader.read().then(({ value }) => {
            if (value) inspect(res.url, decoder.decode(value.slice(0, 2048)));
            reader.cancel().catch(() => {});
          }).catch(() => {});
        } catch { /* never break the page */ }
      }, () => {});
      return p;
    };
    try { wrapped.toString = () => origFetch.toString(); } catch { /* ignore */ }
    window.fetch = wrapped;
  }

  // XMLHttpRequest (hls.js / dash.js / video.js load playlists this way).
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const origOpen = XHR.open;
    const origSend = XHR.send;
    XHR.open = function open(method, url) {
      try { this.__visublyUrl = String(url); } catch { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    XHR.send = function send() {
      try {
        this.addEventListener('load', () => {
          try {
            const url = this.responseURL || this.__visublyUrl || '';
            const len = Number(this.getResponseHeader('content-length')) || 0;
            if (!worthChecking(url, this.getResponseHeader('content-type'), len)) return;
            const rt = this.responseType;
            if (rt === '' || rt === 'text') inspect(url, String(this.responseText || '').slice(0, 2048));
            else if (rt === 'arraybuffer' && this.response) inspect(url, decoder.decode(new Uint8Array(this.response, 0, Math.min(2048, this.response.byteLength))));
          } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }

  // DRM: the page asks for a key system (Widevine, PlayReady...).
  const nav = window.navigator;
  if (nav && typeof nav.requestMediaKeySystemAccess === 'function') {
    const origRequest = nav.requestMediaKeySystemAccess.bind(nav);
    try {
      nav.requestMediaKeySystemAccess = function requestMediaKeySystemAccess(keySystem) {
        const p = origRequest.apply(null, arguments);
        p.then(() => post({ type: 'drm', keySystem: String(keySystem || '') }), () => {});
        return p;
      };
    } catch { /* ignore */ }
  }

  // MediaSource: the player builds the stream itself (shown in the diagnosis).
  const MS = window.MediaSource && window.MediaSource.prototype;
  if (MS && typeof MS.addSourceBuffer === 'function') {
    const origAdd = MS.addSourceBuffer;
    let told = false;
    MS.addSourceBuffer = function addSourceBuffer(mime) {
      if (!told) { told = true; post({ type: 'mse', mime: String(mime || '') }); }
      return origAdd.apply(this, arguments);
    };
  }
})();
