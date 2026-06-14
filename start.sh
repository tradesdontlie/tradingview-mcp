#!/bin/bash
echo "Starting TradingView MCP..."
powershell.exe -ExecutionPolicy Bypass -File "$(dirname "$0")/launch-tv.ps1"
