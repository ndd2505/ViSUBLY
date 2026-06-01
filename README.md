# Visubly Studio Desktop

Desktop shell for the Visubly video download and Vietnamese subtitle workflow.

The current implementation is UI-complete and the download flow is wired to the
local `Extracting Video` runner:

- Custom Windows/macOS-style desktop window chrome.
- Intro animation, dashboard, download batch wizard, queue progress, subtitle setup, five-step AI pipeline, approval review, and player screens.
- Real download queue integration in `src/main/main.js`, exposed through `src/main/preload.js`.
- The subtitle engine is still stubbed behind the same integration bridge.

## Download integration

By default the app expects the downloader at:

```text
D:\Projects\Extracting Video\hls2mp4_runner.py
```

Override paths with environment variables when needed:

```powershell
$env:VISUBLY_EXTRACTING_VIDEO_DIR="D:\Projects\Extracting Video"
$env:VISUBLY_PYTHON="C:\Users\ADMIN\AppData\Local\Programs\Python\Python312\python.exe"
npm run start
```

The renderer prepares each item through the preload bridge, then the main
process persists the queue in `.runtime/user-data/download-queue.json`.
Downloads run through `hls2mp4_runner.py download --item-file ...` and stream
JSON events into the UI:

- `phase`: preflight, segment download, ffmpeg download, or TS-to-MP4 muxing.
- `progress`: percent, speed, ETA, and segment counters.
- `done` / `failed`: terminal item status.

The queue supports single-item and batch usage through the same flow, with
cancel, retry, remove, resume, and per-item terminal logs.

## AirPlay remote

The iPhone/PWA remote is served by the local AirPlay server in
`src/main/airplay-server.js`. While a remote WebSocket, direct video stream,
HLS playlist, HLS segment, or HLS transcode is active, the Electron main process
starts a `powerSaveBlocker` in `prevent-app-suspension` mode so the stream does
not drop mid-session while the display is still allowed to sleep. After activity
stops, the blocker stays active for a short grace period.

Override the idle grace window when testing:

```powershell
$env:VISUBLY_AIRPLAY_AWAKE_GRACE_MS="30000"
npm run start
```

For debugging on a TV/desk setup where the display must stay on too:

```powershell
$env:VISUBLY_AIRPLAY_KEEP_DISPLAY_AWAKE="1"
npm run start
```

## Run

```bash
npm install
npm run start
```

## Package

```bash
npm run package:win
npm run package:mac
```

Packaging requires the normal Electron Builder platform requirements for the target OS.
