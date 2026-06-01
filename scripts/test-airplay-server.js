const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3588;
const projectDir = path.resolve(__dirname, '..');

// Find any mp4 file in the project directory or use a specific one
function findSampleVideo() {
    const files = fs.readdirSync(projectDir);
    const mp4File = files.find(f => f.toLowerCase().endsWith('.mp4'));
    if (mp4File) return path.join(projectDir, mp4File);
    return null;
}

const videoPath = findSampleVideo();

function getLocalIpAddress() {
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

const localIp = getLocalIpAddress();

if (!videoPath) {
    console.error('❌ KHÔNG TÌM THẤY VIDEO NÀO!');
    console.error(`Vui lòng copy một file video (.mp4) bất kỳ vào thư mục: ${projectDir}`);
    console.error('Sau đó chạy lại script này.');
    process.exit(1);
}

console.log(`✅ Tìm thấy video test: ${path.basename(videoPath)}`);

const server = http.createServer((req, res) => {
    // 1. Phục vụ trang HTML (Remote UI giả lập)
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <!DOCTYPE html>
            <html lang="vi">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>AirPlay Test Remote</title>
                <style>
                    body { font-family: -apple-system, sans-serif; background: #000; color: #fff; text-align: center; padding: 20px; margin: 0; }
                    video { width: 100%; max-width: 600px; border-radius: 12px; margin-top: 20px; }
                    h2 { margin-bottom: 5px; }
                    p { color: #aaa; font-size: 14px; }
                </style>
            </head>
            <body>
                <h2>Visubly AirPlay Test</h2>
                <p>Nhấn nút AirPlay trên video để chiếu lên TV</p>
                <video controls playsinline src="/video"></video>
            </body>
            </html>
        `);
        return;
    }

    // 2. Phục vụ Video stream (hỗ trợ Range - Bắt buộc cho Safari/AirPlay)
    if (req.url === '/video') {
        const stat = fs.statSync(videoPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(videoPath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'video/mp4',
            };
            res.writeHead(206, head);
            file.pipe(res);
        } else {
            const head = {
                'Content-Length': fileSize,
                'Content-Type': 'video/mp4',
            };
            res.writeHead(200, head);
            fs.createReadStream(videoPath).pipe(res);
        }
        return;
    }

    res.writeHead(404);
    res.end();
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 SERVER TEST ĐÃ CHẠY!');
    console.log('----------------------------------------------------');
    console.log(`BƯỚC 1: Đảm bảo máy tính và điện thoại/TV đang chung mạng Wi-Fi/LAN.`);
    console.log(`BƯỚC 2: Nếu Windows hiện bảng hỏi Firewall, hãy bấm "Allow" (Cho phép).`);
    console.log(`BƯỚC 3: Mở trình duyệt Safari trên iPhone và truy cập địa chỉ sau:`);
    console.log(`\x1b[36mhttp://${localIp}:${PORT}\x1b[0m`);
    console.log('----------------------------------------------------');
    console.log('Bạn có thể bấm Ctrl+C để tắt server khi test xong.');
});
