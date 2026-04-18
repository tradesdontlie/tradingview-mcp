@echo off
setlocal
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled
REM Handles both standalone (%LOCALAPPDATA%\TradingView) and MSIX / Microsoft
REM Store installs under %PROGRAMFILES%\WindowsApps.
REM Usage: scripts\launch_tv_debug.bat [port]

set "PORT=%1"
if "%PORT%"=="" set "PORT=9222"

REM Kill existing TradingView instances
taskkill /F /IM TradingView.exe >nul 2>&1
REM Use ping as a sleep — works in both cmd.exe and cmd-under-bash
ping -n 3 127.0.0.1 >nul

REM --- Detect install ------------------------------------------------------
set "TV_EXE="
set "TV_IS_MSIX="

REM 1) Standard Electron installer locations
if exist "%LOCALAPPDATA%\TradingView\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\TradingView\TradingView.exe"
if not defined TV_EXE if exist "%PROGRAMFILES%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES%\TradingView\TradingView.exe"
if not defined TV_EXE if exist "%PROGRAMFILES(x86)%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES(x86)%\TradingView\TradingView.exe"

REM 2) MSIX / Store install — WindowsApps is ACL-protected so `dir` and
REM    direct `start` both fail. Use PowerShell Get-AppxPackage instead.
if not defined TV_EXE (
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-AppxPackage -Name '*TradingView*' | Select-Object -First 1 -ExpandProperty InstallLocation) 2>$null"`) do (
        if exist "%%i\TradingView.exe" (
            set "TV_EXE=%%i\TradingView.exe"
            set "TV_IS_MSIX=1"
        )
    )
)

REM 3) PATH fallback
if not defined TV_EXE (
    for /f "usebackq delims=" %%i in (`where TradingView.exe 2^>nul`) do set "TV_EXE=%%i"
)

if not defined TV_EXE (
    echo Error: TradingView not found.
    echo Checked: %%LOCALAPPDATA%%\TradingView, %%PROGRAMFILES%%\TradingView, WindowsApps ^(Get-AppxPackage^), PATH
    echo.
    echo If installed elsewhere, run manually:
    echo   "C:\path\to\TradingView.exe" --remote-debugging-port=%PORT%
    exit /b 1
)

echo Found TradingView at: %TV_EXE%
if defined TV_IS_MSIX echo Install type: MSIX / Microsoft Store

REM --- Launch --------------------------------------------------------------
REM cmd's `start` fails on WindowsApps exes with "Access is denied" because
REM the AppContainer loader requires MSIX activation. PowerShell Start-Process
REM uses ShellExecute, which activates the package correctly and preserves
REM argv (including --remote-debugging-port). Use it for MSIX installs;
REM standard installs also work fine via the same path, so use it always.
echo Starting with --remote-debugging-port=%PORT%...
powershell -NoProfile -Command "Start-Process -FilePath '%TV_EXE%' -ArgumentList '--remote-debugging-port=%PORT%'"
if errorlevel 1 (
    echo Error: Failed to launch TradingView via PowerShell Start-Process.
    exit /b 1
)

REM --- Wait for CDP --------------------------------------------------------
echo Waiting for CDP to become available...
ping -n 6 127.0.0.1 >nul

set /a WAIT_ATTEMPTS=0
:check
curl -s http://localhost:%PORT%/json/version >nul 2>&1
if %errorlevel% neq 0 (
    set /a WAIT_ATTEMPTS+=1
    if %WAIT_ATTEMPTS% geq 30 (
        echo.
        echo Error: CDP did not come up on port %PORT% within ~65s.
        echo If you just installed TradingView, open it once manually, sign in,
        echo then re-run this script.
        exit /b 1
    )
    echo Still waiting... ^(%WAIT_ATTEMPTS%/30^)
    ping -n 3 127.0.0.1 >nul
    goto check
)

echo.
echo CDP ready at http://localhost:%PORT%
curl -s http://localhost:%PORT%/json/version
echo.
endlocal
