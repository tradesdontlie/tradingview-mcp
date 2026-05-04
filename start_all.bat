@echo off
REM Start everything: API server + web dev server in separate windows.
REM Run this once after a fresh clone:
REM   npm install
REM   npm run web:install

cd /d "%~dp0"

echo Starting Quant API server (port 4321)...
start "Quant API" cmd /k "node src/api/server.js"

echo Waiting for API to initialise...
timeout /t 3 /nobreak >nul

echo Starting Quant Web dev server (port 5173)...
start "Quant Web" cmd /k "cd web && npm run dev"

echo.
echo Both servers are starting in separate windows.
echo   API:  http://localhost:4321
echo   Web:  http://localhost:5173
echo.
echo Press any key to open the dashboard in your browser...
pause >nul
start http://localhost:5173
