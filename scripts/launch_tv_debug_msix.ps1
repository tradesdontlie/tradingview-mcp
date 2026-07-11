<#
.SYNOPSIS
    Launch TradingView Desktop (MSIX/Store install) with Chrome DevTools Protocol enabled.

.DESCRIPTION
    On modern Windows, TradingView ships as an MSIX package installed under
    C:\Program Files\WindowsApps. Two common approaches FAIL on such builds:
      * Running the exe directly from WindowsApps  -> "Access is denied"
      * Copying the package elsewhere and running it -> exits with 0x80000003
        (STATUS_BREAKPOINT) because the loose copy has no MSIX package identity.

    The reliable method is Invoke-CommandInDesktopPackage, which launches the real
    packaged exe WITH its package identity AND forwards command-line arguments.

.PARAMETER Port
    CDP port to expose. Default 9222.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\launch_tv_debug_msix.ps1
    powershell -ExecutionPolicy Bypass -File scripts\launch_tv_debug_msix.ps1 -Port 9333
#>
param(
    [int]$Port = 9222
)

$ErrorActionPreference = 'Stop'

# --- Resolve the installed MSIX package (no admin required) ---
$pkg = Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction SilentlyContinue
if (-not $pkg) {
    Write-Error "TradingView.Desktop MSIX package not found. Is TradingView Desktop installed?"
    exit 1
}

$pfn = $pkg.PackageFamilyName
$manifest = Get-AppxPackageManifest $pkg
$app = $manifest.Package.Applications.Application | Select-Object -First 1
$appId = $app.Id
$exe = Join-Path $pkg.InstallLocation $app.Executable

Write-Host "Package : $pfn"
Write-Host "AppId   : $appId"
Write-Host "Exe     : $exe"
Write-Host "Port    : $Port"

# --- If CDP is already up, don't relaunch ---
try {
    $existing = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 -ErrorAction Stop
    Write-Host "CDP already available on port $Port ($($existing.Browser)). Nothing to do."
    exit 0
} catch { }

# --- Launch with package identity + forwarded debug-port flag ---
Write-Host "Launching TradingView with --remote-debugging-port=$Port ..."
Invoke-CommandInDesktopPackage -PackageFamilyName $pfn -AppId $appId `
    -Command $exe -Args "--remote-debugging-port=$Port"

# --- Poll until the CDP endpoint responds ---
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    try {
        $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3 -ErrorAction Stop
        Write-Host ""
        Write-Host "CDP ready at http://127.0.0.1:$Port"
        Write-Host "  Browser: $($v.Browser)"
        Write-Host "  WS: $($v.webSocketDebuggerUrl)"
        $ready = $true
        break
    } catch {
        Start-Sleep -Seconds 3
    }
}

if (-not $ready) {
    Write-Error "TradingView launched but CDP never became available on port $Port after ~60s."
    exit 1
}
