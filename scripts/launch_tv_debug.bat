@echo off
setlocal enabledelayedexpansion
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled
REM Handles both classic installs and Windows Store / MSIX installs.
REM Usage: scripts\launch_tv_debug.bat [port]

set PORT=%1
if "%PORT%"=="" set PORT=9222

REM Auto-detect TradingView install location
set "TV_EXE="

REM 1. Check common classic install locations
if exist "%LOCALAPPDATA%\TradingView\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES(x86)%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES(x86)%\TradingView\TradingView.exe"

REM 2. MSIX / Windows Store install -- query AppX (dir on WindowsApps is access-denied)
if "%TV_EXE%"=="" (
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$p=Get-AppxPackage -Name '*TradingView*'; if($p){Join-Path $p[0].InstallLocation 'TradingView.exe'}"`) do set "TV_EXE=%%i"
)

REM 3. Last resort: PATH lookup
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('where TradingView.exe 2^>nul') do set "TV_EXE=%%i"
)

if "%TV_EXE%"=="" (
    echo Error: TradingView not found.
    echo Checked: %%LOCALAPPDATA%%\TradingView, %%PROGRAMFILES%%\TradingView, WindowsApps ^(MSIX^), PATH
    echo.
    echo If installed elsewhere, run manually:
    echo   "C:\path\to\TradingView.exe" --remote-debugging-port=%PORT%
    exit /b 1
)

echo Found TradingView at: !TV_EXE!

REM MSIX apps can respawn themselves without the debug flag on first launch,
REM so retry the kill-then-launch cycle until CDP actually binds the port.
set MAX_ATTEMPTS=3
for /l %%a in (1,1,%MAX_ATTEMPTS%) do (
    echo.
    echo Attempt %%a of %MAX_ATTEMPTS%: killing existing instances...
    taskkill /F /IM TradingView.exe >nul 2>&1
    REM ping instead of timeout: timeout fails under redirected stdin
    ping -n 4 127.0.0.1 >nul

    echo Starting with --remote-debugging-port=%PORT%...
    start "" "!TV_EXE!" --remote-debugging-port=%PORT%

    echo Waiting for CDP on port %PORT% ...
    set "CDP_UP="
    for /l %%w in (1,1,10) do (
        ping -n 3 127.0.0.1 >nul
        curl -s http://localhost:%PORT%/json/version >nul 2>&1
        if !errorlevel! equ 0 (
            set "CDP_UP=1"
            goto :ready
        )
    )
    echo CDP did not come up on attempt %%a, retrying...
)

echo.
echo Error: CDP never became available on port %PORT% after %MAX_ATTEMPTS% attempts.
echo TradingView may have respawned without the debug flag. Try running this script again.
exit /b 1

:ready
echo.
echo CDP ready at http://localhost:%PORT%
curl -s http://localhost:%PORT%/json/version
echo.
endlocal
