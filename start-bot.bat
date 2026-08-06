@echo off
:: Khoi dong trading bot voi PM2 khi Windows bat dau
cd /d C:\Users\ADMIN\tradingview-mcp
pm2 resurrect
timeout /t 5
pm2 start ecosystem.config.cjs --no-daemon-mode 2>nul
pm2 save
