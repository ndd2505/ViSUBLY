@echo off
rem Double-click to download the latest ViSUBLY release, verify it and run the installer.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1" %*
if errorlevel 1 (
  echo.
  echo Installation did not start. See the message above.
  pause
)
endlocal
