<#
.SYNOPSIS
  Downloads the latest ViSUBLY installer from GitHub Releases, verifies its SHA256 and runs it.
  Started by Install-ViSUBLY.cmd (double-click) in the repo root.

.PARAMETER DownloadOnly
  Download and verify, but don't start the installer (used for testing).

.PARAMETER Repo
  owner/name of the GitHub repo. Defaults to this clone's "origin" remote, else ndd2505/ViSUBLY.
#>
[CmdletBinding()]
param(
  [switch]$DownloadOnly,
  [string]$Repo = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is much faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step($text) { Write-Host "  > $text" -ForegroundColor Cyan }

if (-not $Repo) {
  $Repo = "ndd2505/ViSUBLY"
  try {
    $origin = (git -C $PSScriptRoot remote get-url origin 2>$null)
    if ($origin -match "github\.com[:/](?<repo>[^/]+/[^/.]+?)(\.git)?$") { $Repo = $Matches.repo }
  } catch { }
}

Write-Host ""
Write-Host "  ViSUBLY installer" -ForegroundColor Green
Write-Host "  Repo: $Repo"
Write-Host ""

$headers = @{ "User-Agent" = "ViSUBLY-Installer"; "Accept" = "application/vnd.github+json" }
try {
  Write-Step "Finding the latest release..."
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers
} catch {
  Write-Host "  No published release found for $Repo yet." -ForegroundColor Yellow
  Write-Host "  Open https://github.com/$Repo/releases or build from source (see README)."
  exit 1
}

$setup = $release.assets | Where-Object { $_.name -like "ViSUBLY-Setup-*.exe" } | Select-Object -First 1
$sums = $release.assets | Where-Object { $_.name -eq "SHA256SUMS.txt" } | Select-Object -First 1
if (-not $setup) {
  Write-Host "  Release $($release.tag_name) has no ViSUBLY-Setup-*.exe asset." -ForegroundColor Yellow
  exit 1
}

$dir = Join-Path $env:TEMP "ViSUBLY-Install"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$target = Join-Path $dir $setup.name

Write-Step ("Downloading {0} ({1:N0} MB) from {2}..." -f $setup.name, ($setup.size / 1MB), $release.tag_name)
Invoke-WebRequest -Uri $setup.browser_download_url -OutFile $target -Headers @{ "User-Agent" = "ViSUBLY-Installer" } -UseBasicParsing

if ($sums) {
  Write-Step "Verifying SHA256..."
  $sumsText = (Invoke-WebRequest -Uri $sums.browser_download_url -Headers @{ "User-Agent" = "ViSUBLY-Installer" } -UseBasicParsing).Content
  if ($sumsText -is [byte[]]) { $sumsText = [Text.Encoding]::UTF8.GetString($sumsText) }
  $expected = ($sumsText -split "`r?`n" | Where-Object { $_ -match ("\s" + [regex]::Escape($setup.name) + "$") } | Select-Object -First 1) -replace "\s.*$", ""
  $actual = (Get-FileHash $target -Algorithm SHA256).Hash.ToLower()
  if (-not $expected) {
    Write-Host "  Checksum for $($setup.name) not listed; skipping verification." -ForegroundColor Yellow
  } elseif ($expected.Trim().ToLower() -ne $actual) {
    Remove-Item $target -Force -ErrorAction SilentlyContinue
    throw "SHA256 mismatch for $($setup.name). The download was removed; please try again."
  } else {
    Write-Step "Checksum OK ($actual)"
  }
} else {
  Write-Host "  No SHA256SUMS.txt in this release; skipping verification." -ForegroundColor Yellow
}

if ($DownloadOnly) {
  Write-Host "  Downloaded: $target" -ForegroundColor Green
  exit 0
}

Write-Step "Starting the installer..."
Write-Host "  If Windows shows 'Windows protected your PC', click More info -> Run anyway." -ForegroundColor Yellow
Start-Process -FilePath $target
