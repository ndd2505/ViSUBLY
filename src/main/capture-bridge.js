'use strict';
// Localhost bridge between the ViSUBLY Chrome extension and the app.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_BODY = 64 * 1024;
const PAIR_TTL_MS = 5 * 60 * 1000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 60 * 1000;
const MAX_TOKENS = 20;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

function isHttpUrl(s) {
  if (typeof s !== 'string' || s.length > 4096) return false;
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

function normalizePayload(p) {
  if (!p || typeof p !== 'object') throw new Error('Payload không hợp lệ');
  if (!isHttpUrl(p.url)) throw new Error('URL không hợp lệ');
  const type = ['hls', 'dash', 'mp4'].includes(p.type) ? p.type : null;
  if (!type) throw new Error('Loại stream không hợp lệ');
  const h = p.headers && typeof p.headers === 'object' ? p.headers : {};
  const headers = {};
  for (const [k, n] of [['referer', 2048], ['origin', 512], ['userAgent', 512], ['cookie', 8192]]) {
    const v = cap(h[k], n);
    if (v) headers[k] = v;
  }
  return {
    url: p.url,
    type,
    headers,
    pageUrl: isHttpUrl(p.pageUrl) ? p.pageUrl : '',
    pageTitle: cap(p.pageTitle, 300),
    detectedAt: Number.isFinite(Number(p.detectedAt)) ? Number(p.detectedAt) : Date.now(),
  };
}

function createCaptureBridge({ port = 47653, dataDir, onCapture, logger = console } = {}) {
  let server = null;
  let actualPort = null;
  let tokens = []; // [{hash, clientName, createdAt}]
  let pairing = null; // {code, expiresAt}
  let fails = [];
  const tokenFile = () => path.join(dataDir, 'capture-tokens.json');

  function loadTokens() {
    try {
      const j = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
      tokens = Array.isArray(j.tokens) ? j.tokens.filter((t) => t && typeof t.hash === 'string') : [];
    } catch { tokens = []; }
  }
  function saveTokens() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(tokenFile(), JSON.stringify({ tokens }, null, 2));
    } catch (e) { logger.warn && logger.warn('[capture-bridge] cannot save tokens:', e.message); }
  }
  const isPaired = (tok) => {
    if (!tok || typeof tok !== 'string') return false;
    const h = sha256(tok);
    return tokens.some((t) => {
      const a = Buffer.from(t.hash), b = Buffer.from(h);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
  };

  function send(res, status, obj, cors) {
    const body = JSON.stringify(obj);
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' };
    if (cors) { headers['Access-Control-Allow-Origin'] = cors; headers['Vary'] = 'Origin'; }
    res.writeHead(status, headers);
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0, over = false; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (over) return;
        if (size > MAX_BODY) { over = true; chunks.length = 0; const e = new Error('too large'); e.status = 413; reject(e); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (over) return;
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch { const e = new Error('bad json'); e.status = 400; reject(e); }
      });
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const origin = req.headers.origin;
    let cors = null;
    if (origin !== undefined) {
      if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return send(res, 403, { ok: false, error: 'forbidden origin' });
      cors = origin;
    }
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { ok: false, error: 'forbidden host' });

    if (req.method === 'OPTIONS') {
      if (!cors) return send(res, 403, { ok: false, error: 'forbidden origin' });
      res.writeHead(204, {
        'Access-Control-Allow-Origin': cors, 'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Visubly-Token',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const token = req.headers['x-visubly-token'];

    if (req.method === 'GET' && url.pathname === '/v1/ping') {
      return send(res, 200, { ok: true, app: 'visubly', version: 1, paired: isPaired(token) }, cors);
    }

    if (req.method === 'POST' && url.pathname === '/v1/pair') {
      const now = Date.now();
      fails = fails.filter((t) => now - t < FAIL_WINDOW_MS);
      if (fails.length >= MAX_FAILS) return send(res, 429, { ok: false, error: 'Thử sai quá nhiều lần, hãy đợi 1 phút' }, cors);
      const body = await readBody(req);
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      const valid = pairing && pairing.expiresAt > now && /^\d{6}$/.test(code) &&
        crypto.timingSafeEqual(Buffer.from(code), Buffer.from(pairing.code));
      if (!valid) {
        fails.push(now);
        return send(res, 401, { ok: false, error: 'Mã không đúng hoặc đã hết hạn' }, cors);
      }
      pairing = null; // single use
      const tok = crypto.randomBytes(32).toString('hex');
      tokens.push({ hash: sha256(tok), clientName: cap(body.clientName, 100) || 'Chrome', createdAt: now });
      if (tokens.length > MAX_TOKENS) tokens = tokens.slice(-MAX_TOKENS);
      saveTokens();
      return send(res, 200, { ok: true, token: tok }, cors);
    }

    if (req.method === 'POST' && url.pathname === '/v1/capture') {
      if (!isPaired(token)) return send(res, 401, { ok: false, error: 'Chưa ghép nối' }, cors);
      const body = await readBody(req);
      let payload;
      try { payload = normalizePayload(body); } catch (e) { return send(res, 400, { ok: false, error: e.message }, cors); }
      try {
        const r = await onCapture(payload);
        const message = r && typeof r.message === 'string' ? r.message : 'Đã gửi tới ViSUBLY';
        return send(res, 202, { ok: true, message }, cors);
      } catch (e) {
        logger.error && logger.error('[capture-bridge] onCapture failed:', e && e.message);
        return send(res, 500, { ok: false, error: 'ViSUBLY không xử lý được yêu cầu' }, cors);
      }
    }

    return send(res, 404, { ok: false, error: 'not found' }, cors);
  }

  function listenOn(p) {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          if (res.headersSent) return res.end();
          send(res, e.status || 500, { ok: false, error: e.status ? e.message : 'internal error' });
        });
      });
      s.once('error', reject);
      s.listen(p, '127.0.0.1', () => { s.removeAllListeners('error'); resolve(s); });
    });
  }

  return {
    async start() {
      if (server) return { port: actualPort };
      loadTokens();
      let lastErr;
      for (let i = 0; i <= 3; i++) {
        try { server = await listenOn(port + i); actualPort = port + i; return { port: actualPort }; }
        catch (e) { lastErr = e; if (e.code !== 'EADDRINUSE') break; }
      }
      throw lastErr;
    },
    async stop() {
      if (!server) return;
      const s = server; server = null; actualPort = null;
      await new Promise((r) => { s.close(() => r()); s.closeAllConnections && s.closeAllConnections(); });
    },
    info() { return { running: !!server, port: actualPort, pairedClients: tokens.length }; },
    createPairingCode() {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      pairing = { code, expiresAt: Date.now() + PAIR_TTL_MS };
      return { code, expiresAt: pairing.expiresAt };
    },
    revokeAll() { tokens = []; pairing = null; saveTokens(); },
  };
}

module.exports = { createCaptureBridge };
