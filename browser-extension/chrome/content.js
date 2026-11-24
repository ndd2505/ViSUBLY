// Floating "download with ViSUBLY" pill over the largest visible <video>.
(() => {
  if (window.__visublyGrabber) return;
  window.__visublyGrabber = true;

  let count = 0;
  let host = null, root = null, pill = null, toast = null;
  let target = null, hovering = false, toastTimer = 0, sending = false;
  let rescanTimer = 0, rafId = 0;

  function ensureUi() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .pill{position:fixed;display:none;pointer-events:auto;cursor:pointer;border:0;border-radius:999px;padding:7px 13px;
        font:600 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;background:#1A1620;color:#D7FF61;
        box-shadow:0 2px 10px rgba(0,0,0,.35);white-space:nowrap}
      .pill:hover{background:#FF8B6E;color:#1A1620}
      .pill[disabled]{opacity:.7;cursor:default}
      .toast{position:fixed;display:none;pointer-events:none;border-radius:10px;padding:8px 12px;max-width:280px;
        font:600 12px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;background:#1A1620;color:#FFFDFA;
        box-shadow:0 2px 12px rgba(0,0,0,.35)}
      .toast.ok{border-left:4px solid #D7FF61}.toast.bad{border-left:4px solid #D9483B}`;
    pill = document.createElement('button');
    pill.className = 'pill';
    pill.textContent = '⬇ Tải bằng ViSUBLY';
    toast = document.createElement('div');
    toast.className = 'toast';
    pill.addEventListener('mouseenter', () => { hovering = true; });
    pill.addEventListener('mouseleave', () => { hovering = false; scheduleUpdate(); });
    pill.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (sending) return;
      sending = true; pill.disabled = true; pill.textContent = 'Đang gửi...';
      let r;
      try { r = await chrome.runtime.sendMessage({ type: 'send' }); } catch { r = { ok: false, error: 'Không kết nối được tiện ích' }; }
      sending = false; pill.disabled = false; pill.textContent = '⬇ Tải bằng ViSUBLY';
      showToast(r && r.ok ? '✓ ' + (r.message || 'Đã gửi tới ViSUBLY') : (r && r.error) || 'Gửi thất bại', !!(r && r.ok));
    });
    root.append(style, pill, toast);
    (document.body || document.documentElement).appendChild(host);
  }

  function showToast(text, ok) {
    toast.textContent = text;
    toast.className = 'toast ' + (ok ? 'ok' : 'bad');
    toast.style.display = 'block';
    placeToast();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3500);
  }
  function placeToast() {
    if (!target || toast.style.display === 'none') return;
    const r = target.getBoundingClientRect();
    toast.style.top = Math.max(8, r.top + 48) + 'px';
    toast.style.left = Math.max(8, r.right - 12 - toast.offsetWidth) + 'px';
  }

  function visibleArea(v) {
    const r = v.getBoundingClientRect();
    if (r.width < 200 || r.height < 120) return 0;
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    if (w < 100 || h < 60) return 0;
    const cs = getComputedStyle(v);
    if (cs.visibility === 'hidden' || cs.display === 'none') return 0;
    return w * h;
  }
  function findTarget() {
    let best = null, bestA = 0;
    for (const v of document.querySelectorAll('video')) {
      const a = visibleArea(v);
      if (a > bestA) { best = v; bestA = a; }
    }
    return best;
  }

  function update() {
    rafId = 0;
    if (!count) { if (host) { pill.style.display = 'none'; toast.style.display = 'none'; } return; }
    target = findTarget();
    if (!target) { if (host) pill.style.display = 'none'; return; }
    ensureUi();
    const playing = !target.paused && !target.ended;
    if (!(playing || hovering || target.matches(':hover') || sending)) { pill.style.display = 'none'; return; }
    const r = target.getBoundingClientRect();
    pill.style.display = 'block';
    pill.style.top = Math.max(8, r.top + 10) + 'px';
    pill.style.left = Math.max(8, Math.min(r.right, innerWidth) - 10 - pill.offsetWidth) + 'px';
    placeToast();
  }
  function scheduleUpdate() { if (!rafId) rafId = requestAnimationFrame(update); }

  // Hover tracking (cheap, passive).
  document.addEventListener('mousemove', (e) => {
    if (!count) return;
    const v = target || findTarget();
    if (!v) return;
    const r = v.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside !== hovering && !(pill && pill.matches(':hover'))) { hovering = inside; scheduleUpdate(); }
  }, { passive: true, capture: true });
  addEventListener('scroll', scheduleUpdate, { passive: true, capture: true });
  addEventListener('resize', scheduleUpdate, { passive: true });
  for (const ev of ['play', 'pause', 'ended', 'loadedmetadata']) document.addEventListener(ev, scheduleUpdate, true);

  // Videos added later: throttled observer.
  const mo = new MutationObserver(() => {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => { rescanTimer = 0; scheduleUpdate(); }, 700);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => { if (count) scheduleUpdate(); }, 1500);

  function teardown() {
    count = 0; target = null;
    if (host) { host.remove(); host = root = pill = toast = null; }
  }
  addEventListener('pagehide', teardown);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'count') { count = msg.count || 0; if (!count) teardown(); else scheduleUpdate(); }
  });
  chrome.runtime.sendMessage({ type: 'count' }).then((r) => { count = (r && r.count) || 0; scheduleUpdate(); }).catch(() => {});
})();
