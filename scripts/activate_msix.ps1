<#
.SYNOPSIS
Activate an MSIX-packaged TradingView with command-line arguments (e.g. the CDP debug port).

.DESCRIPTION
MSIX/Store apps installed under C:\Program Files\WindowsApps cannot be launched the
usual ways with arguments:

  - running the exe directly       -> "Access is denied" (WindowsApps ACLs allow
                                      execution only through package activation)
  - explorer.exe shell:AppsFolder  -> activates, but provides no way to pass arguments
  - Invoke-CommandInDesktopPackage -> fails with ERROR_CANCELLED (0x800704C7) on some
                                      builds, elevated or not

IApplicationActivationManager::ActivateApplication is the activation path that does
forward an argument string, and for a Windows.FullTrustApplication entry point those
arguments land on the exe's command line.

Does NOT kill an existing instance and does NOT wait for CDP — Electron's
single-instance lock means activating while an instance is running just focuses the
existing window, so the caller is responsible for stopping it first.
See launch_tv_debug.ps1 for the full kill/activate/verify flow.

.OUTPUTS
One line of JSON: {"pid":<int>,"aumid":"<string>","arguments":"<string>"}

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -STA -File scripts\activate_msix.ps1 -Port 9222
#>
[CmdletBinding()]
param(
    [int]$Port = 9222,
    [string]$PackageName = 'TradingView.Desktop',
    [string]$Arguments
)

$ErrorActionPreference = 'Stop'

# COM activation requires an STA thread. powershell.exe is STA by default, but a
# caller may have started us with -MTA (or invoked us from a runspace that is MTA),
# so re-enter with -STA rather than failing confusingly.
if ([Threading.Thread]::CurrentThread.GetApartmentState() -eq 'MTA') {
    $self = $MyInvocation.MyCommand.Path
    $reArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', $self,
                '-Port', $Port, '-PackageName', $PackageName)
    if ($Arguments) { $reArgs += @('-Arguments', $Arguments) }
    & powershell.exe @reArgs
    exit $LASTEXITCODE
}

if (-not $Arguments) { $Arguments = "--remote-debugging-port=$Port" }

$pkg = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue
if (-not $pkg) {
    throw "MSIX package '$PackageName' is not installed for user $env:USERNAME. Run Get-AppxPackage to list installed packages."
}

# AUMID = <PackageFamilyName>!<Application Id from the manifest>. The family name is
# version-independent, so this keeps working across app updates (unlike InstallLocation,
# which carries the version number).
$app = (Get-AppxPackageManifest $pkg).Package.Applications.Application | Select-Object -First 1
if (-not $app -or -not $app.Id) {
    throw "Could not read an Application Id from the manifest of '$PackageName'."
}
$aumid = "$($pkg.PackageFamilyName)!$($app.Id)"

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MsixActivator
{
    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    private class ApplicationActivationManager { }

    [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        int ActivateApplication(
            [In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [In, MarshalAs(UnmanagedType.LPWStr)] string arguments,
            [In] uint options,
            [Out] out uint processId);
    }

    public static uint Activate(string aumid, string arguments)
    {
        var mgr = (IApplicationActivationManager)new ApplicationActivationManager();
        uint pid;
        int hr = mgr.ActivateApplication(aumid, arguments, 0 /* AO_NONE */, out pid);
        if (hr != 0) { Marshal.ThrowExceptionForHR(hr); }
        return pid;
    }
}
'@

$activatedPid = [MsixActivator]::Activate($aumid, $Arguments)

[pscustomobject]@{
    pid       = [int]$activatedPid
    aumid     = $aumid
    arguments = $Arguments
} | ConvertTo-Json -Compress
