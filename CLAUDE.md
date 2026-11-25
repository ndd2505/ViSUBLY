# ViSUBLY (Visubly Studio)

Electron desktop app (Windows first, Mac/iPhone later) for grabbing videos (HLS/MP4/DASH) from the browser like IDM, playing them with subtitles, and later generating Vietnamese AI subtitles. A Chrome MV3 extension (`browser-extension/chrome`) sends detected streams to the app over a paired localhost bridge.

**Read `docs/HANDOFF.md` first.** It covers the current state, architecture, IPC and bridge APIs, build and test commands, known limitations and the backlog.

## Rules
- Reply to the user in Vietnamese.
- For any non-trivial request, present a phased plan and wait for approval before editing code. Read-only investigation is fine.
- After app code changes, rebuild the Windows package: `npm.cmd run package:win` (it also runs `build:vendor`: FFmpeg 8.1 + `visubly-upscaler.exe` into `vendor/`, needs the .NET 10 SDK). Dev runs (`npm start`) need `npm run build:vendor` once.
- Never kill processes you did not start. Never commit `ViSUBLY_Expo_Source/` or the root `download-queue.json`.
- PowerShell 5.1: commit with `git commit -F <message-file>`; stage explicit paths only.
- Never rewrite UTF-8 files with PowerShell 5.1 `Get-Content`/`Set-Content` (reads as ANSI, adds a BOM and garbles Vietnamese text). Use the Edit tool or Node `fs`.
- Don't delete or move pushed git tags; if a release tag's build fails, fix it and release the next patch version.
- `D:\Projects\Extracting Video` is read-only source; the engine copy lives in `engine/downloader/`.
- Keep the renderer's `<video>` element alive across re-renders (see HANDOFF §3).
- GPU features (VSR, NVENC, Vulkan filters) only work outside the Claude Code sandbox: run GPU tests with the sandbox disabled.
- Nothing drawn over the video may use `backdrop-filter` or `mix-blend-mode`: it switches RTX Video Super Resolution off (HANDOFF, live enhancement).
