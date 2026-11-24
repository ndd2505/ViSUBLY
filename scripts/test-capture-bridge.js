'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { createCaptureBridge } = require('../src/main/capture-bridge');

const EXT = 'chrome-extension://' + 'a'.repeat(32);
function req(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let t = ''; res.on('data', (c) => (t += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, headers: res.headers }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visubly-bridge-'));
  const captures = [];
  const quiet = { log() {}, warn() {}, error() {} };
  const bridge = createCaptureBridge({ port: 48653, dataDir: dir, onCapture: async (p) => { captures.push(p); }, logger: quiet });
  const { port } = await bridge.start();
  const ok = (n) => console.log('ok -', n);
  try {
    let r = await req(port, 'GET', '/v1/ping', { headers: { Origin: EXT } });
    assert.equal(r.status, 200); assert.equal(r.json.app, 'visubly'); assert.equal(r.json.paired, false); ok('ping unpaired');

    const { code } = bridge.createPairingCode();
    r = await req(port, 'POST', '/v1/pair', { body: { code: code === '000000' ? '111111' : '000000', clientName: 't' } });
    assert.equal(r.status, 401); ok('wrong code');

    r = await req(port, 'POST', '/v1/pair', { body: { code, clientName: 'test' } });
    assert.equal(r.status, 200); assert.match(r.json.token, /^[0-9a-f]{64}$/);
    const token = r.json.token; ok('correct pairing');
    assert.ok(!fs.readFileSync(path.join(dir, 'capture-tokens.json'), 'utf8').includes(token)); ok('token stored hashed');
    r = await req(port, 'POST', '/v1/pair', { body: { code, clientName: 'again' } });
    assert.equal(r.status, 401); ok('code single use');

    r = await req(port, 'GET', '/v1/ping', { headers: { 'X-Visubly-Token': token } });
    assert.equal(r.json.paired, true); assert.equal(bridge.info().pairedClients, 1); ok('ping paired');

    const payload = { url: 'https://cdn.example.com/a/master.m3u8?x=1', type: 'hls', headers: { referer: 'https://example.com/', cookie: 'a=b', junk: 'x' }, pageUrl: 'https://example.com/v', pageTitle: 'T', detectedAt: 1 };
    r = await req(port, 'POST', '/v1/capture', { headers: { 'X-Visubly-Token': token, Origin: EXT }, body: payload });
    assert.equal(r.status, 202); assert.equal(captures.length, 1);
    assert.deepEqual(captures[0].headers, { referer: 'https://example.com/', cookie: 'a=b' }); ok('capture with token');

    r = await req(port, 'POST', '/v1/capture', { headers: { 'X-Visubly-Token': token }, body: { ...payload, url: 'file:///c:/x.mp4' } });
    assert.equal(r.status, 400); ok('non-http url rejected');

    r = await req(port, 'POST', '/v1/capture', { body: payload });
    assert.equal(r.status, 401); assert.equal(captures.length, 1); ok('capture without token 401');

    r = await req(port, 'POST', '/v1/capture', { headers: { 'X-Visubly-Token': token, Origin: 'https://evil.example' }, body: payload });
    assert.equal(r.status, 403); ok('web origin 403');
    r = await req(port, 'OPTIONS', '/v1/capture', { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    r = await req(port, 'OPTIONS', '/v1/capture', { headers: { Origin: EXT } });
    assert.equal(r.status, 204); assert.match(r.headers['access-control-allow-headers'], /X-Visubly-Token/); ok('preflight');

    r = await req(port, 'POST', '/v1/capture', { headers: { 'X-Visubly-Token': token }, body: JSON.stringify({ url: 'https://a.com/x.m3u8', pad: 'x'.repeat(70000) }) });
    assert.equal(r.status, 413); ok('oversize 413');

    const b2 = createCaptureBridge({ port, dataDir: dir, onCapture: async () => {}, logger: quiet });
    const s2 = await b2.start();
    assert.equal(s2.port, port + 1); assert.equal(b2.info().port, port + 1); await b2.stop(); ok('port fallback');

    bridge.createPairingCode();
    let last;
    for (let i = 0; i < 6; i++) last = await req(port, 'POST', '/v1/pair', { body: { code: '999999' } });
    assert.equal(last.status, 429); ok('rate limit 429');

    bridge.revokeAll();
    r = await req(port, 'GET', '/v1/ping', { headers: { 'X-Visubly-Token': token } });
    assert.equal(r.json.paired, false); ok('revokeAll');

    await bridge.stop(); assert.equal(bridge.info().running, false); ok('stop');
    console.log('ALL PASSED');
  } catch (e) {
    console.error('FAILED:', e); try { await bridge.stop(); } catch {} process.exit(1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})();
