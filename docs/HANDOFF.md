# ViSUBLY — Ghi chú bàn giao (kết thúc Giai đoạn 1 · v1.0)

> Cập nhật: 2026-11-25 · Nhánh chính: `main` · App: **Visubly Studio 1.2.2** · Extension: **ViSUBLY Grabber 1.2.0** · Release: GitHub Actions khi push tag `v*`

Tài liệu này dành cho phiên làm việc tiếp theo (người hoặc AI) để nắm nhanh trạng thái và làm tiếp tính năng mới.

---

## 1. Quy tắc làm việc (bắt buộc)

- **Luôn trả lời người dùng bằng tiếng Việt.**
- **Lập kế hoạch theo giai đoạn trước, chờ duyệt rồi mới sửa code** với mọi yêu cầu không nhỏ. Được phép đọc/khảo sát; không sửa, không build cho tới khi người dùng duyệt. Bug nhỏ, rõ ràng và người dùng yêu cầu sửa trực tiếp thì sửa ngay.
- **Sau khi sửa code app phải build lại**: `npm.cmd run package:win` (từ `D:\Projects\ViSUBLY`).
- Không tắt process không phải do mình mở. Nếu app đang chạy chặn build → báo người dùng.
- Commit trên PowerShell 5.1: viết message ra file rồi `git commit -F <file>` (truyền chuỗi có dấu nháy trực tiếp sẽ hỏng). Message kết thúc bằng dòng `Co-Authored-By: ...` theo hướng dẫn của phiên.
- `git add` theo đường dẫn cụ thể. **Không** add `ViSUBLY_Expo_Source/` (287 MB, có node_modules) và `download-queue.json` ở gốc repo (dữ liệu cũ).
- Dùng subagent khi việc tốn thời gian, tối đa 2–3 agent, **chia file sở hữu không chồng nhau**, agent chính làm vai trò duyệt (xem ảnh chụp, kiểm tra commit).

## 2. Trạng thái hiện tại

**Đã xong và hoạt động**
- Tải video HLS / MP4 / DASH qua engine Python đóng gói thành exe (không cần cài Python).
- Bắt link từ Chrome giống IDM: extension phát hiện luồng → gửi sang app qua cổng localhost có ghép nối mã 6 số → hộp thoại "Tải video này?".
- Gom luồng theo video, đọc độ phân giải + thời lượng + dung lượng ước tính, ẩn video ngắn (mặc định < 2 phút, chỉnh trong Cài đặt).
- Trình phát: phát file/thư mục, phụ đề SRT/VTT (tự nhận UTF-8/UTF-16/Windows-1258), theater/toàn màn hình với thanh điều khiển nổi tự ẩn, phím tắt.
- **Tab Nâng cấp video** (1.2.0, mỗi lần 1 video, tạo file mới cạnh file gốc `<tên>_<1080p>.mp4`):
  - `src/main/upscale-presets.js` (thuần, test bằng `scripts/test-upscale-presets.js`): khả năng từng công nghệ + lý do khoá, dựng chuỗi lọc, ước tính tốc độ/thời gian/dung lượng, độ nặng (`ok|heavy|over` theo tốc độ so với thời gian thực, VRAM card rời, pin), chọn tự động (mức + độ phân giải tốt nhất mà vẫn `ok`). Số tham chiếu `REF_FPS`/`REF_BENCH` đo trên RTX 3060.
  - `src/main/upscale-device.js`: `probe()` (adapters + VSR có thật sự đổi điểm ảnh, encoder phần cứng, Vulkan với chuỗi lọc thật ở 480p, benchmark ~3 s), cache `upscale-device.json` theo GPU/driver/phiên bản; stats trực tiếp (nvidia-smi `-lms 1000`, CPU từ `os.cpus()`, RAM, `statfsSync` từng ổ, pin qua CIM + `powerMonitor`).
  - `src/main/upscale-job.js`: chạy `visubly-upscaler run`, tiến độ/ETA, tạm dừng/tiếp tục/hủy, tự dừng khi GPU ≥ 85 °C (tự chạy lại ≤ 75 °C) hoặc ổ lưu < 5 GB, lỗi thì chạy lại bằng kế hoạch FFmpeg (`fallbackPlan`), chép phụ đề cùng tên; `compare()` cho Thử & so sánh (đoạn 5/10/20 s, 3 cấu hình, ảnh trước/sau PNG trong thư mục tạm).
  - `src/main/upscale-ipc.js`: IPC `upscale:*`, hỏi lại khi đóng cửa sổ lúc đang chạy (`app:close-request` → `app:confirmClose`), chống ngủ máy + tiến độ trên taskbar, theo dõi an toàn cả khi không mở tab.
  - Renderer: `src/renderer/upscale.js` (nạp sau app.js, dùng biến toàn cục của nó; nút dùng `data-up`), CSS `.up-*` trong styles.css. Stats và tiến độ vá DOM tại chỗ, không render lại cả trang.
  - `tools/upscaler` (C# .NET 10, Vortice.Direct3D11) → `visubly-upscaler.exe` (`scripts/build-upscaler.ps1`, single-file tự chứa ~10,6 MB): `probe`, `bench`, `run`. VSR qua D3D11 VideoProcessor + extension driver (NVIDIA GUID `d43ce1b3-…` {1,2,1}; Intel VPE — chưa thử máy thật). Texture input NV12 phải có `BindFlags.RenderTarget`. Decoder FFmpeg → NV12 thô (`-fps_mode cfr`) → VSR → encoder FFmpeg (+ tiếng từ file gốc). Lệnh qua stdin: `pause|resume|cancel`; stdin đóng = hủy; con chạy trong job object kill-on-close, ưu tiên thấp.
  - FFmpeg 8.1 (BtbN gpl-shared, `scripts/fetch-ffmpeg.ps1` → `vendor/ffmpeg`, kiểm SHA-256 theo digest GitHub; tag autobuild bị xoá thì lấy `latest` nhánh 8.1) dùng chung cho cả app (`src/main/ffmpeg-path.js`); bản @ffmpeg-installer cũ chỉ còn cho macOS. **libplacebo phải nhận khung đã `hwupload`** (tự upload ở 480p lỗi "No slab"). **Không dùng `nlmeans_vulkan`**: lúc chạy lúc báo "Cannot allocate memory" tuỳ app khác đang dùng GPU; Đẹp nhất dùng `nlmeans=s=2:p=5:r=5` trên CPU.
  - Đo trên RTX 3060 (480p → 1080p): RTX một mình ~94 khung/s, Cân bằng ~65, Đẹp nhất (nlmeans CPU → RTX → cas) ~28 (giới hạn bởi CPU i3-10100F, nên tự động chọn Cân bằng trên máy này); bench VSR ~185, bench FFmpeg ~64.
- **Nâng chất lượng khi phát** (`src/main/video-enhance.js` + main.js + Cài đặt, mặc định BẬT): dùng VSR của GPU qua Chromium (`NvidiaVpSuperResolution`, `IntelVpSuperResolution`), không xử lý trước. Đã đo trên RTX 3060: chỉ chạy khi video lên **hardware overlay** — bo góc (14px + overflow hidden) ở khung video chặn overlay → khi bật thì `.player-stage.is-enhanced` bỏ bo góc (VSR chạy cả cửa sổ/theater/toàn màn hình khi video phóng to); khi tắt giữa chừng thì `.is-enhance-blocked` bo góc 2px cả `<video>` → tắt ngay không cần khởi động lại. Cờ Chromium chỉ đặt lúc khởi động (`planVideoEnhanceLaunch`, trước app ready): bật → `enable-features`, tắt → `disable-features` (gồm `NvidiaVpTrueHDR`). Nhận diện: `app.getGPUInfo('complete')` + `getGPUFeatureStatus()` → RTX + driver ≥ 531.18 / Intel Arc-Xe; còn lại phát gốc. An toàn: `gpu-guard.json` (`startupPending` — lần mở trước chưa ổn định thì tự tắt; ổn định sau 20 s hoặc khi thoát bình thường), `child-process-gone` GPU → tắt, renderer watchdog rớt khung > 20% trong 15 s → tắt; mọi lần tự tắt đều có lý do hiển thị (`disabledReason`). IPC `video:getEnhanceStatus|setEnhance|reportStutter`, sự kiện `video:enhance-changed`, `app:relaunch`. **Không dùng `backdrop-filter` / `mix-blend-mode` cho bất kỳ thứ gì đè lên hình** (1.1.1): nhãn tên video có blur làm video rớt khỏi overlay → VSR tắt mỗi khi thanh điều khiển hiện (tua ở toàn màn hình) và tắt hẳn ở cửa sổ thường; phụ đề (viền hoặc nền tối) thì không ảnh hưởng. `scripts/test-video-enhance.js` quét styles.css để chặn tái phát. Mức tải GPU nên đo bằng util×clock (driver có thể hạ xung khi VSR vẫn chạy: ~30 khi tắt, ~150 khi chạy với video 480p toàn màn hình 1080p). **Đo/kiểm thử cần chạy ngoài sandbox** (sandbox Claude Code làm Chromium rơi về software rendering): A/B bằng `nvidia-smi` (xung nhịp ~210 MHz khi không VSR, ~700–850 MHz + ~+7–9 W khi có).
- Kéo thả toàn cửa sổ (`initDropBridge` trong app.js): thư mục → Thư viện (quét đệ quy; nhiều thư mục gộp qua IPC `media:scanVideoFolders`, id đánh lại, nhóm theo tên thư mục gốc; quét lại giữ đủ các gốc `state.folder.paths`), video → phát như Open with, `.srt/.vtt` → nạp phụ đề, loại khác → thông báo. Đường dẫn lấy bằng `webUtils.getPathForFile`, phân loại file/thư mục bằng IPC `file:kinds`. Lớp phủ "Thả để mở" có watchdog 1 s (tự tắt nếu drag bị huỷ). Main chặn `will-navigate`/cửa sổ mới (trước đây thả file ra ngoài khung trình phát làm cửa sổ chuyển sang file đó). Không nhớ thư mục khi mở lại app (người dùng không muốn).
- Phát hành: `.github/workflows/release.yml` (windows-latest: npm ci → tests → `npm run package:win:ci` → SHA256SUMS → GitHub Release khi push tag `v*`; chạy tay = chỉ artifact). Tên file: `ViSUBLY-Setup-<ver>.exe`, `ViSUBLY-Portable-<ver>.exe`. `Install-ViSUBLY.cmd` (gốc repo) → `scripts/install-windows.ps1`: lấy release mới nhất qua GitHub API, kiểm tra SHA256, chạy bộ cài (`-DownloadOnly` để thử).
- Mở video trực tiếp từ Windows (Open with / app mặc định): bộ cài đăng ký `.mp4 .m4v .mkv .webm .mov`; app nhận đường dẫn lúc khởi động và khi đang chạy (single-instance), tự lấy các video cùng thư mục (không quét thư mục con) để bấm trước/sau; chọn nhiều file → thành playlist; mở `.srt/.vtt` → nạp vào video đang phát. Nút "Mở bằng trình phát khác" dùng hộp thoại Open with của Windows (tránh mở lại chính ViSUBLY).
- Remote iPhone (web/PWA qua Safari, cổng 3588): **ghép nối một lần** — quét QR (link một lần, đổi thành mã thiết bị rồi xoá token khỏi URL) hoặc bấm "Kết nối" trên điện thoại → PC hiện "Cho phép / Từ chối". Mỗi thiết bị có token 64 hex lưu cookie HttpOnly + localStorage trên máy điện thoại, PC lưu sha256 trong `user-data\remote-devices.json`; sống qua khởi động lại. Cài đặt → Remote iPhone: danh sách thiết bị, gỡ từng cái / tất cả, "Tự bật khi mở ViSUBLY" (`remoteAutoStart`, chỉ bật nếu đã có thiết bị). WebSocket `/ws` giờ bắt buộc token. Luồng PIN cũ (app Expo/Swift) vẫn chạy và cũng nhận token lâu dài.
- Giao diện mới: dark mode mặc định + light mode (chọn Tối/Sáng/Theo Windows), logo mới "Vi Screen".
- Bộ cài NSIS chuẩn (chọn thư mục, shortcut, gỡ cài đặt, tiếng Việt/Anh) + bản portable.

**Tạm tắt, hiển thị "Sắp có"**
- Phụ đề AI (Whisper/Claude/ChatGPT pipeline). Toàn bộ code demo giả đã bị xóa.

**Máy người dùng**
- App đã cài tại `E:\Visubly Studio`. Thư mục lưu video: `E:\`.
- Chrome nạp extension dạng *Load unpacked* từ `E:\Visubly Studio\resources\browser-extension\chrome`. Sửa nhanh extension có thể chép thẳng vào đây rồi bấm tải lại trong `chrome://extensions`; nhớ build lại bộ cài cho đồng bộ.

## 3. Kiến trúc

```
src/main/main.js            Electron main: cửa sổ, settings, hàng đợi tải, spawn engine, IPC, thông báo, single-instance
src/main/preload.js         window.visublyDesktop (API cho renderer)
src/main/capture-bridge.js  HTTP 127.0.0.1:47653(+1..3): /v1/ping, /v1/pair, /v1/capture, /v1/probe
src/main/airplay-server.js  Remote iPhone (express + ws + bonjour)
src/renderer/               index.html, theme-boot.js (áp theme trước khi vẽ), app.js (UI vanilla JS), styles.css, fonts.css
engine/downloader/          hls2mp4.py + hls2mp4_runner.py (bản copy từ D:\Projects\Extracting Video — nguồn gốc chỉ đọc) + fastdl.py (tải song song, của ViSUBLY; test: test_fastdl.py)
browser-extension/chrome/   MV3: background.js, lib/streams.js (gom nhóm, test được bằng Node), popup.*, content.js, app-client.js
build/                      icon.ico/png, installerSidebar.bmp, installerHeader.bmp
scripts/                    build-downloader.ps1, check-app.js, test-capture-bridge.js, test-extension-streams.mjs, after-pack.js
```

**Renderer** (`app.js`): vẽ lại toàn bộ bằng `innerHTML` nhưng **giữ nguyên phần tử `<video>`** (không tạo lại) để không giật/mất fullscreen — đừng phá cơ chế này (`render()`, `renderPlayerWhileFullscreen`, `patchPlayerStage`).

**Tải song song (fastdl.py, 1.2.2)**: một tiến trình `curl --parallel` (dùng lại kết nối) cho mọi đoạn HLS; playlist media được viết lại thành bản local (đoạn, `EXT-X-MAP`, khoá AES-128) rồi ffmpeg chỉ remux từ ổ đĩa; MP4 có Range → chia tối đa 16 phần (≥ 4 MB/phần), ghép lại, kiểm tra đủ byte. Config curl: **mỗi lượt tải một khối, ngăn bằng `next`** (`range` trong config phẳng là tuỳ chọn chung → mọi phần nhận Range cuối; đã dính lỗi này), header/cookie nằm trong file config (không lộ trên dòng lệnh). Lỗi → lượt 2 với ½ kết nối → lượt 3 với 1 kết nối → urllib (báo lỗi khi HTTP ≥ 400; `core.fetch_bytes` dùng curl không `--fail` nên sẽ lưu trang lỗi 404 như dữ liệu) → cuối cùng ffmpeg như cũ. Dừng lượt sớm khi 429/403/503 chiếm ≥ ¼; canh treo 45 s không có byte mới. Ưu tiên `System32\curl.exe`: curl 8.19 của Git treo khi `--parallel` + `--retry` gặp 429. Live / SAMPLE-AES / master → không dùng đường nhanh. Cờ `--no-fast` để tắt. Bench (server 2 MB/s mỗi kết nối, 8 kết nối): HLS .ts 1,3×, fMP4 2,6×, AES-128 5,1×, MP4 148 MB 7× (trùng từng byte).

**Dò video ẩn (sniff.js, extension 1.2.0)**: chạy trong JS world của trang (MAIN, document_start, mọi frame), **đăng ký động** bằng `chrome.scripting.registerContentScripts` (id `visubly-sniff`) để người dùng tắt được (công tắc cuối popup, `storage.local.sniffEnabled`, mặc định bật; tắt = huỷ đăng ký, áp dụng khi tải lại trang). Chỉ đọc: bọc fetch/XHR để nhận playlist theo nội dung (`#EXTM3U`, `<MPD`) khi URL/kiểu bị giấu, bắt DRM (EME) và MSE; gửi qua `postMessage` → content.js → background (`sniffed`/`drm`/`mse`). Background còn gán request của service worker (tabId -1) cho tab theo origin, xoá danh sách khi tải lại trang (`onBeforeRequest` main_frame) và có `diag` cho nút "Chẩn đoán".

**Content script extension**: chỉ chèn nút nổi sau `load` + 1.5 s + idle, gắn vào `<html>` (không vào `<body>`) — tránh làm sập trang Next.js/React đang hydrate.

**Popup extension**: chỉ `<main>` cuộn; `html, body { overflow: hidden }` vì Chrome giới hạn popup 600 px và thanh cuộn cửa sổ sẽ ăn mất lề phải.

### Dữ liệu & cài đặt
- Bản cài: `%APPDATA%\Visubly Studio\` → `user-data\settings.json`, `user-data\download-queue.json`, `user-data\capture-tokens.json` (token đã băm), `logs\main.log`.
- Dev (`npm start`): `.runtime/` trong repo. Ghi đè bằng `VISUBLY_RUNTIME_DIR`.
- Settings: `downloadDir`, `maxParallelDownloads` (1–3, mặc định 2), `segmentWorkers` (8), `notifyOnComplete`, `captureBridgeEnabled`, `captureBridgePort` (47653), `ignoreShortVideosSec` (0/30/60/120/300, mặc định 120), `theme` (`dark`|`light`|`system`).

### IPC (main.js)
`airplay:*`, `app:bootInfoSync|getInfo|diskSpace|openExtensionFolder|takeOpenFiles`, `capture:confirm|createPairingCode|dismiss|info|prepareManual|revokeAll`, `dialog:selectVideo|selectVideoFolder|selectSubtitle`, `download:getState|prepare|enqueue|start|cancel|retry|remove|clearCompleted|openOutput|revealOutput|openDir`, `file:exists|readText|readSubtitleText`, `media:toFileUrl|scanVideoFolder|findMatchingSubtitle|openInSystemPlayer`, `settings:get|update|selectDownloadDir`, `window:*`. Sự kiện đẩy xuống renderer: `download:state`, `download:event`, `capture:incoming`, `settings:changed`, `app:open-files`, `airplay:*`. `media:scanVideoFolder(path, {recursive})` — mặc định đệ quy (Thư viện); `recursive:false` khi mở file từ Windows.

**Mở file từ Windows**: `main.js` lấy đường dẫn từ `process.argv` / sự kiện `second-instance` (gom các lần mở cách nhau < 350 ms thành một lô), renderer kéo hàng chờ bằng `app:takeOpenFiles` khi khởi động rồi nghe `app:open-files`. Kiểm thử E2E: chạy `dist\win-unpacked\Visubly Studio.exe --remote-debugging-port=<p> "<file>"` với `VISUBLY_RUNTIME_DIR` riêng rồi đọc `state` qua CDP.

### Remote iPhone (airplay-server.js)
- `GET /` — có cookie/token thiết bị hợp lệ → trang Remote; `?token=<qrToken>` → cấp thiết bị mới, set cookie, redirect `/`; còn lại → trang "Kết nối với ViSUBLY".
- `POST /api/request-pairing {deviceName}` → `{requestId}` (5 lần/phút/IP, tối đa 3 đang chờ, hết hạn 2 phút); `GET /api/pairing-status?requestId=` → `pending|approved(+token, cookie)|denied|expired`; `POST /api/verify-pairing {pin}` (app cũ); `POST /api/session {token}` (khôi phục cookie từ localStorage); `/icon.png`, `/apple-touch-icon.png`.
- Xác thực: token thiết bị (query/path/cookie) hoặc `mediaToken` (chỉ dùng trong URL segment HLS, đổi mỗi lần start). `qrToken` chỉ đổi lấy thiết bị ở `/`.
- IPC: `airplay:respondPairing|listDevices|revokeDevice|revokeAllDevices`; sự kiện `airplay:pairing-requested {requestId, deviceName, pin}`, `pairing-resolved`, `pairing-success`, `devices-changed`. Cổng đổi được bằng `VISUBLY_REMOTE_PORT` (test).
- Lưu ý: regex trong trang Remote nằm trong template string của server → phải viết `\\s`, `\\d`, `\\.`.

### README media
Ảnh/GIF trong `docs/media/` được chụp từ **bản đóng gói với dữ liệu demo** (không dùng dữ liệu thật): `node scripts/readme-media/make-demo.js` (tạo clip "Wild Coast" + HLS 3 chất lượng bằng ffmpeg đi kèm) rồi `node scripts/readme-media/capture.js` (chạy `dist\win-unpacked` với runtime riêng ở `D:\ViSUBLY Demo`, điều khiển qua CDP, quay screencast → GIF, giả lập iPhone bằng Chrome headless; tự xoá thư mục demo). Cần build trước. Cửa sổ app sẽ hiện trên màn hình trong ~1–2 phút.

### Cổng nhận link (capture-bridge)
- Chỉ bind `127.0.0.1`; từ chối Origin không phải `chrome-extension://` và Host lạ; body ≤ 64 KB.
- `POST /v1/pair {code}` → token (mã 6 số dùng 1 lần, hạn 5 phút, giới hạn sai 5 lần/phút).
- `POST /v1/capture` (header `X-Visubly-Token`) payload `{url, type, headers{referer,origin,userAgent,cookie}, pageUrl, pageTitle, preferredVariantUrl?, preferredHeight?}`.
- `POST /v1/probe {url,type,headers}` → `{kind, variants[{url,height,resolution,bandwidth,estBytes}], durationSec, isLive, isShort}`; cache 10 phút, 2 probe song song, timeout 30 s, ≤ 3 req/s/client. Chỉ đọc playlist, không tải segment.

## 4. Build & kiểm tra

```powershell
npm.cmd install
npm.cmd run start                 # chạy dev
npm.cmd run check                 # kiểm tra nhanh renderer/main
node scripts/test-capture-bridge.js
node scripts/test-extension-streams.mjs
node scripts/test-remote-pairing.js      # ghép nối iPhone (cổng 3599, thư mục tạm)
node scripts/test-video-enhance.js       # nhận diện GPU + crash guard cho nâng chất lượng
node scripts/test-upscale-presets.js     # tab Nâng cấp video: khả năng, chọn tự động, kế hoạch, ước tính
npm run build:vendor                     # FFmpeg 8.1 + visubly-upscaler.exe vào vendor/ (cần .NET 10 SDK)
npm.cmd run package:win           # = build:engine (PyInstaller, cần Python ≥3.10 → .venv-build) + electron-builder
```
Kết quả: `dist\ViSUBLY-Setup-<ver>.exe` (~100 MB), `dist\ViSUBLY-Portable-<ver>.exe`, `dist\win-unpacked\`. Bản phát hành chính thức do GitHub Actions build khi push tag.

Lưu ý: Chrome 158 trên máy **không cho nạp extension qua dòng lệnh** → không tự động hoá test extension trong Chrome thật được; dùng `lib/streams.js` + Node, và render `popup.html` bằng Chrome headless với `chrome.*` giả. Headless dùng thanh cuộn overlay nên không thấy lỗi thanh cuộn kiểu Windows.

## 5. Thiết kế
- Logo (đã chọn **B+C · Vi Screen**): https://claude.ai/artifact/BVNex1AK4pWaAyVeohDDbq — SVG gốc: `src/renderer/assets/brand/visubly-logo.svg` (+ `-small.svg` cho ≤ 32 px).
- Mockup đã duyệt (Home, Downloads, hộp thoại Chrome, Settings, light mode): https://claude.ai/artifact/Vxs76MMJTDVdDLWfB5Vifz
- Token màu — Tối: nền `#0E0C12`, surface `#1A1620`, chữ `#F4F1EA`, nhấn lime `#D7FF61`, vàng `#F5C842`, mint `#7FE0C0`, đỏ `#FF7A6B`. Sáng: nền `#F2EFE8`, surface `#FFFDFA`, chữ/nhấn `#1A1620` (chữ lime trên nút), viền đen 1.5 px + bóng cứng 4 px. Font: Bricolage Grotesque / Geist / Geist Mono (nhúng sẵn).

## 6. Hạn chế đã biết & chưa kiểm chứng

- **Chưa kiểm chứng trên máy thật**: thông báo Windows khi tải xong; phím F11; file HEVC/MKV và âm thanh AC3 (có thể phát không tiếng mà không báo); màn hình thứ hai; nhiều trang web thật khác nhau.
- Không có **tạm dừng/tiếp tục** — engine không resume được (thư mục tạm bị xóa, ffmpeg không nối tiếp).
- MP4 không có thời lượng (không kèm ffprobe) → MP4 < 20 MB coi là video ngắn.
- Video trong iframe: nút nổi không biết video nào đang phát → chọn theo điểm.
- Một số trang chỉ lộ URL `blob:` → không bắt được. DRM không hỗ trợ (cố ý).
- Cookie của trang nằm trên dòng lệnh engine và lưu dạng thường trong `download-queue.json`.
- Exe chưa ký số → Windows SmartScreen cảnh báo; engine exe một file có thể bị antivirus nghi ngờ.
- Dung lượng hiển thị theo đơn vị nhị phân (112.5 MB → "~107 MB").
- Mỗi lần chạy engine mất thêm ~1 s (PyInstaller onefile).

## 7. Việc tiếp theo (đề xuất — mỗi mục cần kế hoạch + duyệt)

1. **Phụ đề AI** — nối pipeline của `D:\Projects\AI Gen Sub` (WhisperX + dịch) vào màn "Phụ đề AI"; đây là tính năng lớn nhất còn lại.
2. **Gộp `release/v1.0` vào `main`** (PR) sau khi người dùng dùng thử ổn định; quyết định số phiên bản tiếp theo.
3. **Tạm dừng/tiếp tục tải** — giữ segment tạm + manifest tiến độ trong engine.
4. **Bảo mật cookie** — truyền qua `--item-file` thay vì dòng lệnh; mã hoá header trong queue (DPAPI / `safeStorage`).
5. **Ký số code + tự cập nhật** (electron-updater; `latest.yml` đã được tạo khi build).
6. **Phát hành extension** lên Chrome Web Store (hiện là Load unpacked); popup theo dark mode.
7. **Bản Mac** (`npm run package:mac`, cần `.icns`) và **app iPhone** (`ViSUBLY_iOS_Source/`, `ViSUBLY_Expo_Source/` chưa được track; app Expo đang dùng ở `D:\Projects\ViSUBLY-Expo` vẫn đi luồng PIN — nên chuyển sang luồng chờ "Cho phép" qua `/api/pairing-status`). Người dùng hiện chủ yếu dùng **bản web** trên Safari.
8. Kèm **ffprobe** để có thời lượng MP4 / tiến độ % chính xác hơn.
9. Dọn repo: quyết định `ViSUBLY_Expo_Source/` và `download-queue.json` ở gốc (track hay thêm vào `.gitignore`).

## 8. Lịch sử commit Giai đoạn 1 (cũ → mới)

```
304b7b8 WIP snapshot before v1.0 revamp
732935c Add Chrome capture extension and localhost capture bridge
4babfea Vendor downloader engine and add PyInstaller build script
4698c6f Make main process install-ready: data paths, settings, engine, capture
68b99fa Package 1.0.0 with standard assisted NSIS installer and portable build
0d892f2 Apply new Vi Screen logo to app, installer and extension icons
1974284 Fix video player bugs and rework fullscreen/theater overlay controls
49fd70b Add theme setting, manual capture prepare and new desktop IPCs
79996b0 Redesign renderer: dark/light tokens, new Home, Downloads, dialog, Settings
fce39cb Polish downloads header, finished-row meta and pairing refresh
c7bb92a Fix extension crashing Next.js/React sites on load
88cd850 Fix downloads failing when the download folder is a drive root
c9482c7 Probe browser streams in the app: variants, duration, live, previews
45bb8e5 Capture dialog: duration, size per quality, preselected quality
a9218c8 Extension 1.1.0: one card per video with qualities, hide previews
29ffede Use the Vi Screen logo in the extension popup header
3f34521 Fix extension popup losing its right margin when the list is long
cf7de4d Disable the popup download button while qualities are loading
```
