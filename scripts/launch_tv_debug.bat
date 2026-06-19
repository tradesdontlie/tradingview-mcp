@echo off
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled
REM Usage: scripts\launch_tv_debug.bat [port]

set PORT=%1
if "%PORT%"=="" set PORT=9222

REM Kill existing TradingView instances
taskkill /F /IM TradingView.exe >nul 2>&1
REM ping-based delay (timeout fails when stdin is redirected, e.g. under PowerShell)
ping -n 3 127.0.0.1 >nul

REM Auto-detect TradingView install location
set "TV_EXE="

REM Check common install locations
if exist "%LOCALAPPDATA%\TradingView\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES(x86)%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES(x86)%\TradingView\TradingView.exe"

REM Check MSIX / Windows Store installs.
REM WindowsApps is access-protected, so `dir` listing fails — query the package
REM directly via Get-AppxPackage instead.
if "%TV_EXE%"=="" (
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-AppxPackage *TradingView*).InstallLocation"`) do set "TV_EXE=%%i\TradingView.exe"
)
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('where TradingView.exe 2^>nul') do set "TV_EXE=%%i"
)

if "%TV_EXE%"=="" (
    echo Error: TradingView not found.
    echo Checked: %%LOCALAPPDATA%%\TradingView, %%PROGRAMFILES%%\TradingView, WindowsApps ^(MSIX^)
    echo.
    echo If installed elsewhere, run manually:
    echo   "C:\path\to\TradingView.exe" --remote-debugging-port=%PORT%
    exit /b 1
)

echo Found TradingView at: %TV_EXE%
echo Starting with --remote-debugging-port=%PORT%...
start "" "%TV_EXE%" --remote-debugging-port=%PORT%

echo Waiting for CDP to become available...
ping -n 6 127.0.0.1 >nul

:check
curl -s http://localhost:%PORT%/json/version >nul 2>&1
if %errorlevel% neq 0 (
    echo Still waiting...
    ping -n 3 127.0.0.1 >nul
    goto check
)

echo.
echo CDP ready at http://localhost:%PORT%
curl -s http://localhost:%PORT%/json/version
echo.
