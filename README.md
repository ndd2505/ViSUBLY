# Visubly Studio Desktop

Desktop shell for the Visubly video download and Vietnamese subtitle workflow.

The current implementation is UI-complete with dummy data:

- Custom Windows/macOS-style desktop window chrome.
- Intro animation, dashboard, download batch wizard, queue progress, subtitle setup, five-step AI pipeline, approval review, and player screens.
- Stub integration points in `src/main/preload.js` and `src/main/main.js` for real download/subtitle engines later.

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
