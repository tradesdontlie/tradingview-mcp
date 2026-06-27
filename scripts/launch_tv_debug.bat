@echo off
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled.
REM Thin wrapper around launch_tv_debug.ps1 which handles both installer and
REM Microsoft Store (MSIX) builds. See the .ps1 for why PowerShell is required.
REM Usage: scripts\launch_tv_debug.bat [port]

setlocal

set "PORT=%~1"
if "%PORT%"=="" set "PORT=9222"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch_tv_debug.ps1" -Port %PORT%
exit /b %errorlevel%
