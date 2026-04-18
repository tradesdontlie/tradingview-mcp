# =====================================================
#  TradingView Desktop MSIX Debug Launcher (helper)
#  Used by src/core/health.js -> launch() on Windows
#  when TradingView is installed as an MSIX package
#  (Program Files\WindowsApps\), which blocks direct
#  .exe invocation with --remote-debugging-port=<port>.
#
#  Launches via IApplicationActivationManager, the
#  official Microsoft COM API for activating packaged
#  apps with arguments.
#
#  Emits a single-line JSON result to stdout.
# =====================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Aumid,

    [Parameter(Mandatory = $false)]
    [int]$Port = 9222
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class TVLauncher {
    [ComImport]
    [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IApplicationActivationManager {
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            int options,
            out uint processId);
    }

    [ComImport]
    [Guid("45ba127d-10a8-46ea-8ab7-56ea9078943c")]
    public class ApplicationActivationManager { }

    public static uint Launch(string aumid, string args) {
        var mgr = (IApplicationActivationManager)new ApplicationActivationManager();
        uint pid = 0;
        int hr = mgr.ActivateApplication(aumid, args, 0, out pid);
        if (hr != 0) {
            throw new Exception("HRESULT=0x" + hr.ToString("X8"));
        }
        return pid;
    }
}
"@

try {
    $launchedPid = [TVLauncher]::Launch($Aumid, "--remote-debugging-port=$Port")
    $result = [ordered]@{
        success = $true
        pid     = [int]$launchedPid
        aumid   = $Aumid
        port    = $Port
    }
    $result | ConvertTo-Json -Compress
    exit 0
}
catch {
    $err = [ordered]@{
        success = $false
        error   = $_.Exception.Message
        aumid   = $Aumid
    }
    $err | ConvertTo-Json -Compress
    exit 1
}
