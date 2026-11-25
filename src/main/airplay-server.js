const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// Trusted phones keep a long-lived token (cookie + localStorage on the phone, sha256 on the PC),
// so pairing happens once instead of every time the Remote server restarts.
const DEVICE_COOKIE = 'visubly_device';
const DEVICE_TOKEN_BYTES = 32;
const MAX_DEVICES = 20;
const PAIRING_TTL_MS = 2 * 60 * 1000;
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
function safeEqual(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
function escapeHtmlText(value) {
    return String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cleanDeviceName(value, fallback = 'iPhone') {
    const name = String(value || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
    return name || fallback;
}
function deviceNameFromUserAgent(ua = '') {
    if (/iPad/i.test(ua)) return 'iPad';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/Android/i.test(ua)) return 'Android';
    if (/Macintosh/i.test(ua)) return 'Mac';
    if (/Windows/i.test(ua)) return 'Windows PC';
    return 'Thiết bị';
}
const ffmpeg = require('fluent-ffmpeg');
const { resolveFfmpegPath } = require('./ffmpeg-path');
const ffmpegPath = resolveFfmpegPath();
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

const Bonjour = require('bonjour-service');

class AirplayServer extends EventEmitter {
    constructor() {
        super();
        this.port = Number(process.env.VISUBLY_REMOTE_PORT) || 3588;
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server, path: '/ws' });

        this.dataDir = null;
        this.iconPath = null;
        this.devices = [];
        this.qrToken = null;      // in the QR / copied link only; exchanged for a device token on first open
        this.mediaToken = null;   // embedded in generated HLS playlists; rotates per start
        this.pendingPairings = new Map(); // requestId -> { deviceName, pin, status, expiresAt }
        this.pairingAttempts = new Map(); // ip -> [timestamps]
        this.currentPairingPin = null;    // legacy PIN for older native/Expo clients
        this.currentFolder = null;
        this.stopping = false;
        this.activeStreamRequests = 0;
        this.activeTranscodes = new Map();
        this.bonjour = new Bonjour.Bonjour();
        this.bonjourService = null;

        this.setupRoutes();
        this.setupWebSockets();
    }

    getLocalIpAddress() {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
        return '127.0.0.1';
    }

    async start() {
        if (this.server.listening) return this.getServerInfo();

        this.stopping = false;
        this.qrToken = randomHex(16);
        this.mediaToken = randomHex(16);

        return new Promise((resolve) => {
            this.server.listen(this.port, '0.0.0.0', async () => {
                const info = await this.getServerInfo();
                
                // Publish Bonjour service for Native App discovery
                this.bonjourService = this.bonjour.publish({ 
                    name: 'ViSUBLY Desktop - ' + os.hostname(), 
                    type: 'visubly', 
                    port: this.port 
                });

                this.emitActivityChanged('AirPlay server started');
                resolve(info);
            });
        });
    }

    stop() {
        this.stopping = true;
        if (this.bonjourService) {
            this.bonjourService.stop();
            this.bonjourService = null;
        }
        if (this.server.listening) {
            this.wss.clients.forEach(client => client.terminate());
            this.server.close();
        }
        // Cleanup ffmpeg
        for (const [id, t] of this.activeTranscodes.entries()) {
            if (t.command) t.command.kill('SIGKILL');
        }
        this.activeTranscodes.clear();
        this.activeStreamRequests = 0;
        this.emit('server_stopped');
        this.emitActivityChanged('AirPlay server stopped');
    }

    // ---------- trusted devices ----------
    configure({ dataDir, iconPath } = {}) {
        if (dataDir) this.dataDir = dataDir;
        if (iconPath) this.iconPath = iconPath;
        this.loadDevices();
    }

    devicesFile() {
        return this.dataDir ? path.join(this.dataDir, 'remote-devices.json') : null;
    }

    loadDevices() {
        const file = this.devicesFile();
        if (!file) return;
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            this.devices = Array.isArray(data.devices) ? data.devices.filter((d) => d && d.id && d.tokenHash) : [];
        } catch {
            this.devices = [];
        }
    }

    saveDevices() {
        const file = this.devicesFile();
        if (!file) return;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ devices: this.devices }, null, 2), 'utf8');
        } catch (error) {
            console.error('Could not save remote devices', error);
        }
    }

    publicDevice(d) {
        return { id: d.id, name: d.name, via: d.via, createdAt: d.createdAt, lastSeen: d.lastSeen };
    }

    listDevices() {
        return this.devices.map((d) => this.publicDevice(d)).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    }

    hasDevices() {
        return this.devices.length > 0;
    }

    issueDevice(name, via) {
        const token = randomHex(DEVICE_TOKEN_BYTES);
        const now = Date.now();
        const device = { id: randomHex(6), name: cleanDeviceName(name), tokenHash: sha256(token), via, createdAt: now, lastSeen: now };
        this.devices.push(device);
        if (this.devices.length > MAX_DEVICES) {
            this.devices.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
            this.devices.length = MAX_DEVICES;
        }
        this.saveDevices();
        this.emit('devices_changed', this.listDevices());
        return { token, device: this.publicDevice(device) };
    }

    findDevice(token) {
        if (typeof token !== 'string' || token.length !== DEVICE_TOKEN_BYTES * 2) return null;
        const hash = sha256(token);
        return this.devices.find((d) => safeEqual(d.tokenHash, hash)) || null;
    }

    touchDevice(device) {
        const now = Date.now();
        if (now - (device.lastSeen || 0) < 60000) return;
        device.lastSeen = now;
        this.saveDevices();
    }

    revokeDevice(id) {
        const before = this.devices.length;
        this.devices = this.devices.filter((d) => d.id !== id);
        if (this.devices.length === before) return false;
        this.saveDevices();
        this.wss.clients.forEach((client) => { if (client.deviceId === id) client.close(4401, 'revoked'); });
        this.emit('devices_changed', this.listDevices());
        return true;
    }

    revokeAllDevices() {
        this.devices = [];
        this.saveDevices();
        this.wss.clients.forEach((client) => client.close(4401, 'revoked'));
        this.emit('devices_changed', []);
    }

    // ---------- auth ----------
    cookieToken(req) {
        const header = req.headers.cookie || '';
        const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(DEVICE_COOKIE + '='));
        return match ? decodeURIComponent(match.slice(DEVICE_COOKIE.length + 1)) : '';
    }

    setDeviceCookie(res, token) {
        res.setHeader('Set-Cookie', `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
    }

    // Returns { device } for a trusted phone, { media: true } for the per-start HLS token, else null.
    authorize(token) {
        if (!token) return null;
        const device = this.findDevice(token);
        if (device) {
            this.touchDevice(device);
            return { device };
        }
        if (this.mediaToken && safeEqual(token, this.mediaToken)) return { media: true };
        return null;
    }

    requestToken(req) {
        return (req.params && req.params.token) || req.query.token || this.cookieToken(req) || '';
    }

    // ---------- approve-on-PC pairing ----------
    allowPairingAttempt(ip) {
        const now = Date.now();
        const recent = (this.pairingAttempts.get(ip) || []).filter((t) => now - t < 60000);
        if (recent.length >= 5) return false;
        recent.push(now);
        this.pairingAttempts.set(ip, recent);
        return true;
    }

    prunePairings() {
        const now = Date.now();
        for (const [id, p] of this.pendingPairings) {
            if (p.expiresAt < now) {
                this.pendingPairings.delete(id);
                if (p.status === 'pending') this.emit('pairing_resolved', { requestId: id, allow: false, reason: 'expired' });
            }
        }
    }

    respondPairing(requestId, allow) {
        this.prunePairings();
        const pairing = this.pendingPairings.get(requestId);
        if (!pairing || pairing.status !== 'pending') return false;
        pairing.status = allow ? 'approved' : 'denied';
        if (this.currentPairingPin && this.currentPairingPin.requestId === requestId) this.currentPairingPin = null;
        this.emit('pairing_resolved', { requestId, allow: Boolean(allow) });
        return true;
    }

    setFolder(folderData) {
        this.currentFolder = folderData;
        this.broadcastEvent('folder_changed', { path: folderData.path });
    }

    async getServerInfo() {
        const ip = this.getLocalIpAddress();
        const baseUrl = `http://${ip}:${this.port}`;
        const pairingUrl = `${baseUrl}/?token=${this.qrToken}`;
        
        let qrDataUrl = '';
        try {
            qrDataUrl = await QRCode.toDataURL(pairingUrl, { width: 250, margin: 1 });
        } catch (e) {
            console.error("QR Code generation failed", e);
        }

        return {
            ip,
            port: this.port,
            baseUrl,
            pairingUrl,
            pairingToken: this.qrToken,
            running: this.server.listening && !this.stopping,
            devices: this.listDevices(),
            qrUrl: qrDataUrl // Trả về base64 image data thay vì API ngoài
        };
    }

    broadcastEvent(type, data) {
        const payload = JSON.stringify({ type, data });
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }

    getActivityState(reason = '') {
        const websocketClients = [...this.wss.clients].filter(client => client.readyState === WebSocket.OPEN).length;
        const runningTranscodes = [...this.activeTranscodes.values()].filter(item => item.status === 'running' && item.command).length;
        return {
            active: this.server.listening && !this.stopping && (this.activeStreamRequests > 0 || websocketClients > 0 || runningTranscodes > 0),
            reason,
            activeStreamRequests: this.activeStreamRequests,
            websocketClients,
            runningTranscodes,
            serverListening: this.server.listening
        };
    }

    emitActivityChanged(reason) {
        this.emit('activity_changed', this.getActivityState(reason));
    }

    trackStreamResponse(res, reason) {
        this.activeStreamRequests += 1;
        this.emitActivityChanged(reason);

        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            this.activeStreamRequests = Math.max(0, this.activeStreamRequests - 1);
            this.emitActivityChanged(`${reason} ended`);
        };

        res.once('close', release);
        res.once('finish', release);
        return release;
    }

    setupRoutes() {
        // --- CORS middleware ---
        this.app.use(express.json());
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            next();
        });

        // --- Pairing: the phone asks, the PC user clicks "Cho phép" (no code typing) ---
        this.app.post('/api/request-pairing', (req, res) => {
            const ip = req.socket.remoteAddress || '';
            if (!this.allowPairingAttempt(ip)) return res.status(429).json({ success: false, error: 'Too many requests' });
            this.prunePairings();
            if (this.pendingPairings.size >= 3) return res.status(429).json({ success: false, error: 'Too many pending requests' });
            const requestId = randomHex(16);
            const deviceName = cleanDeviceName(req.body && req.body.deviceName, deviceNameFromUserAgent(req.headers['user-agent']));
            // Legacy 4-digit PIN for older native/Expo clients; it is only shown on the PC, never returned here.
            const pin = String(crypto.randomInt(1000, 10000));
            this.pendingPairings.set(requestId, { deviceName, pin, status: 'pending', expiresAt: Date.now() + PAIRING_TTL_MS });
            this.currentPairingPin = { pin, requestId };
            this.emit('pairing_requested', { requestId, deviceName, pin });
            res.json({ success: true, requestId, message: 'Waiting for approval on the PC.' });
        });

        this.app.get('/api/pairing-status', (req, res) => {
            this.prunePairings();
            const requestId = String(req.query.requestId || '');
            const pairing = this.pendingPairings.get(requestId);
            if (!pairing) return res.json({ status: 'expired' });
            if (pairing.status === 'pending') return res.json({ status: 'pending' });
            this.pendingPairings.delete(requestId);
            if (pairing.status !== 'approved') return res.json({ status: 'denied' });
            const { token, device } = this.issueDevice(pairing.deviceName, 'approve');
            this.setDeviceCookie(res, token);
            this.emit('pairing_success', device);
            res.json({ status: 'approved', token });
        });

        // Legacy PIN flow (older ViSUBLY phone apps). Now also returns a persistent device token.
        this.app.post('/api/verify-pairing', (req, res) => {
            const { pin } = req.body || {};
            const current = this.currentPairingPin;
            const pairing = current && this.pendingPairings.get(current.requestId);
            if (pin && current && pairing && pairing.status === 'pending' && safeEqual(pin, current.pin)) {
                this.currentPairingPin = null;
                this.pendingPairings.delete(current.requestId);
                const { token, device } = this.issueDevice(pairing.deviceName, 'pin');
                this.emit('pairing_resolved', { requestId: current.requestId, allow: true });
                this.emit('pairing_success', device);
                res.json({ success: true, token });
            } else {
                res.status(401).json({ success: false, error: 'Invalid PIN' });
            }
        });

        // Restore the cookie from the token the page kept in localStorage.
        this.app.post('/api/session', (req, res) => {
            const token = String((req.body && req.body.token) || '');
            const auth = this.authorize(token);
            if (!auth || !auth.device) return res.status(401).json({ ok: false });
            this.setDeviceCookie(res, token);
            res.json({ ok: true });
        });

        // App icon for the page header and "Add to Home Screen".
        this.app.get(['/icon.png', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'], (req, res) => {
            if (!this.iconPath) return res.status(404).end();
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.sendFile(this.iconPath, (err) => { if (err && !res.headersSent) res.status(404).end(); });
        });

        // --- PWA Entry ---
        this.app.get('/', (req, res) => {
            // QR / copied link: trust this browser once, then drop the token from the address bar
            // so the bookmark or Home Screen icon has a clean URL.
            if (req.query.token && this.qrToken && safeEqual(req.query.token, this.qrToken)) {
                const { token, device } = this.issueDevice(deviceNameFromUserAgent(req.headers['user-agent']), 'qr');
                this.setDeviceCookie(res, token);
                this.emit('pairing_success', device);
                return res.redirect(302, '/');
            }
            const token = this.cookieToken(req) || String(req.query.token || '');
            const auth = this.authorize(token);
            if (auth && auth.device) {
                if (!this.cookieToken(req)) this.setDeviceCookie(res, token);
                return this.serveRemotePWA(res, token);
            }
            this.serveConnectPage(res);
        });

        // --- API Health Check ---
        this.app.get('/api/health', (req, res) => {
            res.json({ status: 'ok', serverTime: Date.now() });
        });

        // --- Token Validation Middleware for API ---
        const requireToken = (req, res, next) => {
            const auth = this.authorize(this.requestToken(req));
            if (!auth) return res.status(401).json({ error: 'Unauthorized' });
            req.remoteAuth = auth;
            next();
        };

        // --- Video List API ---
        this.app.get('/api/videos', requireToken, (req, res) => {
            res.json(this.currentFolder?.videos || []);
        });

        // --- API Thumbnail ---
        this.app.get('/api/thumb/:token/:id', (req, res) => {
            if (!this.authorize(req.params.token) && !this.authorize(this.cookieToken(req))) {
                return res.status(401).end();
            }
            const videoId = decodeURIComponent(req.params.id);
            const video = this.currentFolder?.videos.find(v => v.id === videoId || v.name === videoId);
            
            if (!video || !fs.existsSync(video.path)) {
                return res.status(404).end();
            }

            const crypto = require('crypto');
            const fileHash = crypto.createHash('md5').update(video.path).digest('hex');
            const thumbPath = path.join(os.tmpdir(), `visubly_thumb_${fileHash}.jpg`);

            if (fs.existsSync(thumbPath)) {
                res.writeHead(200, { 'Content-Type': 'image/jpeg' });
                return fs.createReadStream(thumbPath).pipe(res);
            }

            ffmpeg(video.path)
                .screenshots({
                    timestamps: ['5%'],
                    folder: os.tmpdir(),
                    filename: `visubly_thumb_${fileHash}.jpg`,
                    size: '320x?'
                })
                .on('end', () => {
                    if (fs.existsSync(thumbPath)) {
                        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
                        fs.createReadStream(thumbPath).pipe(res);
                    } else {
                        res.status(500).end();
                    }
                })
                .on('error', (err) => {
                    res.status(500).end();
                });
        });

        // --- Video Stream API (với Express, hỗ trợ Range) ---
        this.app.get('/api/video/:id', requireToken, (req, res) => {
            const videoId = decodeURIComponent(req.params.id);
            const video = this.currentFolder?.videos.find(v => v.id === videoId || v.name === videoId);
            
            if (!video || !fs.existsSync(video.path)) {
                return res.status(404).end();
            }

            const stat = fs.statSync(video.path);
            const fileSize = stat.size;
            const range = req.headers.range;
            this.trackStreamResponse(res, 'Direct video stream active');

            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunksize = (end - start) + 1;
                const file = fs.createReadStream(video.path, { start, end });
                
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Type': 'video/mp4',
                });
                file.pipe(res);
            } else {
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Content-Type': 'video/mp4',
                });
                fs.createReadStream(video.path).pipe(res);
            }
        });

        // --- HLS Stream API ---
        this.app.get('/api/hls/:token/:id/playlist.m3u8', async (req, res) => {
            if (!this.authorize(req.params.token)) return res.status(403).send('Forbidden');
            const videoId = decodeURIComponent(req.params.id);
            const video = this.currentFolder?.videos.find(v => v.id === videoId || v.name === videoId);
            
            if (!video || !fs.existsSync(video.path)) {
                return res.status(404).end();
            }

            const hlsDir = path.join(os.tmpdir(), 'visubly-hls', videoId);
            if (!fs.existsSync(hlsDir)) {
                fs.mkdirSync(hlsDir, { recursive: true });
            }

            const playlistPath = path.join(hlsDir, 'playlist.m3u8');
            
            if (!this.activeTranscodes.has(videoId)) {
                console.log("Starting FFmpeg HLS conversion for", video.name);
                try {
                    fs.readdirSync(hlsDir).forEach(file => fs.unlinkSync(path.join(hlsDir, file)));
                } catch(e) {}

                // Segment URLs carry the per-start media token, never a device token (the playlist is shared).
                const baseUrl = `/api/hls/${encodeURIComponent(this.mediaToken)}/${encodeURIComponent(videoId)}/`;

                const command = ffmpeg(video.path)
                    .outputOptions([
                        '-c:v libx264',
                        '-preset veryfast',
                        '-crf 23',
                        '-c:a aac',
                        '-b:a 128k',
                        '-ac 2',
                        '-f hls',
                        '-hls_time 4',
                        '-hls_list_size 0',
                        '-hls_flags independent_segments',
                        '-hls_segment_type mpegts',
                        `-hls_base_url ${baseUrl}`,
                        `-hls_segment_filename ${path.join(hlsDir, 'segment_%03d.ts')}`
                    ])
                    .output(playlistPath)
                    .on('end', () => {
                        console.log('HLS generation finished');
                        const transcode = this.activeTranscodes.get(videoId);
                        if (transcode) {
                            transcode.command = null;
                            transcode.status = 'ready';
                        }
                        this.emitActivityChanged('HLS generation finished');
                    })
                    .on('error', (err) => {
                        console.error('FFmpeg Error:', err);
                        this.activeTranscodes.delete(videoId);
                        this.emitActivityChanged('HLS generation failed');
                    });
                
                command.run();
                this.activeTranscodes.set(videoId, { command, dir: hlsDir, status: 'running' });
                this.emitActivityChanged('HLS generation active');
            }

            this.trackStreamResponse(res, 'HLS playlist request active');
            let attempts = 0;
            const checkInterval = setInterval(() => {
                if (fs.existsSync(playlistPath)) {
                    clearInterval(checkInterval);
                    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                    fs.createReadStream(playlistPath).pipe(res);
                } else if (attempts > 30) {
                    clearInterval(checkInterval);
                    res.status(500).send("FFmpeg timeout");
                }
                attempts++;
            }, 1000);
        });

        this.app.get('/api/hls/:token/:id/:segment', (req, res) => {
            if (!this.authorize(req.params.token)) return res.status(403).send('Forbidden');
            const videoId = decodeURIComponent(req.params.id);
            const segment = req.params.segment;
            const hlsDir = path.join(os.tmpdir(), 'visubly-hls', videoId);
            const segPath = path.join(hlsDir, segment);

            if (fs.existsSync(segPath)) {
                res.setHeader('Content-Type', 'video/MP2T');
                this.trackStreamResponse(res, 'HLS segment stream active');
                fs.createReadStream(segPath).pipe(res);
            } else {
                res.status(404).end();
            }
        });
    }

    setupWebSockets() {
        this.wss.on('connection', (ws, req) => {
            // Same trust rules as the HTTP API: a paired device token (query or cookie).
            let token = '';
            try { token = new URL(req.url, 'http://localhost').searchParams.get('token') || ''; } catch { token = ''; }
            const auth = this.authorize(token) || this.authorize(this.cookieToken(req));
            if (!auth || !auth.device) {
                ws.close(4401, 'unauthorized');
                return;
            }
            ws.deviceId = auth.device.id;
            ws.send(JSON.stringify({ type: 'connected' }));
            this.emitActivityChanged('Remote client connected');
            
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    // Có thể xử lý các command từ remote gửi lên (ví dụ: play, pause) ở đây
                } catch (e) { }
            });
            ws.on('close', () => this.emitActivityChanged('Remote client disconnected'));
            ws.on('error', () => this.emitActivityChanged('Remote client errored'));
        });
    }

    // Shown to a browser that is not paired yet: one tap asks the PC, the PC user clicks "Cho phép".
    serveConnectPage(res) {
        res.setHeader('Cache-Control', 'no-store');
        res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>ViSUBLY Remote</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="ViSUBLY">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0E0C12">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
:root { --bg:#0E0C12; --card:#1A1620; --line:#2F2939; --ink:#F4F1EA; --muted:#A9A1B3; --accent:#D7FF61; --on-accent:#14111A; --danger:#FF7A6B; }
@media (prefers-color-scheme: light) { :root { --bg:#F2EFE8; --card:#FFFDFA; --line:#DCD6CA; --ink:#1A1620; --muted:#5F5766; --accent:#1A1620; --on-accent:#D7FF61; --danger:#C3372B; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; background:var(--bg); color:var(--ink); font:16px/1.45 -apple-system, system-ui, sans-serif; display:flex; align-items:center; justify-content:center; padding:24px; }
.card { width:100%; max-width:380px; background:var(--card); border:1px solid var(--line); border-radius:22px; padding:28px 24px; display:flex; flex-direction:column; gap:16px; text-align:center; }
.logo { width:72px; height:72px; margin:0 auto; border-radius:18px; }
h1 { margin:0; font-size:24px; letter-spacing:-.3px; }
p { margin:0; color:var(--muted); font-size:15px; }
label { text-align:left; font-size:13px; font-weight:600; color:var(--muted); }
input { width:100%; height:48px; padding:0 14px; border-radius:12px; border:1px solid var(--line); background:var(--bg); color:var(--ink); font-size:16px; }
button { height:52px; border:0; border-radius:14px; background:var(--accent); color:var(--on-accent); font-size:17px; font-weight:700; }
button:disabled { opacity:.6; }
.status { min-height:22px; font-size:14px; color:var(--muted); }
.status.bad { color:var(--danger); }
.spinner { display:inline-block; width:14px; height:14px; margin-right:8px; border:2px solid var(--line); border-top-color:var(--accent); border-radius:50%; vertical-align:-2px; animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.hint { font-size:13px; }
</style>
</head>
<body>
<main class="card">
  <img class="logo" src="/icon.png" alt="ViSUBLY">
  <h1>Kết nối với ViSUBLY</h1>
  <p>Xem video trên máy tính ngay trên điện thoại. Chỉ cần kết nối một lần.</p>
  <div style="display:flex;flex-direction:column;gap:6px;text-align:left">
    <label for="name">Tên thiết bị</label>
    <input id="name" maxlength="40" autocomplete="off" value="iPhone">
  </div>
  <button id="connect" type="button">Kết nối</button>
  <div id="status" class="status" role="status" aria-live="polite"></div>
  <p class="hint">Hoặc quét mã QR trong ViSUBLY › Cài đặt › Remote iPhone.</p>
</main>
<script>
(function () {
  var KEY = 'visubly_device_token';
  var btn = document.getElementById('connect');
  var statusEl = document.getElementById('status');
  var nameEl = document.getElementById('name');
  try { var saved = localStorage.getItem('visubly_device_name'); if (saved) nameEl.value = saved; } catch (e) {}
  function setStatus(text, bad, busy) {
    statusEl.className = 'status' + (bad ? ' bad' : '');
    statusEl.innerHTML = (busy ? '<span class="spinner"></span>' : '') + text;
  }
  // A token kept in localStorage (cookie cleared): restore the session silently.
  try {
    var token = localStorage.getItem(KEY);
    if (token) {
      setStatus('Đang kết nối lại…', false, true);
      fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token }) })
        .then(function (r) { if (r.ok) location.replace('/'); else { localStorage.removeItem(KEY); setStatus(''); } })
        .catch(function () { setStatus(''); });
    }
  } catch (e) {}
  btn.addEventListener('click', function () {
    var name = nameEl.value.trim() || 'iPhone';
    try { localStorage.setItem('visubly_device_name', name); } catch (e) {}
    btn.disabled = true;
    setStatus('Hãy bấm <b>Cho phép</b> trên máy tính…', false, true);
    fetch('/api/request-pairing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName: name }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok || !x.j.requestId) throw new Error(x.j && x.j.error === 'Too many requests' ? 'Thử lại sau một phút.' : 'Không gửi được yêu cầu.');
        poll(x.j.requestId, Date.now());
      })
      .catch(function (e) { btn.disabled = false; setStatus(e.message || 'Không kết nối được máy tính.', true); });
  });
  function poll(id, started) {
    fetch('/api/pairing-status?requestId=' + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.status === 'approved') {
          try { localStorage.setItem(KEY, j.token); } catch (e) {}
          setStatus('Đã kết nối!');
          location.replace('/');
        } else if (j.status === 'pending' && Date.now() - started < 125000) {
          setTimeout(function () { poll(id, started); }, 1200);
        } else {
          btn.disabled = false;
          setStatus(j.status === 'denied' ? 'Máy tính đã từ chối kết nối.' : 'Hết thời gian chờ. Bấm Kết nối để thử lại.', true);
        }
      })
      .catch(function () { setTimeout(function () { poll(id, started); }, 2000); });
  }
})();
</script>
</body>
</html>`);
    }

    serveRemotePWA(res, token) {
        res.setHeader('Cache-Control', 'no-store');
        res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>ViSUBLY Remote</title>
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-title" content="ViSUBLY">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <style>
        :root {
            --bg: #f2efe8;
            --paper: #fffdfa;
            --ink: #1a1620;
            --ink-soft: #5f5766;
            --coral: #ff8b6e;
            --vi-red: #c54a3b;
            --vi-star: #f2ca4b;
            --line: 1.5px solid var(--ink);
            --primary: var(--coral);
            --shadow: 3px 3px 0 var(--ink);
        }
        @media (prefers-color-scheme: dark) {
            :root {
                --bg: #0e0c12;
                --paper: #1a1620;
                --ink: #f4f1ea;
                --ink-soft: #a9a1b3;
                --line: 1px solid #2f2939;
                --primary: #d7ff61;
                --coral: #d7ff61;
                --shadow: none;
                --vi-red: #c54a3b;
                --vi-star: #f5c842;
            }
        }
        .brand-icon { width: 28px; height: 28px; border-radius: 7px; display: block; }

        /* Giao diện Details Wrapper */
        #details-wrapper {
            width: 100%; aspect-ratio: 16/9; background: #000; display: none; position: relative; border-bottom: var(--line); overflow: hidden;
        }
        #details-wrapper img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.8; }
        .details-overlay { position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 40%, rgba(0,0,0,0.4) 100%); display: block; }
        .details-play-btn { position: absolute; inset: 0; margin: auto; width: 64px; height: 64px; background: var(--coral); border: 3px solid #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 3px 3px 0 #1a1620; transition: transform 0.1s; z-index: 20; }
        .details-play-btn:active { transform: scale(0.95); box-shadow: 1px 1px 0 #1a1620; }
        .details-play-btn svg { width: 32px; height: 32px; fill: #1a1620; margin-left: 4px; }
        .details-title { position: absolute; bottom: 15px; left: 15px; right: 15px; display: block; font-weight: 800; font-size: 16px; color: #fff; text-shadow: 1px 1px 3px rgba(0,0,0,0.9); padding: 0; padding-right: 20px; text-align: left; pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .details-tags { position: absolute; top: 12px; right: 15px; display: flex; gap: 6px; z-index: 20; }
        
        .tag { padding: 3px 8px; border-radius: 12px; background: rgba(0,0,0,0.5); color: #fff; font-weight: 800; font-size: 11px; border: 1.5px solid rgba(255,255,255,0.7); backdrop-filter: blur(4px); box-shadow: 2px 2px 0 rgba(0,0,0,0.4); text-transform: uppercase; }
        .tag.sub-ok { border-color: #69f0ae; color: #69f0ae; }

        .folder-group { font-weight: 800; font-size: 16px; margin: 24px 15px 8px; border-bottom: var(--line); padding-bottom: 5px; color: var(--ink); }
        .prefix-group { font-size: 13px; font-weight: 700; color: var(--ink-soft); margin: 12px 15px 6px; text-transform: uppercase; }
        body { font-family: -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--ink); margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; }
        .header { padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; background: var(--paper); border-bottom: var(--line); }
        .brand { display: flex; align-items: center; gap: 8px; font-weight: 900; font-size: 18px; }
        .logo-mark { display: inline-flex; align-items: center; justify-content: center; min-width: 38px; height: 28px; padding: 0 6px; background: var(--vi-red); color: var(--paper); border: var(--line); border-radius: 6px; box-shadow: 2px 2px 0 var(--ink); transform: rotate(-4deg); position: relative; }
        .logo-mark::before { content: ""; position: absolute; left: 5px; bottom: -5px; width: 8px; height: 8px; background: var(--vi-red); border-left: var(--line); border-bottom: var(--line); transform: rotate(-18deg); }
        .logo-mark::after { content: "★"; position: absolute; right: -6px; top: -8px; width: 14px; height: 14px; display: grid; place-items: center; background: var(--vi-star); color: var(--ink); border: var(--line); border-radius: 50%; font-size: 9px; line-height: 1; }
        
        .video-container { width: 100%; aspect-ratio: 16/9; background: #000; display: flex; justify-content: center; align-items: center; position: relative; border-bottom: var(--line); }
        video { width: 100%; height: 100%; }
        .list-container { flex: 1; overflow-y: auto; padding: 15px; }
        .video-item { padding: 15px; margin-bottom: 12px; background: var(--paper); border: var(--line); border-radius: 8px; cursor: pointer; display: flex; flex-direction: column; box-shadow: var(--shadow); transition: transform 0.1s; }
        .video-item:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--ink); }
        .video-item.active { background: var(--coral); color: var(--ink); border-color: var(--ink); }
        .video-item.active .video-meta { color: var(--ink); opacity: 0.8; }
        .video-title { font-weight: 800; font-size: 15px; word-break: break-word; }
        .video-meta { font-size: 12px; color: var(--ink-soft); margin-top: 4px; font-family: monospace; font-weight: 700; }
        .empty { text-align: center; color: var(--ink-soft); margin-top: 40px; font-weight: 600; }
    </style>
</head>
<body>
    <div class="header">
        <div class="brand">
            <img class="brand-icon" src="/icon.png" alt="">
            <span style="color:var(--ink)">ViSUBLY</span>
        </div>
        <div id="network-health" style="font-size: 11px; font-weight: 700; color: var(--ink-soft); font-family: monospace;">Ping: -- ms</div>
    </div>
    
    <div id="details-wrapper"></div>
    <div class="video-container" id="player-wrapper" style="display: none;">
        <video id="player" controls playsinline crossorigin="anonymous">
            Trình duyệt không hỗ trợ video.
        </video>
    </div>

    <div class="list-container" id="video-list">
        <div class="empty">Đang tải danh sách...</div>
    </div>

    <script>
        const TOKEN = '${token}';
        // Kept so the connect page can restore the session if Safari drops the cookie.
        try { localStorage.setItem('visubly_device_token', TOKEN); } catch (e) {}
        const videoListEl = document.getElementById('video-list');
        const player = document.getElementById('player');
        const playerWrapper = document.getElementById('player-wrapper');
        let currentVideos = [];

        async function fetchVideos() {
            try {
                const res = await fetch('/api/videos?token=' + TOKEN);
                if (!res.ok) throw new Error('Network err');
                currentVideos = await res.json();
                renderList();
            } catch (e) {
                videoListEl.innerHTML = '<div class="empty">Lỗi kết nối.</div>';
            }
        }

        const detailsWrapper = document.getElementById('details-wrapper');
        
        function inferResolution(title) {
            const match = String(title || "").match(/(?:^|[^0-9])([248]80|360|540|720|1080|1440|2160|4320)p(?:[^0-9]|$)/i);
            return match ? \`\${match[1]}p\` : "HD";
        }
        
        function hasSubMarker(title) {
            const stem = title.replace(/\\.[^.]+$/, "");
            return /(?:^|[-_.\\s])vs(?:$|[-_.\\s])/i.test(stem);
        }

        function selectVideo(id) {
            const video = currentVideos.find(v => v.id === id);
            if (!video) return;
            
            player.pause();
            playerWrapper.style.display = 'none';
            detailsWrapper.style.display = 'flex';
            
            const resolution = video.resolutionLabel || inferResolution(video.name);
            const isSubbed = video.hasSubtitle || video.subtitlePath || video.subtitleName || hasSubMarker(video.name);
            const subLabel = video.subtitlePath || video.subtitleName ? "Sub file" : isSubbed ? "-vs sub" : "No sub";
            const subClass = isSubbed ? "sub-ok" : "sub-no";
            const thumbUrl = \`/api/thumb/\${encodeURIComponent(TOKEN)}/\${encodeURIComponent(video.id)}\`;
            
            detailsWrapper.innerHTML = \`
                <img src="\${thumbUrl}" alt="Thumb" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\'><rect width=\\'100%\\' height=\\'100%\\' fill=\\'%23333\\'/></svg>'">
                <div class="details-overlay">
                    <div class="details-title">\${video.name}</div>
                    <div class="details-tags">
                        <span class="tag">\${resolution}</span>
                        <span class="tag \${subClass}">\${subLabel}</span>
                    </div>
                    <div class="details-play-btn" onclick="startPlayback('\${video.id}')">
                        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                </div>
            \`;
            
            renderList(id);
        }

        function startPlayback(id) {
            const video = currentVideos.find(v => v.id === id);
            if (!video) return;
            
            detailsWrapper.style.display = 'none';
            playerWrapper.style.display = 'flex';
            
            const name = video.name || '';
            const ext = name.split('.').pop().toLowerCase();
            if (['mp4', 'mov', 'm4v'].includes(ext)) {
                player.src = '/api/video/' + encodeURIComponent(id) + '?token=' + TOKEN;
            } else {
                player.src = '/api/hls/' + encodeURIComponent(TOKEN) + '/' + encodeURIComponent(id) + '/playlist.m3u8';
            }
            player.play().catch(e => console.error("Auto-play prevented", e));
        }

        function extractVideoPrefix(name) {
            const base = name.replace(/\\.[^.]+$/, '');
            const match = base.match(/^(.*?)[-_\\s]*\\d+.*$/);
            if (match && match[1].length >= 3) {
                return match[1].trim().toUpperCase();
            }
            return null;
        }

        function renderList(activeId = null) {
            if (!currentVideos.length) {
                videoListEl.innerHTML = '<div class="empty" style="padding: 20px; color: #888;">Chưa có video nào trong thư mục. Mở app PC để chọn thư mục.</div>';
                return;
            }

            currentVideos.forEach(v => {
                v.folderName = v.folder || "Thư mục gốc";
                v.prefixRaw = extractVideoPrefix(v.name || "");
            });

            const prefixCounts = {};
            currentVideos.forEach(v => {
                if (v.prefixRaw) {
                    const key = v.folderName + "::" + v.prefixRaw;
                    prefixCounts[key] = (prefixCounts[key] || 0) + 1;
                }
            });

            currentVideos.forEach(v => {
                if (v.prefixRaw) {
                    const key = v.folderName + "::" + v.prefixRaw;
                    v.prefixName = prefixCounts[key] >= 2 ? v.prefixRaw : null;
                } else {
                    v.prefixName = null;
                }
            });

            currentVideos.sort((a, b) => {
                if (a.folderName !== b.folderName) return a.folderName.localeCompare(b.folderName);
                if (a.prefixName !== b.prefixName) {
                    if (!a.prefixName) return 1;
                    if (!b.prefixName) return -1;
                    return a.prefixName.localeCompare(b.prefixName);
                }
                const nameA = a.name || "";
                const nameB = b.name || "";
                return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
            });

            let html = "";
            let currentFolder = null;
            let currentPrefix = null;

            currentVideos.forEach(v => {
                let isNewFolder = v.folderName !== currentFolder;
                let isNewPrefix = isNewFolder || v.prefixName !== currentPrefix;

                if (isNewFolder) {
                    html += \`<div class="folder-group">\${v.folderName}</div>\`;
                    currentFolder = v.folderName;
                    currentPrefix = null;
                }

                if (v.prefixName && (isNewFolder || v.prefixName !== currentPrefix)) {
                    html += \`<div class="prefix-group">\${v.prefixName}</div>\`;
                    currentPrefix = v.prefixName;
                } else if (!v.prefixName && isNewPrefix && currentPrefix !== null) {
                    currentPrefix = null;
                }

                html += \`
                    <div class="video-item \${activeId === v.id ? 'active' : ''}" onclick="selectVideo('\${v.id}')">
                        <div class="video-title">\${v.name}</div>
                        <div class="video-meta">\${(v.size / 1024 / 1024).toFixed(1)} MB</div>
                    </div>
                \`;
            });

            videoListEl.innerHTML = html;
        }

        // WebSockets for real-time updates
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(\`\${protocol}//\${window.location.host}/ws?token=\${encodeURIComponent(TOKEN)}\`);
        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'folder_changed') {
                fetchVideos();
            }
        };

        // Network Health Ping
        async function checkHealth() {
            const start = Date.now();
            try {
                await fetch('/api/health');
                const ping = Date.now() - start;
                const healthEl = document.getElementById('network-health');
                healthEl.innerText = \`Ping: \${ping} ms\`;
                healthEl.style.color = ping < 100 ? '#4cd964' : (ping < 300 ? '#ffcc00' : '#ff3b30');
            } catch (e) {
                document.getElementById('network-health').innerText = 'Mất kết nối LAN';
                document.getElementById('network-health').style.color = '#ff3b30';
            }
        }
        setInterval(checkHealth, 3000);
        checkHealth();

        fetchVideos();
    </script>
</body>
</html>
        `);
    }
}

module.exports = new AirplayServer();
