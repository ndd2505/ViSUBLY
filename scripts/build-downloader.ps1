<#
.SYNOPSIS
  Builds engine/downloader/hls2mp4_runner.py into dist-engine/visubly-downloader.exe with PyInstaller.

.DESCRIPTION
  - Finds Python 3.10+ (VISUBLY_PYTHON, then `py -3`, then `python`, then the per-user Python 3.12 install).
  - Creates/reuses a local virtualenv in .venv-build (gitignored) and installs PyInstaller there.
  - Produces a one-file console exe (the app spawns it hidden) and smoke-tests `prepare`.
#>
[CmdletBinding()]
param(
  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$venvDir = Join-Path $root ".venv-build"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$runner = Join-Path $root "engine\downloader\hls2mp4_runner.py"
$engineSrc = Join-Path $root "engine\downloader"
$distDir = Join-Path $root "dist-engine"
$workDir = Join-Path $venvDir "pyinstaller-work"
$icon = Join-Path $root "build\icon.ico"
$exe = Join-Path $distDir "visubly-downloader.exe"

function Invoke-Checked {
  param([string]$File, [string[]]$Arguments)
  # Windows PowerShell 5.1 can turn native stderr (pip/PyInstaller progress) into terminating errors under "Stop".
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $File @Arguments
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($code -ne 0) { throw "Command failed ($code): $File $($Arguments -join ' ')" }
}

function Test-PythonCandidate {
  param([string]$File, [string[]]$Prefix)
  try {
    $version = & $File @Prefix -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $version) { return $false }
    $parts = "$version".Trim().Split(".")
    return ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 10)
  } catch {
    return $false
  }
}

function Find-BasePython {
  $candidates = @()
  if ($env:VISUBLY_PYTHON) { $candidates += , @($env:VISUBLY_PYTHON, @()) }
  $candidates += , @("py", @("-3"))
  $candidates += , @("python", @())
  $candidates += , @((Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"), @())
  foreach ($candidate in $candidates) {
    if (Test-PythonCandidate -File $candidate[0] -Prefix $candidate[1]) { return $candidate }
  }
  throw "Python 3.10+ not found. Install Python or set VISUBLY_PYTHON to python.exe."
}

if (-not (Test-Path $runner)) { throw "Runner not found: $runner" }

if (-not (Test-Path $venvPython)) {
  $base = Find-BasePython
  Write-Host "Creating build venv with: $($base[0]) $($base[1] -join ' ')"
  Invoke-Checked -File $base[0] -Arguments ($base[1] + @("-m", "venv", $venvDir))
}

Write-Host "Installing PyInstaller into .venv-build ..."
Invoke-Checked -File $venvPython -Arguments @("-m", "pip", "install", "--disable-pip-version-check", "--quiet", "pyinstaller>=6.3,<7")

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$pyiArgs = @(
  "-m", "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onefile",
  "--console",
  "--name", "visubly-downloader",
  "--distpath", $distDir,
  "--workpath", $workDir,
  "--specpath", $workDir,
  "--paths", $engineSrc,
  "--hidden-import", "hls2mp4",
  "--hidden-import", "fastdl"
)
if (Test-Path $icon) { $pyiArgs += @("--icon", $icon) }
$pyiArgs += $runner

Write-Host "Building $exe ..."
Invoke-Checked -File $venvPython -Arguments $pyiArgs
if (-not (Test-Path $exe)) { throw "PyInstaller did not produce $exe" }

if (-not $SkipVerify) {
  Write-Host "Verifying engine with a dummy prepare ..."
  $verifyDir = Join-Path $workDir "verify"
  New-Item -ItemType Directory -Force -Path $verifyDir | Out-Null
  $ErrorActionPreference = "Continue"
  $output = "https://example.invalid/visubly-check/master.m3u8" | & $exe prepare --source-stdin --type m3u8 --no-preflight -o (Join-Path $verifyDir "check.mp4")
  $ErrorActionPreference = "Stop"
  $events = @()
  foreach ($line in $output) {
    try { $events += ($line | ConvertFrom-Json) } catch { }
  }
  if (-not $events.Count) { throw "Engine produced no JSON events. Raw output: $output" }
  $names = ($events | ForEach-Object { $_.event }) -join ", "
  Write-Host "Engine emitted JSON events: $names"
}

$sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "OK: $exe ($sizeMb MB)"
