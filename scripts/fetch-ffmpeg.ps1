<#
  Downloads the FFmpeg 8.1 Windows build that ViSUBLY bundles (BtbN FFmpeg-Builds, GPL, shared DLLs)
  into vendor/ffmpeg: ffmpeg.exe, ffprobe.exe, the DLLs and the license. Used by the downloader,
  the iPhone Remote and the video upscale tab (libplacebo, cas, sr_amf, NVENC/AMF/QSV).
  Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.

  The archive is verified against the SHA-256 digest GitHub reports for the release asset.
  BtbN prunes old autobuilds, so if the pinned tag is gone it falls back to the rolling
  "latest" build of the same FFmpeg branch (still digest-verified) and says so.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1 [-Force]
#>
param(
  [string]$Tag = "autobuild-2026-11-24-12-41",
  [string]$AssetPattern = '^ffmpeg-n8\.1.*-win64-gpl-shared-8\.1\.zip$',
  [switch]$Force
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Hashing and unzipping use .NET directly: when Windows PowerShell 5.1 is started from PowerShell 7
# (GitHub Actions "shell: pwsh" -> npm -> powershell), it inherits PS7's module path and the
# script-based cmdlets Get-FileHash / Expand-Archive are missing.
function Get-Sha256([string]$path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($path)
  try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace "-", "").ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root "vendor\ffmpeg"
$cache = Join-Path $root "vendor\cache"
$stamp = Join-Path $dest "BUILD.txt"

if (-not $Force -and (Test-Path (Join-Path $dest "ffmpeg.exe")) -and (Test-Path $stamp)) {
  Write-Host "FFmpeg already in vendor\ffmpeg ($((Get-Content $stamp -TotalCount 1)))."
  exit 0
}

$headers = @{ "User-Agent" = "ViSUBLY-build"; "Accept" = "application/vnd.github+json" }
if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $($env:GITHUB_TOKEN)" }
$repoApi = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases"

function Get-Release([string]$name) {
  try { return Invoke-RestMethod -Uri "$repoApi/tags/$name" -Headers $headers }
  catch { return $null }
}

$release = Get-Release $Tag
$usedTag = $Tag
if (-not $release) {
  Write-Warning "Pinned FFmpeg build '$Tag' is no longer published; using BtbN 'latest' (8.1 branch)."
  $release = Get-Release "latest"
  $usedTag = "latest"
}
if (-not $release) { throw "Could not reach the BtbN FFmpeg-Builds releases." }

$asset = $release.assets | Where-Object { $_.name -match $AssetPattern } | Select-Object -First 1
if (-not $asset) { throw "No asset matching $AssetPattern in release $usedTag." }
if (-not ($asset.digest -match '^sha256:([0-9a-f]{64})$')) { throw "Release asset $($asset.name) has no SHA-256 digest to verify against." }
$expected = $Matches[1]

New-Item -ItemType Directory -Force $cache | Out-Null
$zip = Join-Path $cache $asset.name
if (-not (Test-Path $zip) -or ((Get-Sha256 $zip) -ne $expected)) {
  Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing -Headers @{ "User-Agent" = "ViSUBLY-build" }
}
$actual = Get-Sha256 $zip
if ($actual -ne $expected) {
  Remove-Item $zip -Force
  throw "SHA-256 mismatch for $($asset.name): expected $expected, got $actual."
}

$extract = Join-Path $cache "ffmpeg-extract"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $extract)
$top = Get-ChildItem $extract -Directory | Select-Object -First 1
$bin = Join-Path $top.FullName "bin"

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $bin "ffmpeg.exe"), (Join-Path $bin "ffprobe.exe") $dest
Get-ChildItem $bin -Filter *.dll | Copy-Item -Destination $dest
$license = Get-ChildItem $top.FullName -Filter "LICENSE*" | Select-Object -First 1
if ($license) { Copy-Item $license.FullName (Join-Path $dest "FFMPEG-LICENSE.txt") }
Remove-Item $extract -Recurse -Force

# ASCII only: read back by build scripts and shown in About.
@(
  "$usedTag $($asset.name)",
  "sha256 $expected",
  "source https://github.com/BtbN/FFmpeg-Builds/releases/tag/$usedTag",
  "FFmpeg source code: https://ffmpeg.org/download.html (GPL v3 build)"
) | Set-Content -Path $stamp -Encoding ASCII

$size = (Get-ChildItem $dest | Measure-Object Length -Sum).Sum
$version = (& (Join-Path $dest "ffmpeg.exe") -hide_banner -version | Select-Object -First 1)
Write-Host "FFmpeg ready in vendor\ffmpeg: $([math]::Round($size / 1MB, 1)) MB - $version"
