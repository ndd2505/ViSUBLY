const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let tabId = null;
const statusById = new Map(); // groupId -> { cls, text } survives re-renders
let sendingId = '';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function setStatus(groupId, r) {
  statusById.set(groupId, r === 'sending'
    ? { cls: 'status', text: 'Đang gửi...' }
    : { cls: `status ${r && r.ok ? 'ok' : 'bad'}`, text: r && r.ok ? '✓ Đã gửi' : (r && r.error) || 'Lỗi' });
}

async function sendGroup(g, variant) {
  if (sendingId) return;
  sendingId = g.id;
  setStatus(g.id, 'sending');
  rerender();
  const r = await send({ type: 'send', tabId, groupId: g.id, variantUrl: variant ? variant.url : undefined, height: variant ? variant.height : undefined });
  sendingId = '';
  setStatus(g.id, r);
  rerender();
  if (r && r.code === 'not-paired') refresh();
}

function metaLine(g) {
  const sub = el('div', 'sub');
  const parts = [g.host, g.duration, g.size].filter(Boolean);
  sub.append(parts.join(' · '));
  if (g.isLive) sub.append(el('span', 'live', 'Trực tiếp'));
  return sub;
}

function nameLine(g) {
  const name = el('div', 'name', g.title);
  if (g.hint && g.hint !== g.title) {
    name.append(el('span', 'hint-inline', g.hint));
    name.title = g.hint;
  }
  return name;
}

// "▶ Đang phát" / "⏸ Đang dừng trên trang": the video on the page right now.
function nowTag(g) {
  return el('span', g.playing === 'paused' ? 'now paused' : 'now', g.playing === 'paused' ? '⏸ Đang dừng trên trang' : '▶ Đang phát');
}

function card(g) {
  const li = el('li', g.playing ? 'item is-playing' : 'item');
  if (g.playing) li.append(nowTag(g));
  const head = el('div', 'head');
  const meta = el('div', 'meta');
  meta.append(nameLine(g), metaLine(g));
  head.append(el('span', `badge ${g.type}`, g.type.toUpperCase()), meta);
  li.append(head);

  const busy = sendingId === g.id;
  if (g.variants.length) {
    const grid = el('div', 'chips');
    for (const v of g.variants) {
      const chip = el('button', 'chip');
      chip.type = 'button';
      chip.disabled = !!sendingId;
      chip.title = `Tải ${v.label} bằng ViSUBLY`;
      chip.append(el('strong', '', v.label));
      if (v.size) chip.append(el('span', '', v.size));
      chip.addEventListener('click', () => sendGroup(g, v));
      grid.append(chip);
    }
    li.append(grid);
  } else {
    if (g.probing) li.append(el('p', 'probing', 'Đang đọc chất lượng…'));
    const btn = el('button', 'dl', 'Tải bằng ViSUBLY');
    // Wait for the quality list; the button only becomes the fallback once the
    // app has answered without variants (single-quality stream, probe failed or
    // app not reachable), at which point g.probing is false.
    btn.disabled = !!sendingId || !!g.probing;
    if (g.probing) {
      btn.title = 'Đợi ViSUBLY đọc xong danh sách chất lượng';
      btn.setAttribute('aria-busy', 'true');
    }
    btn.addEventListener('click', () => sendGroup(g));
    li.append(btn);
  }
  const st = statusById.get(g.id);
  if (st || busy) li.append(el('div', (st && st.cls) || 'status', (st && st.text) || 'Đang gửi...'));
  return li;
}

function shortRow(g) {
  const li = el('li', 'item mini');
  const meta = el('div', 'meta');
  meta.append(nameLine(g), metaLine(g));
  const btn = el('button', 'mini-dl', 'Tải');
  btn.disabled = !!sendingId;
  btn.addEventListener('click', () => sendGroup(g));
  li.append(el('span', `badge ${g.type}`, g.type.toUpperCase()), meta, btn);
  const st = statusById.get(g.id);
  if (st) li.append(el('div', `${st.cls} full`, st.text));
  return li;
}

let lastState = null;
function render(state) {
  lastState = state;
  const dot = $('dot');
  $('notRunning').hidden = state.running;
  $('pairBox').hidden = !(state.running && !state.paired);
  $('forget').hidden = !state.paired;
  if (typeof state.sniff === 'boolean' && !sniffBusy) $('sniffToggle').checked = state.sniff;
  if (!state.running) { dot.className = 'dot bad'; $('connText').textContent = 'ViSUBLY chưa mở'; }
  else if (!state.paired) { dot.className = 'dot warn'; $('connText').textContent = 'Chưa ghép nối'; }
  else { dot.className = 'dot ok'; $('connText').textContent = 'Đã kết nối'; }

  const groups = state.groups || [];
  const short = state.short || [];
  // DRM pages: say so up front instead of a puzzling "no video".
  const note = state.drm ? `Trang này dùng DRM (${state.drm}): video có bảo vệ bản quyền, ViSUBLY không tải được.` : state.note;
  $('note').hidden = !note;
  $('note').textContent = note || '';
  const list = $('list');
  list.textContent = '';
  for (const g of groups) list.append(card(g));
  $('empty').hidden = groups.length + short.length > 0;
  if (!groups.length && short.length) { $('empty').hidden = false; $('empty').textContent = 'Chỉ thấy video ngắn hoặc video xem trước trên trang này.'; }
  else $('empty').textContent = 'Chưa thấy video nào. Hãy bấm phát video trên trang.';
  $('shortBox').hidden = !short.length;
  $('shortCount').textContent = String(short.length);
  const sl = $('shortList');
  sl.textContent = '';
  for (const g of short) sl.append(shortRow(g));
  const previous = state.previous || [];
  $('prevBox').hidden = !previous.length;
  $('prevCount').textContent = String(previous.length);
  const pl = $('prevList');
  pl.textContent = '';
  for (const g of previous) pl.append(shortRow(g));
}
function rerender() { if (lastState) render(lastState); }

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  const state = tabId == null ? { groups: [], short: [], running: false, paired: false } : await send({ type: 'getState', tabId });
  render(state || { groups: [], short: [], running: false, paired: false });
}

// Probe results arrive one by one; re-read the state when the background says so.
let refreshTimer = 0;
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'tabState' || msg.tabId !== tabId) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 150);
});

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

// "Không thấy video? Chẩn đoán": the background's guess at why, plus a copyable report.
let sniffBusy = false;
$('sniffToggle').addEventListener('change', async (e) => {
  sniffBusy = true;
  const r = await send({ type: 'setSniff', enabled: e.target.checked });
  sniffBusy = false;
  if (r && typeof r.sniff === 'boolean') e.target.checked = r.sniff;
  $('sniffHint').hidden = false;
});

let diagReport = '';
$('diagBtn').addEventListener('click', async () => {
  const box = $('diagBox');
  if (!box.hidden) { box.hidden = true; return; }
  const r = tabId == null ? null : await send({ type: 'diag', tabId });
  const reasons = $('diagReasons');
  reasons.textContent = '';
  for (const line of (r && r.reasons) || ['Không đọc được thông tin của tab này.']) reasons.append(el('li', '', line));
  const unknown = $('diagUnknown');
  unknown.textContent = '';
  for (const u of (r && r.unknown) || []) unknown.append(el('li', '', u));
  unknown.hidden = !unknown.childElementCount;
  diagReport = (r && r.report) || '';
  $('diagCopied').hidden = true;
  box.hidden = false;
});
$('diagCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(diagReport); $('diagCopied').hidden = false; } catch { /* ignore */ }
});

refresh();
