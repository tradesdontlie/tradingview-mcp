@echo off
REM Start the Quant Dashboard web dev server (Vite, port 5173)
REM Requires: npm run web:install has been run once first

title Quant Web - port 5173
cd /d "%~dp0\web"

echo Starting web dev server on http://localhost:5173 ...
npm run dev
