<#
  Builds tools/upscaler into vendor/upscaler/visubly-upscaler.exe (self-contained single file, .NET 10, win-x64).
  The app ships it as resources/upscaler/visubly-upscaler.exe for the video upscale tab.
  Requires the .NET 10 SDK. Keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less scripts as ANSI).
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root "tools\upscaler\VisublyUpscaler.csproj"
$out = Join-Path $root "vendor\upscaler"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw "The .NET SDK (10.x) is required to build the upscaler helper." }
if (Test-Path $out) { Remove-Item $out -Recurse -Force }

& dotnet publish $project -c Release -r win-x64 --self-contained true -o $out -nologo -v q
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE." }

# Keep only the executable: single-file publish may still drop debug or config files next to it.
Get-ChildItem $out | Where-Object { $_.Name -ne "visubly-upscaler.exe" } | Remove-Item -Recurse -Force
$exe = Join-Path $out "visubly-upscaler.exe"
if (-not (Test-Path $exe)) { throw "visubly-upscaler.exe was not produced." }
Write-Host ("Upscaler ready: {0} ({1:N1} MB)" -f $exe, ((Get-Item $exe).Length / 1MB))
