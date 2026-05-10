@echo off
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled
REM Usage: scripts\launch_tv_debug.bat [port]

set PORT=%1
if "%PORT%"=="" set PORT=9222

REM Kill existing TradingView instances
taskkill /F /IM TradingView.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM Auto-detect TradingView install location
set "TV_EXE="

REM Check common install locations
if exist "%LOCALAPPDATA%\TradingView\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES(x86)%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES(x86)%\TradingView\TradingView.exe"

REM Check MSIX / Windows Store installs via where
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('where TradingView.exe 2^>nul') do set "TV_EXE=%%i"
)

REM If still not found, try MSIX launch via COM ApplicationActivationManager (handles WindowsApps ACL restriction)
if "%TV_EXE%"=="" (
    echo TradingView.exe not found in standard paths. Attempting MSIX launch via COM...
    powershell -NoProfile -NonInteractive -Command "$code='using System; using System.Runtime.InteropServices; namespace AppLauncher { [ComImport,Guid(\"2e941141-7f97-4756-ba1d-9decde894a3d\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IApplicationActivationManager { int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string a,[MarshalAs(UnmanagedType.LPWStr)] string b,int c,out uint d); int ActivateForFile(string a,IntPtr b,string c,out uint d); int ActivateForProtocol(string a,IntPtr b,out uint c); } [ComImport,Guid(\"45BA127D-10A8-46EA-8AB7-56EA9078943C\"),ClassInterface(ClassInterfaceType.None)] public class AppActMgr {} public static class Launcher { public static int Launch(string aumid,string args,out uint pid){var m=(IApplicationActivationManager)new AppActMgr();return m.ActivateApplication(aumid,args,0,out pid);} } }'; Add-Type -TypeDefinition $code; $p=[uint32]0; $hr=[AppLauncher.Launcher]::Launch('TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop','--remote-debugging-port=%PORT%',[ref]$p); if($hr -eq 0){Write-Output \"MSIX launch OK PID=$p\"}else{Write-Output \"MSIX launch failed HRESULT=0x$($hr.ToString(\"X8\"))\"}"
    goto :wait_cdp
)

echo Found TradingView at: %TV_EXE%
echo Starting with --remote-debugging-port=%PORT%...
start "" "%TV_EXE%" --remote-debugging-port=%PORT%

:wait_cdp
echo Waiting for CDP to become available...
timeout /t 5 /nobreak >nul

:check
curl -s http://localhost:%PORT%/json/version >nul 2>&1
if %errorlevel% neq 0 (
    echo Still waiting...
    timeout /t 2 /nobreak >nul
    goto check
)

echo.
echo CDP ready at http://localhost:%PORT%
curl -s http://localhost:%PORT%/json/version
echo.
