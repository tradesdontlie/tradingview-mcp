# Launch TradingView Desktop (Windows MSIX build) with CDP remote debugging enabled.
# Usage: scripts\launch_tv_debug_msix.ps1 [port]
#
# Why this exists: on current Windows MSIX builds, running TradingView.exe directly
# from WindowsApps (or launch_tv_debug.bat's `start` call) fails with "Access is
# denied", and copying the package out to a writable directory launches but crashes
# immediately (exit code -2147483645 / STATUS_BREAKPOINT) because the app loses its
# MSIX package identity. See https://github.com/tradesdontlie/tradingview-mcp/issues/42
#
# The fix is to activate the app through Windows' IApplicationActivationManager COM
# API by its AUMID (Application User Model ID) instead of launching the exe. This is
# the same mechanism Explorer/Start Menu use to launch packaged apps, so it preserves
# package identity, and it still accepts a custom command-line argument string.

param(
    [int]$Port = 9222
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager
{
    [PreserveSig]
    int ActivateApplication(
        [In] string appUserModelId,
        [In] string arguments,
        [In] int options,
        out uint processId);
}

[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
public class ApplicationActivationManagerClass { }

public static class TvActivator
{
    public static int Activate(string aumid, string args, out uint processId)
    {
        var aam = (IApplicationActivationManager)new ApplicationActivationManagerClass();
        return aam.ActivateApplication(aumid, args, 0, out processId);
    }
}
"@

$pkg = Get-AppxPackage -Name "TradingView.Desktop"
if (-not $pkg) {
    Write-Error "TradingView.Desktop package not found. Is it installed?"
    exit 1
}

$manifestPath = Join-Path $pkg.InstallLocation "AppxManifest.xml"
[xml]$manifest = Get-Content $manifestPath
$appId = $manifest.Package.Applications.Application.Id
$aumid = "$($pkg.PackageFamilyName)!$appId"
Write-Output "AUMID: $aumid"

$processId = 0
$hr = [TvActivator]::Activate($aumid, "--remote-debugging-port=$Port", [ref]$processId)

if ($hr -eq 0) {
    Write-Output "Activated OK. ProcessId: $processId"
} else {
    Write-Output ("ActivateApplication failed. HRESULT: 0x{0:X8}" -f $hr)
    Write-Output "If this fails with an access/permission error, try enabling Windows Developer Mode"
    Write-Output "(Settings > Privacy & security > For developers) and re-run."
    exit 1
}

Write-Output "Waiting for CDP on port $Port..."
$tries = 0
do {
    Start-Sleep -Seconds 3
    $tries++
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2
        Write-Output "CDP ready after $tries tries:"
        Write-Output $resp.Content
        exit 0
    } catch {
        Write-Output "Try $tries : not ready yet"
    }
} while ($tries -lt 20)

Write-Output "CDP never became available after activation."
exit 1
