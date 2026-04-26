# Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled.
# Handles both classic Win32 installs and MSIX/UWP (Microsoft Store) installs.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\launch_tv_debug.ps1 [-Port 9222]

param([int]$Port = 9222)

$ErrorActionPreference = "Stop"

function Test-Cdp {
    param([int]$Port)
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2
        return $r.StatusCode -eq 200
    } catch { return $false }
}

Get-Process -Name "TradingView*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$classic = @(
    "$env:LOCALAPPDATA\TradingView\TradingView.exe",
    "$env:PROGRAMFILES\TradingView\TradingView.exe",
    "${env:PROGRAMFILES(x86)}\TradingView\TradingView.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($classic) {
    Write-Host "Found classic install: $classic"
    Start-Process -FilePath $classic -ArgumentList "--remote-debugging-port=$Port"
} else {
    $pkg = Get-AppxPackage -Name "TradingView.Desktop" -ErrorAction SilentlyContinue
    if (-not $pkg) {
        Write-Error "TradingView not found. Install from tradingview.com/desktop or Microsoft Store."
        exit 1
    }
    $manifest = [xml](Get-Content (Join-Path $pkg.InstallLocation "AppxManifest.xml"))
    $appId = $manifest.Package.Applications.Application.Id
    $aumid = "$($pkg.PackageFamilyName)!$appId"
    Write-Host "Found MSIX install. AUMID: $aumid"

    # MSIX activation does not accept CLI args via .exe launch, but a .lnk
    # whose TargetPath is shell:AppsFolder\<AUMID> forwards Arguments correctly.
    $lnk = Join-Path $env:TEMP "TV_Debug_$Port.lnk"
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnk)
    $sc.TargetPath = "shell:AppsFolder\$aumid"
    $sc.Arguments = "--remote-debugging-port=$Port"
    $sc.Save()
    Start-Process -FilePath $lnk
}

Write-Host "Waiting for CDP on port $Port..."
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    if (Test-Cdp -Port $Port) {
        Write-Host "CDP ready at http://127.0.0.1:$Port"
        Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing | Select-Object -ExpandProperty Content
        exit 0
    }
    Start-Sleep -Seconds 1
}
Write-Error "CDP did not come up within 30s."
exit 1
