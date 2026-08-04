# Launch an MSIX/Microsoft Store app with command-line arguments via COM
# activation (IApplicationActivationManager).
#
# Why: TradingView.exe under C:\Program Files\WindowsApps cannot be started
# directly (spawn fails with EPERM/"Access is denied"), and running a copy of
# the package outside its MSIX context crashes 3.3.0+ with "bridge-not-loaded"
# (~12s after start; see %APPDATA%\TradingView\logs). COM activation launches
# the app full-trust inside its package context, forwards the arguments, and
# CDP binds within ~2 seconds.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File activate_msix.ps1 `
#     [-PackageName TradingView.Desktop] [-Arguments "--remote-debugging-port=9222"]
#
# Prints the launched process ID on success; exits non-zero on failure.

param(
    [string]$PackageName = 'TradingView.Desktop',
    [string]$Arguments = '--remote-debugging-port=9222'
)

$ErrorActionPreference = 'Stop'

$pkg = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue
if (-not $pkg) {
    Write-Error "MSIX package '$PackageName' is not installed."
    exit 1
}

# AUMID = PackageFamilyName + "!" + Application Id from AppxManifest.xml.
# TradingView's manifest uses <Application Id="TradingView.Desktop">, so the
# package name doubles as the fallback if the manifest can't be read.
$appId = $PackageName
try {
    [xml]$manifest = Get-Content (Join-Path $pkg.InstallLocation 'AppxManifest.xml')
    $firstApp = @($manifest.Package.Applications.Application) | Select-Object -First 1
    if ($firstApp -and $firstApp.Id) { $appId = $firstApp.Id }
} catch { }

$aumid = "$($pkg.PackageFamilyName)!$appId"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace TvMcp
{
    public enum ActivateOptions
    {
        None = 0x0,
        DesignMode = 0x1,
        NoErrorUI = 0x2,
        NoSplashScreen = 0x4
    }

    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IApplicationActivationManager
    {
        IntPtr ActivateApplication([In] string appUserModelId, [In] string arguments,
            [In] ActivateOptions options, [Out] out uint processId);
        IntPtr ActivateForFile([In] string appUserModelId, [In] IntPtr itemArray,
            [In] string verb, [Out] out uint processId);
        IntPtr ActivateForProtocol([In] string appUserModelId, [In] IntPtr itemArray,
            [Out] out uint processId);
    }

    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    public class ApplicationActivationManager : IApplicationActivationManager
    {
        [MethodImpl(MethodImplOptions.InternalCall, MethodCodeType = MethodCodeType.Runtime)]
        public extern IntPtr ActivateApplication([In] string appUserModelId, [In] string arguments,
            [In] ActivateOptions options, [Out] out uint processId);
        [MethodImpl(MethodImplOptions.InternalCall, MethodCodeType = MethodCodeType.Runtime)]
        public extern IntPtr ActivateForFile([In] string appUserModelId, [In] IntPtr itemArray,
            [In] string verb, [Out] out uint processId);
        [MethodImpl(MethodImplOptions.InternalCall, MethodCodeType = MethodCodeType.Runtime)]
        public extern IntPtr ActivateForProtocol([In] string appUserModelId, [In] IntPtr itemArray,
            [Out] out uint processId);
    }
}
'@

$manager = New-Object TvMcp.ApplicationActivationManager
$procId = [uint32]0
[void]$manager.ActivateApplication($aumid, $Arguments, [TvMcp.ActivateOptions]::None, [ref]$procId)
$procId
