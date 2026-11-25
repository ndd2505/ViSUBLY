## Install (Windows 10/11)

1. Download **`ViSUBLY-Setup-x.y.z.exe`** below and run it. If you cloned the repo, double-clicking **`Install-ViSUBLY.cmd`** does the same: it downloads and checks the latest installer, then runs it.
2. The installer isn't code-signed yet. If Windows shows *"Windows protected your PC"*, click **More info → Run anyway**.
3. Install the Chrome extension: in ViSUBLY open **Cài đặt → Kết nối Chrome → Mở thư mục extension** (Settings → Connect Chrome → Open extension folder). Then in Chrome go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, select that folder, and enter the 6-digit code shown in the app.

Prefer not to install? Use **`ViSUBLY-Portable-x.y.z.exe`**.

Check the downloads against **`SHA256SUMS.txt`**:
`Get-FileHash .\ViSUBLY-Setup-x.y.z.exe -Algorithm SHA256`

See the [README](https://github.com/ndd2505/ViSUBLY#readme) for features and screenshots.
