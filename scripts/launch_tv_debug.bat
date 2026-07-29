@echo off
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled.
REM Usage: scripts\launch_tv_debug.bat [port]
REM
REM Self-contained MSIX handling: if TradingView is a Windows Store / MSIX install,
REM a direct launch from WindowsApps is blocked (EPERM) or its debug port never
REM binds. In that case this script copies the package once into
REM %LOCALAPPDATA%\tradingview-mcp\<pkg> and launches CDP from that plain copy -
REM the same fallback the tv_launch MCP tool performs (see src/core/health.js).

set PORT=%1
if "%PORT%"=="" set PORT=9222

REM Kill existing TradingView instances
call :kill_tv

REM Auto-detect TradingView install location
set "TV_EXE="

REM Check common install locations
if exist "%LOCALAPPDATA%\TradingView\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES(x86)%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES(x86)%\TradingView\TradingView.exe"

REM Check MSIX / Windows Store installs.
REM Get-AppxPackage resolves the install without elevation; enumerating
REM %PROGRAMFILES%\WindowsApps with dir requires admin rights, so keep it as a fallback.
if "%TV_EXE%"=="" (
    for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "(Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction SilentlyContinue).InstallLocation" 2^>nul`) do (
        if exist "%%i\TradingView.exe" set "TV_EXE=%%i\TradingView.exe"
    )
)
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('dir /s /b "%PROGRAMFILES%\WindowsApps\TradingView*\TradingView.exe" 2^>nul') do set "TV_EXE=%%i"
)
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('where TradingView.exe 2^>nul') do set "TV_EXE=%%i"
)

if "%TV_EXE%"=="" (
    echo Error: TradingView not found.
    echo Checked: %%LOCALAPPDATA%%\TradingView, %%PROGRAMFILES%%\TradingView, WindowsApps
    echo.
    echo If installed elsewhere, run manually:
    echo   "C:\path\to\TradingView.exe" --remote-debugging-port=%PORT%
    exit /b 1
)

echo Found TradingView at: %TV_EXE%

REM Detect a WindowsApps (MSIX) install so we know a local-copy fallback is available.
set "IS_MSIX="
echo %TV_EXE% | find /i "\WindowsApps\" >nul && set "IS_MSIX=1"

REM Resolve where a local copy would live (computed at top level so each SET is
REM visible to the next line; harmless for non-MSIX installs, which never use it).
for %%I in ("%TV_EXE%") do set "SRC_DIR=%%~dpI"
if "%SRC_DIR:~-1%"=="\" set "SRC_DIR=%SRC_DIR:~0,-1%"
for %%I in ("%SRC_DIR%") do set "PKG_NAME=%%~nxI"
set "CACHE_ROOT=%LOCALAPPDATA%\tradingview-mcp"
set "DST_DIR=%CACHE_ROOT%\%PKG_NAME%"
set "DST_EXE=%DST_DIR%\TradingView.exe"

REM Repeat launches: a valid local copy already exists, so skip the doomed
REM direct WindowsApps attempt and launch straight from the copy.
if defined IS_MSIX if exist "%DST_EXE%" (
    echo Reusing existing local copy at %DST_DIR%
    goto launch_copy
)

REM --- Attempt 1: launch directly --------------------------------------------
echo Starting with --remote-debugging-port=%PORT%...
start "" "%TV_EXE%" --remote-debugging-port=%PORT%
call :wait_cdp 15
if "%CDP_OK%"=="1" goto ready

if not defined IS_MSIX (
    echo.
    echo Error: TradingView is running but CDP never became available on port %PORT%.
    exit /b 1
)

REM --- Attempt 2: MSIX local-copy fallback -----------------------------------
echo.
echo Direct WindowsApps launch did not expose CDP ^(MSIX sandbox^).
echo Falling back to a local copy outside WindowsApps...

if not exist "%DST_EXE%" (
    REM Remove stale copies of other TradingView versions first.
    if exist "%CACHE_ROOT%" (
        for /d %%D in ("%CACHE_ROOT%\TradingView.*") do (
            if /i not "%%~nxD"=="%PKG_NAME%" rmdir /s /q "%%D"
        )
    )
    echo Copying package ^(~330MB, one time^) to %DST_DIR% ...
    robocopy "%SRC_DIR%" "%DST_DIR%" /E /NP /NFL /NDL /NJH /NJS >nul
    REM robocopy exit codes 0-7 are success; 8+ indicate a real failure.
    if errorlevel 8 (
        echo Error: failed to copy package to %DST_DIR%.
        exit /b 1
    )
) else (
    echo Reusing existing local copy at %DST_DIR%
)

:launch_copy
call :kill_tv
echo Launching from local copy: %DST_EXE%
start "" "%DST_EXE%" --remote-debugging-port=%PORT%
call :wait_cdp 20
if "%CDP_OK%"=="1" (
    set "TV_EXE=%DST_EXE%"
    goto ready
)

echo.
echo Error: CDP never became available on port %PORT%, even from the local copy.
echo If this persists, try the tv_launch MCP tool or launch manually:
echo   "%DST_EXE%" --remote-debugging-port=%PORT%
exit /b 1

REM --- Success ---------------------------------------------------------------
:ready
echo.
echo CDP ready at http://127.0.0.1:%PORT%
echo Binary: %TV_EXE%
curl -s http://127.0.0.1:%PORT%/json/version
echo.
exit /b 0

REM --- Subroutines -----------------------------------------------------------

REM Kill any running TradingView and give the OS a moment to release the port.
REM (ping -n is used for waits throughout: timeout /t aborts when stdin is redirected)
:kill_tv
taskkill /F /IM TradingView.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul
exit /b 0

REM Poll the CDP version endpoint until it responds. %1 = max attempts.
REM Sets CDP_OK=1 on success, 0 on timeout.
REM Use 127.0.0.1 rather than localhost: on some machines localhost resolves to
REM IPv6 ::1, which Electron's debug server does not listen on.
:wait_cdp
set CDP_OK=0
set MAXTRIES=%1
if "%MAXTRIES%"=="" set MAXTRIES=15
echo Waiting for CDP to become available...
ping -n 6 127.0.0.1 >nul
set TRIES=0
:wait_cdp_loop
curl -s http://127.0.0.1:%PORT%/json/version >nul 2>&1
if %errorlevel% equ 0 (
    set CDP_OK=1
    exit /b 0
)
set /a TRIES+=1
if %TRIES% geq %MAXTRIES% exit /b 0
echo Still waiting...
ping -n 3 127.0.0.1 >nul
goto wait_cdp_loop
