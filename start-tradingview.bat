@echo off
echo ================================================
echo  TradingView MCP Launcher
echo ================================================
echo.

:: Kill existing TradingView and Chrome on port 9222
taskkill /F /IM TradingView.exe /T >nul 2>&1
taskkill /F /IM chrome.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

:: Get TradingView Desktop install path via AppxPackage
for /f "delims=" %%P in ('powershell -NoProfile -Command "(Get-AppxPackage -Name TradingView.Desktop -ErrorAction SilentlyContinue).InstallLocation"') do set TV_PATH=%%P

if defined TV_PATH (
    echo [1/2] Found TradingView Desktop at: %TV_PATH%
    echo [2/2] Launching with debug port 9222...
    start "" "%TV_PATH%\TradingView.exe" --remote-debugging-port=9222
    timeout /t 5 /nobreak >nul
    :: Check if CDP port opened
    curl -s http://localhost:9222/json/version >nul 2>&1
    if %errorlevel%==0 (
        echo.
        echo SUCCESS! TradingView Desktop is running on port 9222.
        echo Open Claude — MCP will connect automatically.
        echo.
        pause
        exit /b 0
    )
    echo TradingView Desktop started but port 9222 not responding.
    echo Falling back to Chrome...
    taskkill /F /IM TradingView.exe /T >nul 2>&1
    timeout /t 1 /nobreak >nul
) else (
    echo TradingView Desktop not found, using Chrome...
)

:: Fallback: Chrome with TradingView web
echo Launching TradingView in Chrome with debug port 9222...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%LOCALAPPDATA%\TradingViewChrome" ^
  "https://www.tradingview.com/chart/"

echo.
echo TradingView is running in Chrome on port 9222.
echo Open Claude — MCP will connect automatically.
echo.
pause
