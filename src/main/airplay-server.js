const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const ffmpeg = require('fluent-ffmpeg');
let ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
if (ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}
ffmpeg.setFfmpegPath(ffmpegPath);

const Bonjour = require('bonjour-service');

class AirplayServer extends EventEmitter {
    constructor() {
        super();
        this.port = 3588;
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server, path: '/ws' });
        
        this.pairingToken = null;
        this.currentPairingPin = null;
        this.currentFolder = null;
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

        this.pairingToken = randomUUID().substring(0, 8);
        
        return new Promise((resolve) => {
            this.server.listen(this.port, '0.0.0.0', async () => {
                const info = await this.getServerInfo();
                
                // Publish Bonjour service for Native App discovery
                this.bonjourService = this.bonjour.publish({ 
                    name: 'ViSUBLY Desktop - ' + os.hostname(), 
                    type: 'visubly', 
                    port: this.port 
                });

                resolve(info);
            });
        });
    }

    stop() {
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
    }

    setFolder(folderData) {
        this.currentFolder = folderData;
        this.broadcastEvent('folder_changed', { path: folderData.path });
    }

    async getServerInfo() {
        const ip = this.getLocalIpAddress();
        const baseUrl = `http://${ip}:${this.port}`;
        const pairingUrl = `${baseUrl}/?token=${this.pairingToken}`;
        
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
            pairingToken: this.pairingToken,
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

    setupRoutes() {
        // --- CORS middleware ---
        this.app.use(express.json());
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            next();
        });

        // --- Native App Pairing APIs ---
        this.app.post('/api/request-pairing', (req, res) => {
            // Generate a random 4 digit PIN
            this.currentPairingPin = Math.floor(1000 + Math.random() * 9000).toString();
            // Emit event to main process so it can show a dialog
            this.emit('pairing_requested', this.currentPairingPin);
            res.json({ success: true, message: 'PIN requested. Please check the PC screen.' });
        });

        this.app.post('/api/verify-pairing', (req, res) => {
            const { pin } = req.body;
            if (pin && pin === this.currentPairingPin) {
                this.currentPairingPin = null; // Consume the PIN
                this.emit('pairing_success');
                res.json({ success: true, token: this.pairingToken });
            } else {
                res.status(401).json({ success: false, error: 'Invalid PIN' });
            }
        });

        // --- PWA Entry ---
        this.app.get('/', (req, res) => {
            if (req.query.token !== this.pairingToken) {
                return res.status(401).send('<h1>401 Unauthorized</h1><p>Invalid or expired pairing token.</p>');
            }
            this.serveRemotePWA(res, req.query.token);
        });

        // --- API Health Check ---
        this.app.get('/api/health', (req, res) => {
            res.json({ status: 'ok', serverTime: Date.now() });
        });

        // --- Token Validation Middleware for API ---
        const requireToken = (req, res, next) => {
            if (req.query.token !== this.pairingToken) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            next();
        };

        // --- Video List API ---
        this.app.get('/api/videos', requireToken, (req, res) => {
            res.json(this.currentFolder?.videos || []);
        });

        // --- API Thumbnail ---
        this.app.get('/api/thumb/:token/:id', (req, res) => {
            if (req.params.token !== this.pairingToken) {
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
            if (req.params.token !== this.pairingToken) return res.status(403).send('Forbidden');
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

                const baseUrl = `/api/hls/${encodeURIComponent(this.pairingToken)}/${encodeURIComponent(videoId)}/`;

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
                    .on('end', () => console.log('HLS generation finished'))
                    .on('error', (err) => console.error('FFmpeg Error:', err));
                
                command.run();
                this.activeTranscodes.set(videoId, { command, dir: hlsDir });
            }

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
            if (req.params.token !== this.pairingToken) return res.status(403).send('Forbidden');
            const videoId = decodeURIComponent(req.params.id);
            const segment = req.params.segment;
            const hlsDir = path.join(os.tmpdir(), 'visubly-hls', videoId);
            const segPath = path.join(hlsDir, segment);

            if (fs.existsSync(segPath)) {
                res.setHeader('Content-Type', 'video/MP2T');
                fs.createReadStream(segPath).pipe(res);
            } else {
                res.status(404).end();
            }
        });
    }

    setupWebSockets() {
        this.wss.on('connection', (ws) => {
            ws.send(JSON.stringify({ type: 'connected' }));
            
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    // Có thể xử lý các command từ remote gửi lên (ví dụ: play, pause) ở đây
                } catch (e) { }
            });
        });
    }

    serveRemotePWA(res, token) {
        res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Visubly Remote</title>
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <style>
        :root { 
            --bg: #f0eee9; 
            --paper: #fffdfa; 
            --ink: #1a1620; 
            --ink-soft: #675f6d; 
            --coral: #ff8b6e;
            --vi-red: #c54a3b;
            --vi-star: #f2ca4b;
            --line: 1.5px solid var(--ink);
            --primary: var(--coral);
            --shadow: 3px 3px 0 var(--ink);
        }
        @media (prefers-color-scheme: dark) {
            :root {
                --bg: #111;
                --paper: #222;
                --ink: #fff;
                --ink-soft: #aaa;
                --line: 1px solid #333;
                --primary: #0a84ff;
                --shadow: none;
                --vi-red: #c54a3b;
                --vi-star: #f2ca4b;
            }
        }

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
            <span class="logo-mark">Vi</span>
            <span style="color:var(--ink)">subly</span>
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
            const stem = title.replace(/\.[^.]+$/, "");
            return /(?:^|[-_.\s])vs(?:$|[-_.\s])/i.test(stem);
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
            const base = name.replace(/\.[^.]+$/, '');
            const match = base.match(/^(.*?)[-_\s]*\d+.*$/);
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
        const ws = new WebSocket(\`\${protocol}//\${window.location.host}/ws\`);
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
