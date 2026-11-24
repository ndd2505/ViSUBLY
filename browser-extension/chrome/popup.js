const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let tabId = null;

function fileName(url) {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean);
    let n = decodeURIComponent(p[p.length - 1] || '');
    if (n.length > 34) n = n.slice(0, 18) + '…' + n.slice(-13);
    return n || 'video';
  } catch { return 'video'; }
}
function host(url) { try { return new URL(url).host; } catch { return ''; } }
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return 'vừa xong';
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  return `${Math.round(s / 3600)} giờ trước`;
}
function size(n) {
  if (!n) return '';
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function render(state) {
  const dot = $('dot');
  $('notRunning').hidden = state.running;
  $('pairBox').hidden = !(state.running && !state.paired);
  $('forget').hidden = !state.paired;
  if (!state.running) { dot.className = 'dot bad'; $('connText').textContent = 'ViSUBLY chưa mở'; }
  else if (!state.paired) { dot.className = 'dot warn'; $('connText').textContent = 'Chưa ghép nối'; }
  else { dot.className = 'dot ok'; $('connText').textContent = 'Đã kết nối'; }

  const list = $('list');
  list.textContent = '';
  $('empty').hidden = state.streams.length > 0;
  for (const s of state.streams) {
    const li = document.createElement('li');
    li.className = 'item';
    const badge = document.createElement('span');
    badge.className = `badge ${s.type}`;
    badge.textContent = s.type.toUpperCase();
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = fileName(s.url); name.title = s.url;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = [host(s.url), size(s.sizeHint), ago(s.detectedAt)].filter(Boolean).join(' · ');
    meta.append(name, sub);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const btn = document.createElement('button');
    btn.className = 'dl'; btn.textContent = 'Tải bằng ViSUBLY';
    const status = document.createElement('span');
    status.className = 'status';
    btn.addEventListener('click', async () => {
      btn.disabled = true; status.className = 'status'; status.textContent = 'Đang gửi...';
      const r = await send({ type: 'send', tabId, streamId: s.id });
      btn.disabled = false;
      status.className = `status ${r && r.ok ? 'ok' : 'bad'}`;
      status.textContent = r && r.ok ? '✓ Đã gửi' : (r && r.error) || 'Lỗi';
      if (r && r.code === 'not-paired') refresh();
    });
    actions.append(btn, status);
    li.append(badge, meta, actions);
    list.append(li);
  }
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  const state = tabId == null ? { streams: [], running: false, paired: false } : await send({ type: 'getState', tabId });
  render(state);
}

$('pairBtn').addEventListener('click', async () => {
  const code = $('code').value.trim();
  const err = $('pairErr');
  err.hidden = true;
  if (!/^\d{6}$/.test(code)) { err.textContent = 'Mã gồm 6 chữ số'; err.hidden = false; return; }
  $('pairBtn').disabled = true;
  const r = await send({ type: 'pair', code });
  $('pairBtn').disabled = false;
  if (r && r.ok) { $('code').value = ''; refresh(); }
  else { err.textContent = (r && r.error) || 'Ghép nối thất bại'; err.hidden = false; }
});
$('code').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pairBtn').click(); });
$('forget').addEventListener('click', async () => { await send({ type: 'unpair' }); refresh(); });

refresh();
