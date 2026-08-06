@echo off
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled
REM Usage: scripts\launch_tv_debug.bat [port]

set PORT=%1
if "%PORT%"=="" set PORT=9222

REM Kill existing TradingView instances
REM (ping -n is used for waits throughout: timeout /t aborts when stdin is redirected)
taskkill /F /IM TradingView.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul

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
echo Starting with --remote-debugging-port=%PORT%...
start "" "%TV_EXE%" --remote-debugging-port=%PORT%

echo Waiting for CDP to become available...
ping -n 6 127.0.0.1 >nul

REM Use 127.0.0.1 rather than localhost: on some machines localhost resolves to
REM IPv6 ::1, which Electron's debug server does not listen on.
set TRIES=0
:check
curl -s http://127.0.0.1:%PORT%/json/version >nul 2>&1
if %errorlevel% equ 0 goto ready
set /a TRIES+=1
if %TRIES% geq 30 (
    echo.
    echo Error: TradingView is running but CDP never became available on port %PORT%.
    echo Some Windows MSIX builds block the debug port. Use the tv_launch MCP tool,
    echo which falls back to launching from a local copy of the package.
    exit /b 1
)
echo Still waiting...
ping -n 3 127.0.0.1 >nul
goto check

:ready
echo.
echo CDP ready at http://127.0.0.1:%PORT%
curl -s http://127.0.0.1:%PORT%/json/version
echo.
