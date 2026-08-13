<#
.SYNOPSIS
Launch TradingView Desktop on Windows with the Chrome DevTools Protocol enabled.

.DESCRIPTION
Handles both install shapes:

  classic install (LOCALAPPDATA / Program Files) -> run the exe with the flag directly
  MSIX / Microsoft Store install                 -> COM-activate the package with the
                                                    flag (see activate_msix.ps1)

The debug port does not survive an app restart, so this has to be re-run whenever
TradingView is started normally — a Start-menu launch produces a running chart with
no debug port, which looks identical to a working one until a tool fails.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\launch_tv_debug.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\launch_tv_debug.ps1 -Port 9333
#>
[CmdletBinding()]
param(
    [int]$Port = 9222,
    # Leave a running instance alone. Electron's single-instance lock means the flag
    # will NOT be applied if an instance is already up, so this usually only makes
    # sense when you know the running instance already has the port open.
    [switch]$KeepExisting
)

$ErrorActionPreference = 'Stop'

function Find-ClassicExe {
    $candidates = @(
        "$env:LOCALAPPDATA\TradingView\TradingView.exe",
        "$env:ProgramFiles\TradingView\TradingView.exe",
        "${env:ProgramFiles(x86)}\TradingView\TradingView.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return $null
}

if (-not $KeepExisting) {
    $running = @(Get-Process -Name TradingView -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        Write-Host "Stopping $($running.Count) running TradingView process(es)..."
        $running | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
    }
}

$classic = Find-ClassicExe
if ($classic) {
    Write-Host "Found classic install: $classic"
    Write-Host "Starting with --remote-debugging-port=$Port ..."
    Start-Process -FilePath $classic -ArgumentList "--remote-debugging-port=$Port"
} else {
    $pkg = Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction SilentlyContinue
    if (-not $pkg) {
        Write-Error @"
TradingView not found.
Checked: %LOCALAPPDATA%\TradingView, %ProgramFiles%\TradingView, and the
TradingView.Desktop MSIX package.

If it is installed elsewhere, launch it manually with:
  & "C:\path\to\TradingView.exe" --remote-debugging-port=$Port
"@
        exit 1
    }
    Write-Host "Found MSIX package: $($pkg.PackageFamilyName) (v$($pkg.Version))"
    Write-Host "Activating with --remote-debugging-port=$Port ..."
    $activate = Join-Path $PSScriptRoot 'activate_msix.ps1'
    $result = & $activate -Port $Port | ConvertFrom-Json
    Write-Host "Activated pid $($result.pid) via $($result.aumid)"
}

# 127.0.0.1 rather than localhost: on some machines localhost resolves to IPv6 ::1
# first, and Electron's debug server only listens on IPv4.
Write-Host "Waiting for CDP on port $Port ..."
$deadline = (Get-Date).AddSeconds(45)
$version = $null
while ((Get-Date) -lt $deadline) {
    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
        break
    } catch { Start-Sleep -Seconds 2 }
}

if (-not $version) {
    Write-Error @"
TradingView is running but CDP never became available on port $Port.
Some Windows MSIX builds accept the flag without ever binding the port. Use the
tv_launch MCP tool, which falls back to launching from a local copy of the package.
"@
    exit 1
}

Write-Host ""
Write-Host "CDP ready at http://127.0.0.1:$Port"
Write-Host "  Browser: $($version.Browser)"
Write-Host "  Agent  : $($version.'User-Agent')"
