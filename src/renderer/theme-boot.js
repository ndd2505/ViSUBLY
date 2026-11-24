"use strict";

// Runs in <head> before the stylesheets paint: pick dark/light from the saved setting
// (exposed synchronously by the preload) so the window never flashes the wrong theme.
(function applyBootTheme() {
  let mode = "dark";
  try {
    const boot = window.visublyDesktop && window.visublyDesktop.boot;
    if (boot && ["dark", "light", "system"].includes(boot.theme)) mode = boot.theme;
  } catch {
    // Outside Electron: keep the dark default.
  }
  let resolved = mode;
  if (mode === "system") {
    try {
      resolved = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch {
      resolved = "dark";
    }
  }
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
})();
