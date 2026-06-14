# TradingView MCP Launcher
# Run this once to start TradingView with CDP enabled for Claude MCP

# 1. Check loopback exemption (needed for UWP app to allow localhost CDP)
$loopback = CheckNetIsolation.exe LoopbackExempt -s 2>$null
if ($loopback -notmatch "tradingview") {
    Write-Host "Adding loopback exemption (needs admin)..." -ForegroundColor Yellow
    Start-Process "CheckNetIsolation.exe" -ArgumentList "LoopbackExempt -a -n=TradingView.Desktop_n534cwy3pjxzj" -Verb RunAs -Wait
}

# 2. Kill any existing TradingView
$existing = Get-Process -Name "TradingView" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Closing existing TradingView..." -ForegroundColor Yellow
    Start-Process "taskkill" -ArgumentList "/F /IM TradingView.exe" -Verb RunAs -Wait
    Start-Sleep -Seconds 2
}

# 3. Launch TradingView in user session with CDP on port 9222
Write-Host "Launching TradingView with CDP..." -ForegroundColor Cyan
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace AppLaunch {
    [ComImport][Guid("2e941141-7f97-4756-ba1d-9decde894a3d")][InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IApplicationActivationManager {
        int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, int options, out uint processId);
        int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string x, IntPtr y, [MarshalAs(UnmanagedType.LPWStr)] string z, out uint pid);
        int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string x, IntPtr y, out uint pid);
    }
    [ComImport][Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    public class AppActMgr {}
    public static class Launcher {
        public static uint Launch(string aumid, string args) {
            var mgr = (IApplicationActivationManager)new AppActMgr();
            uint procId = 0;
            mgr.ActivateApplication(aumid, args, 0, out procId);
            return procId;
        }
    }
}
"@ -ErrorAction Stop

$procId = [AppLaunch.Launcher]::Launch("TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop", "--remote-debugging-port=9222")
Write-Host "TradingView launched (PID: $procId)" -ForegroundColor Green

# 4. Wait for CDP to be ready
Write-Host "Waiting for CDP to be ready..." -ForegroundColor Cyan
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:9222/json" -TimeoutSec 2 -ErrorAction Stop
        Write-Host "CDP ready on port 9222!" -ForegroundColor Green
        Write-Host "TradingView MCP is ready. Start Claude Code and use the tradingview tools." -ForegroundColor Green
        break
    } catch {}
    Write-Host "  waiting... ($($i+1)s)" -ForegroundColor Gray
}
