@echo off
REM Start the Quant Dashboard API server (Express, port 4321)
REM Requires: npm install has been run in the repo root

title Quant API - port 4321
cd /d "%~dp0"

echo Starting API server on http://localhost:4321 ...
node src/api/server.js
