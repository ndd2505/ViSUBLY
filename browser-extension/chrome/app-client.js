// Talks to the ViSUBLY desktop app over localhost.
export const PORTS = [47653, 47654, 47655, 47656];
const PING_TIMEOUT = 700;

export async function getToken() {
  const { token } = await chrome.storage.local.get('token');
  return token || '';
}
export async function setToken(token) {
  if (token) await chrome.storage.local.set({ token });
  else await chrome.storage.local.remove('token');
}

async function ping(port, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/ping`, {
      headers: token ? { 'X-Visubly-Token': token } : {},
      signal: AbortSignal.timeout(PING_TIMEOUT),
      cache: 'no-store',
    });
    const j = await res.json();
    if (j && j.ok && j.app === 'visubly') return { port, paired: !!j.paired };
  } catch { /* not running on this port */ }
  return null;
}

// -> { running, port, paired }
export async function probe() {
  const token = await getToken();
  const { port: saved } = await chrome.storage.local.get('port');
  if (saved) {
    const r = await ping(saved, token);
    if (r) return { running: true, ...r };
  }
  const results = await Promise.all(PORTS.filter((p) => p !== saved).map((p) => ping(p, token)));
  const hit = results.find(Boolean);
  if (hit) {
    await chrome.storage.local.set({ port: hit.port });
    return { running: true, ...hit };
  }
  return { running: false, port: null, paired: false };
}

async function post(port, path, body, token) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Visubly-Token': token } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  let j = {};
  try { j = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json: j };
}

export async function pair(code) {
  const st = await probe();
  if (!st.running) return { ok: false, error: 'Mở ViSUBLY trên máy tính trước' };
  try {
    const { status, json } = await post(st.port, '/v1/pair', { code, clientName: 'Chrome' });
    if (status === 200 && json.token) { await setToken(json.token); return { ok: true }; }
    return { ok: false, error: json.error || 'Ghép nối thất bại' };
  } catch {
    return { ok: false, error: 'Lỗi kết nối tới ViSUBLY' };
  }
}

export async function sendCapture(payload) {
  const st = await probe();
  if (!st.running) return { ok: false, code: 'not-running', error: 'Mở ViSUBLY trên máy tính trước' };
  const token = await getToken();
  if (!token || !st.paired) return { ok: false, code: 'not-paired', error: 'Chưa ghép nối với ViSUBLY' };
  try {
    const { status, json } = await post(st.port, '/v1/capture', payload, token);
    if (status === 202 && json.ok) return { ok: true, message: json.message || 'Đã gửi tới ViSUBLY' };
    if (status === 401) return { ok: false, code: 'not-paired', error: 'Chưa ghép nối với ViSUBLY' };
    return { ok: false, code: 'rejected', error: json.error || 'ViSUBLY từ chối yêu cầu' };
  } catch {
    return { ok: false, code: 'network', error: 'Lỗi mạng khi gửi tới ViSUBLY' };
  }
}
