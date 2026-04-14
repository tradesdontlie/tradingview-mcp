#!/bin/bash
# Ensure TradingView Desktop is running with CDP enabled.
# Idempotent: exits immediately if CDP is already responding.
# Usage: ./scripts/ensure_tv_cdp.sh [port]

PORT="${1:-9222}"

# Step 1: Check if CDP is already available
if curl -s --max-time 2 "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
  echo "CDP already available on port $PORT"
  curl -s "http://localhost:$PORT/json/version" | python3 -m json.tool 2>/dev/null
  exit 0
fi

echo "CDP not responding on port $PORT"

# Step 2: Check if TV is running without CDP
TV_RUNNING=false
if pgrep -f TradingView > /dev/null 2>&1; then
  TV_RUNNING=true
  echo "TradingView running without CDP — killing..."
  pkill -f TradingView 2>/dev/null
  sleep 2
else
  echo "TradingView not running"
fi

# Step 3: Launch with CDP via open (macOS) or direct binary
if [[ "$(uname)" == "Darwin" ]]; then
  open -a TradingView --args --remote-debugging-port=$PORT
else
  # Linux: auto-detect binary
  TV_BIN=""
  for loc in /opt/TradingView/tradingview /opt/TradingView/TradingView "$HOME/.local/share/TradingView/TradingView" /usr/bin/tradingview /snap/tradingview/current/tradingview; do
    if [ -f "$loc" ]; then
      TV_BIN="$loc"
      break
    fi
  done
  if [ -z "$TV_BIN" ]; then
    TV_BIN=$(which tradingview 2>/dev/null)
  fi
  if [ -z "$TV_BIN" ]; then
    echo "Error: TradingView binary not found"
    exit 1
  fi
  "$TV_BIN" --remote-debugging-port=$PORT &
fi

echo "Launched TradingView with --remote-debugging-port=$PORT"

# Step 4: Wait for CDP to come online
echo "Waiting for CDP..."
for i in $(seq 1 20); do
  if curl -s --max-time 2 "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
    echo "CDP ready after ${i}s"
    curl -s "http://localhost:$PORT/json/version" | python3 -m json.tool 2>/dev/null
    exit 0
  fi
  sleep 1
done

echo "Warning: CDP not responding after 20s. TradingView may still be loading."
echo "Check manually: curl http://localhost:$PORT/json/version"
exit 1
