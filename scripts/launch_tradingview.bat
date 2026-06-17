@echo off
REM Auto-launch TradingView Desktop with CDP enabled (port 9222)
REM Placed in Windows Startup folder — runs on every login
REM Auto-detects the latest installed TradingView version

REM Kill any existing instance first
taskkill /F /IM TradingView.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul

REM Auto-detect the latest TradingView install path in WindowsApps
set TV_EXE=
for /f "delims=" %%d in ('dir "C:\Program Files\WindowsApps\TradingView.Desktop_*_x64__n534cwy3pjxzj" /b /ad 2^>nul') do (
    set TV_EXE=C:\Program Files\WindowsApps\%%d\TradingView.exe
)

if "%TV_EXE%"=="" (
    echo TradingView not found! Please check your installation.
    pause
    exit /b 1
)

echo Launching: %TV_EXE%
start "" "%TV_EXE%" --remote-debugging-port=9222
