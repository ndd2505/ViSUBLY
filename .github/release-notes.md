## What's new in 1.2 (1.2.1)

- **Nâng cấp video (Upscale video) tab.** Turn a 360p / 480p video into a sharper 720p–4K copy, one video at a time.
  - Uses RTX Video Super Resolution on NVIDIA RTX cards, and GPU filters on any PC.
  - Picks the best setup for your PC automatically and shows live GPU / CPU / disk stats.
  - Lets you test a short clip with a before/after slider first.
  - Asks before closing while a video is being upscaled.
- Bundles **FFmpeg 8.1** (also used by the downloader and the iPhone Remote).

## Install (Windows 10/11)

1. Download **`ViSUBLY-Setup-x.y.z.exe`** below and run it. If you cloned the repo, double-clicking **`Install-ViSUBLY.cmd`** does the same: it downloads and checks the latest installer, then runs it.
2. The installer isn't code-signed yet. If Windows shows *"Windows protected your PC"*, click **More info → Run anyway**.
3. Install the Chrome extension: in ViSUBLY open **Cài đặt → Kết nối Chrome → Mở thư mục extension** (Settings → Connect Chrome → Open extension folder). Then in Chrome go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, select that folder, and enter the 6-digit code shown in the app.

Prefer not to install? Use **`ViSUBLY-Portable-x.y.z.exe`**.

Check the downloads against **`SHA256SUMS.txt`**:
`Get-FileHash .\ViSUBLY-Setup-x.y.z.exe -Algorithm SHA256`

See the [README](https://github.com/ndd2505/ViSUBLY#readme) for features and screenshots.
