#!/bin/bash
# Streams TradingView quote ticks to a JSONL file continuously
# Managed by pm2 — restarts automatically on failure

STREAM_FILE="$HOME/tv-stream.jsonl"
CLI="/Users/tim/tradingview-mcp/src/cli/index.js"

echo "Starting TradingView stream → $STREAM_FILE"

while true; do
  node "$CLI" stream quote --interval 500 >> "$STREAM_FILE" 2>&1
  echo "Stream disconnected, retrying in 5s..."
  sleep 5
done
