# launch_chrome_cdp.ps1
# Starts a dedicated Chrome instance with the Chrome DevTools Protocol enabled,
# pointed at the TradingView web chart, for the tradingview-mcp server to connect to.
#
# Why Chrome and not TradingView Desktop: on Windows, TradingView ships only as an
# MSIX package, which blocks the --remote-debugging-port flag (see project issues
# #14/#42/#75/#81). The MCP server only needs a CDP target whose URL matches
# tradingview.com/chart -- the page exposes the same window.TradingViewApi whether
# it runs in the Electron Desktop shell or in Chrome, so every MCP tool works the same.
#
# Usage:  pwsh -File scripts\launch_chrome_cdp.ps1            (defaults below)
#         pwsh -File scripts\launch_chrome_cdp.ps1 -Port 9223

param(
    [int]$Port = 9222,
    [string]$ProfileDir = "$env:LOCALAPPDATA\tradingview-cdp-profile",
    [string]$Url = "https://www.tradingview.com/chart/"
)

$ErrorActionPreference = "Stop"

# Returns the /json/version payload if a CDP endpoint is live on $port, else $null.
# Uses 127.0.0.1, NOT "localhost": Chrome binds the debug port to IPv4 only, and when
# "localhost" resolves to ::1 first, Invoke-WebRequest stalls ~2s per probe before
# falling back to IPv4 -- enough to blow a short timeout and never detect a live CDP.
function Get-CdpVersion([int]$port) {
    try {
        return (Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 2).Content
    } catch {
        # Connection refused / timeout => CDP not up. Caller treats $null as "not live".
        return $null
    }
}

# Locate a Chromium browser (Chrome preferred, Edge as fallback).
$browser = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $browser) {
    Write-Error "No Chromium browser found (looked for Chrome and Edge)."
    exit 1
}

# If CDP is already live on this port, do nothing.
$live = Get-CdpVersion $Port
if ($live) {
    Write-Host "CDP already live on port $Port :" -ForegroundColor Green
    Write-Host $live
    exit 0
}

# An isolated --user-data-dir is REQUIRED: modern Chrome ignores --remote-debugging-port
# when run against the default profile.
New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null

$browserName = [System.IO.Path]::GetFileName($browser)
Write-Host "Launching $browserName with CDP on port $Port ..." -ForegroundColor Cyan
# No immediate-exit check here: on Windows the chrome.exe that Start-Process launches is a
# bootstrap that exits (code 0) once the real browser is up, so "process exited" can't be
# told apart from success. The CDP poll below is the only reliable readiness signal.
Start-Process -FilePath $browser -ArgumentList @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$ProfileDir",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    $Url
)

Write-Host "Waiting for CDP endpoint " -NoNewline
# First run is slower: Chrome has to initialize a fresh --user-data-dir profile.
# Subsequent runs hit the "already live" early-exit above and return instantly.
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
    $live = Get-CdpVersion $Port
    if ($live) {
        Write-Host " ready." -ForegroundColor Green
        Write-Host $live
        Write-Host ""
        Write-Host "First run only: log in to TradingView in the window that just opened." -ForegroundColor Yellow
        Write-Host "The session persists in the isolated profile: $ProfileDir"
        exit 0
    }
    Start-Sleep -Milliseconds 750
    Write-Host "." -NoNewline
}
Write-Host ""
Write-Error "CDP did not come up on port $Port within 45s. Chrome may still be starting, or the profile '$ProfileDir' is already open elsewhere without CDP -- re-run this script to re-check."
exit 1
