module.exports = {
  apps: [
    {
      // Telegram Bot
      name:         'trading-bot',
      script:       'telegram-bot.js',
      cwd:          'C:/Users/ADMIN/tradingview-mcp',
      interpreter:  'node',
      autorestart:  true,
      watch:        false,
      max_restarts: 10,
      min_uptime:   '10s',
      restart_delay: 3000,
      out_file:     'C:/Users/ADMIN/tradingview-mcp/logs/bot-out.log',
      error_file:   'C:/Users/ADMIN/tradingview-mcp/logs/bot-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:   true,
      env: { NODE_ENV: 'production', COS_AGENT: 'codex' },
    },
  ],
};
