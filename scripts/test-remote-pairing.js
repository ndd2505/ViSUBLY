// Tests the iPhone Remote pairing: trusted devices that survive restarts, approve-on-PC,
// one-time QR link, legacy PIN, cookie/localStorage session restore, WebSocket auth, revoke.
// Usage: node scripts/test-remote-pairing.js   (uses port 3599 and a temp data dir)
process.env.VISUBLY_REMOTE_PORT = process.env.VISUBLY_REMOTE_PORT || "3599";
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const server = require("../src/main/airplay-server");

const base = `http://127.0.0.1:${process.env.VISUBLY_REMOTE_PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "visubly-remote-test-"));
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "ok  " : "FAIL"} - ${name}${detail ? "  (" + detail + ")" : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (p, opts = {}) => fetch(base + p, { redirect: "manual", ...opts });
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];
const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const wsOpen = (query, headers = {}) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.VISUBLY_REMOTE_PORT}/ws${query}`, { headers });
  let first = null;
  ws.on("message", (m) => { first = first || String(m); });
  ws.on("close", (code) => resolve({ closed: true, code, first }));
  setTimeout(() => { ws.terminate(); resolve({ closed: false, first }); }, 800);
});

(async () => {
  server.configure({ dataDir });
  const requested = [];
  const resolved = [];
  server.on("pairing_requested", (r) => requested.push(r));
  server.on("pairing_resolved", (r) => resolved.push(r));
  let info = await server.start();

  // Not paired: connect page, API closed.
  let res = await req("/");
  let html = await res.text();
  check("unpaired browser gets the connect page", res.status === 200 && html.includes("Kết nối với ViSUBLY"));
  check("API refuses without a token", (await req("/api/videos")).status === 401);
  check("random token refused", (await req("/api/videos?token=" + "a".repeat(64))).status === 401);

  // QR link: trusted once, token removed from the URL.
  res = await req("/?token=" + info.pairingToken);
  const qrCookie = cookieOf(res);
  check("QR link redirects to a clean URL and sets a device cookie", res.status === 302 && res.headers.get("location") === "/" && qrCookie.startsWith("visubly_device="));
  res = await req("/", { headers: { cookie: qrCookie } });
  html = await res.text();
  const qrToken = qrCookie.split("=")[1];
  check("cookie opens the Remote page", res.status === 200 && html.includes("ViSUBLY Remote") && html.includes(qrToken));
  check("cookie authorizes the API", (await req("/api/videos", { headers: { cookie: qrCookie } })).status === 200);
  check("device token authorizes the API in the query", (await req("/api/videos?token=" + qrToken)).status === 200);
  check("wrong QR token falls back to connect page", (await (await req("/?token=deadbeef")).text()).includes("Kết nối với ViSUBLY"));

  // Approve on PC.
  res = await req("/api/request-pairing", json({ deviceName: "iPhone của Test" }));
  const { requestId } = await res.json();
  check("pairing request returns an id but no PIN", Boolean(requestId) && requested.length === 1 && requested[0].deviceName === "iPhone của Test" && !("pin" in (await (await req("/api/pairing-status?requestId=" + requestId)).json())));
  check("status is pending before the PC answers", (await (await req("/api/pairing-status?requestId=" + requestId)).json()).status === "pending");
  check("PC approves", server.respondPairing(requestId, true) && resolved.some((r) => r.requestId === requestId && r.allow));
  res = await req("/api/pairing-status?requestId=" + requestId);
  const approved = await res.json();
  check("approved status returns a device token + cookie", approved.status === "approved" && approved.token.length === 64 && cookieOf(res).startsWith("visubly_device="));
  check("approved token works", (await req("/api/videos?token=" + approved.token)).status === 200);
  check("approval can be claimed only once", (await (await req("/api/pairing-status?requestId=" + requestId)).json()).status === "expired");

  // Deny.
  const denyId = (await (await req("/api/request-pairing", json({ deviceName: "Lạ" }))).json()).requestId;
  server.respondPairing(denyId, false);
  check("denied request reports denied", (await (await req("/api/pairing-status?requestId=" + denyId)).json()).status === "denied");

  // Legacy PIN path (older phone apps).
  const legacyId = (await (await req("/api/request-pairing", json({ deviceName: "App cũ" }))).json()).requestId;
  const pin = requested.find((r) => r.requestId === legacyId).pin;
  check("wrong PIN refused", (await req("/api/verify-pairing", json({ pin: "0000" === pin ? "1111" : "0000" }))).status === 401);
  const legacy = await (await req("/api/verify-pairing", json({ pin }))).json();
  check("legacy PIN returns a persistent device token", legacy.success && legacy.token.length === 64);

  // localStorage restore.
  res = await req("/api/session", json({ token: approved.token }));
  check("session restore sets the cookie for a valid token", res.status === 200 && cookieOf(res).includes(approved.token));
  check("session restore refuses an unknown token", (await req("/api/session", json({ token: "b".repeat(64) }))).status === 401);

  // WebSocket auth.
  let ws = await wsOpen("");
  check("WebSocket without token is closed 4401", ws.closed && ws.code === 4401);
  ws = await wsOpen("?token=" + approved.token);
  check("WebSocket with device token connects", !ws.closed && ws.first && ws.first.includes("connected"));

  // Restart: devices persist, QR link rotates.
  server.stop();
  await sleep(300);
  server.devices = [];
  server.loadDevices();
  info = await server.start();
  check("device token still valid after restart (persisted)", (await req("/api/videos?token=" + approved.token)).status === 200);
  check("QR cookie still valid after restart", (await req("/api/videos", { headers: { cookie: qrCookie } })).status === 200);
  check("devices listed", server.listDevices().length === 3, String(server.listDevices().length));
  check("stored file has no plain tokens", !fs.readFileSync(path.join(dataDir, "remote-devices.json"), "utf8").includes(approved.token));

  // Revoke.
  const target = server.devices.find((d) => d.name === "iPhone của Test");
  check("revoke one device", server.revokeDevice(target.id) && (await req("/api/videos?token=" + approved.token)).status === 401);
  check("other devices unaffected", (await req("/api/videos", { headers: { cookie: qrCookie } })).status === 200);
  server.revokeAllDevices();
  check("revoke all", (await req("/api/videos", { headers: { cookie: qrCookie } })).status === 401);

  // Rate limit.
  let limited = false;
  for (let i = 0; i < 8; i += 1) if ((await req("/api/request-pairing", json({ deviceName: "spam" }))).status === 429) limited = true;
  check("pairing requests are rate limited", limited);

  server.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(failed ? `${failed} FAILED` : `ALL PASSED (${results.length})`);
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
})().catch((error) => {
  console.error("FAILED", error);
  process.exit(1);
});
