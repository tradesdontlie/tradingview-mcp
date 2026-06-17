@echo off
REM TradingView 12 Hr Update — runs at 9:03 AM and 9:03 PM
REM Launches TradingView with CDP if not running, then triggers the scan

set NODE_EXE=C:\Program Files\nodejs\node.exe
set MCP_SERVER=C:\Users\shawn\tradingview-mcp\src\server.js
set SESSIONS_DIR=C:\Users\shawn\.tradingview-mcp\sessions

REM Ensure sessions directory exists
if not exist "%SESSIONS_DIR%" mkdir "%SESSIONS_DIR%"

REM Auto-detect the latest TradingView install path (survives version updates)
set TV_EXE=
for /f "delims=" %%d in ('dir "C:\Program Files\WindowsApps\TradingView.Desktop_*_x64__n534cwy3pjxzj" /b /ad 2^>nul') do (
    set TV_EXE=C:\Program Files\WindowsApps\%%d\TradingView.exe
)
if "%TV_EXE%"=="" (
    echo TradingView not found! Check installation.
    exit /b 1
)

REM Kill existing TradingView, relaunch with CDP
taskkill /F /IM TradingView.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul
start "" "%TV_EXE%" --remote-debugging-port=9222
ping -n 11 127.0.0.1 >nul

REM Run health check via CLI
"%NODE_EXE%" "%MCP_SERVER%" 2>&1
