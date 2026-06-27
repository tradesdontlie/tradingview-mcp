<#
Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled.

Handles two install flavors:
  1. Standalone installer build — launched directly with --remote-debugging-port=<port>
  2. Microsoft Store (MSIX) build — launched via IApplicationActivationManager so
     command-line args reach the Electron main process (shell:AppsFolder\ and
     ELECTRON_EXTRA_LAUNCH_ARGS don't propagate through MSIX activation).

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch_tv_debug.ps1 [-Port 9222]
#>
[CmdletBinding()]
param(
  [int]$Port = 9222
)

$ErrorActionPreference = 'Stop'

# ----- Kill any existing TradingView processes (both builds share exe names) -----
Get-Process -Name 'TradingView' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# ----- 1. Try standalone installer locations -----
$installerPaths = @(
  (Join-Path $env:LOCALAPPDATA 'TradingView\TradingView.exe'),
  (Join-Path $env:ProgramFiles 'TradingView\TradingView.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'TradingView\TradingView.exe')
)
$tvExe = $installerPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($tvExe) {
  Write-Host "Found TradingView installer build at: $tvExe"
  Write-Host "Starting with --remote-debugging-port=$Port..."
  Start-Process -FilePath $tvExe -ArgumentList "--remote-debugging-port=$Port"
}
else {
  # ----- 2. Fall back to Microsoft Store (MSIX) build via COM activation -----
  Write-Host 'Standalone install not found. Looking for Microsoft Store build...'

  $app = (Get-StartApps).Where({ $_.Name -eq 'TradingView' }) | Select-Object -First 1
  if (-not $app) {
    Write-Host ''
    Write-Host 'Error: TradingView not found.'
    Write-Host '  Checked standalone paths:'
    $installerPaths | ForEach-Object { Write-Host "    $_" }
    Write-Host '  Also checked Start menu via Get-StartApps for an app named "TradingView".'
    Write-Host ''
    Write-Host 'If installed elsewhere, launch manually:'
    Write-Host "  `"C:\path\to\TradingView.exe`" --remote-debugging-port=$Port"
    exit 1
  }

  Write-Host "Found Microsoft Store build: $($app.AppID)"

  # IApplicationActivationManager is the documented Windows API for launching
  # packaged apps with command-line arguments. It's the same API the Start
  # menu uses, and unlike shell:AppsFolder\... it actually passes argv through
  # to the app's main process.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
  int ActivateApplication(
    [In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
    [In, MarshalAs(UnmanagedType.LPWStr)] string arguments,
    [In] int options,
    [Out] out uint processId);
}

public static class PackagedLauncher {
  public static uint Launch(string appId, string args) {
    Guid clsid = new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C");
    Type t = Type.GetTypeFromCLSID(clsid, true);
    var mgr = (IApplicationActivationManager)System.Activator.CreateInstance(t);
    uint pid;
    int hr = mgr.ActivateApplication(appId, args, 0, out pid);
    if (hr != 0) throw new System.ComponentModel.Win32Exception(hr);
    return pid;
  }
}
'@ -ErrorAction SilentlyContinue

  $pid2 = [PackagedLauncher]::Launch($app.AppID, "--remote-debugging-port=$Port")
  Write-Host "Activated PID=$pid2 with --remote-debugging-port=$Port"
}

# ----- Poll until CDP is reachable -----
Write-Host "Waiting for CDP to become available on port $Port..."
Start-Sleep -Seconds 3

# NB: probe 127.0.0.1 rather than "localhost". On Windows, "localhost" resolves
# to ::1 first, but Chromium's DevTools listener only binds IPv4 by default —
# Invoke-WebRequest does not fall back across address families, so it would
# spin on connection-refused for the full retry window even after CDP is up.
for ($i = 1; $i -le 20; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2
    Write-Host ''
    Write-Host "CDP ready at http://127.0.0.1:$Port"
    Write-Host $r.Content
    exit 0
  }
  catch {
    Write-Host "Still waiting... retry $i/20"
    Start-Sleep -Seconds 2
  }
}

Write-Host ''
Write-Host "Error: CDP did not become available on port $Port after ~40s."
Write-Host 'If TradingView is showing a login screen, finish logging in and re-run this script.'
exit 2
