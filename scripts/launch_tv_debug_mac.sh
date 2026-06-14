#!/bin/bash
# Launch TradingView Desktop on macOS with Chrome DevTools Protocol enabled
# Usage: ./scripts/launch_tv_debug_mac.sh [port]

PORT="${1:-9223}"

# Auto-detect TradingView install location
APP=""
LOCATIONS=(
  "/Applications/TradingView.app/Contents/MacOS/TradingView"
  "$HOME/Applications/TradingView.app/Contents/MacOS/TradingView"
)

for loc in "${LOCATIONS[@]}"; do
  if [ -f "$loc" ]; then
    APP="$loc"
    break
  fi
done

# Fallback: search with mdfind (Spotlight)
if [ -z "$APP" ]; then
  APP=$(mdfind "kMDItemCFBundleIdentifier == 'com.niceincontact.TradingView'" 2>/dev/null | head -1)
  if [ -n "$APP" ]; then
    APP="$APP/Contents/MacOS/TradingView"
  fi
fi

# Fallback: find any TradingView.app
if [ -z "$APP" ] || [ ! -f "$APP" ]; then
  APP=$(find /Applications "$HOME/Applications" -name "TradingView.app" -maxdepth 2 2>/dev/null | head -1)
  if [ -n "$APP" ]; then
    APP="$APP/Contents/MacOS/TradingView"
  fi
fi

if [ -z "$APP" ] || [ ! -f "$APP" ]; then
  echo "Error: TradingView not found."
  echo "Checked: /Applications/TradingView.app, ~/Applications/TradingView.app"
  echo ""
  echo "If installed elsewhere, run manually:"
  echo "  /path/to/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=$PORT"
  exit 1
fi

# Kill any existing TradingView
pkill -f "TradingView" 2>/dev/null
sleep 1

echo "Found TradingView at: $APP"
echo "Launching with --remote-debugging-port=$PORT ..."
"$APP" --remote-debugging-port=$PORT &
TV_PID=$!
echo "PID: $TV_PID"

# Wait for CDP to be ready
echo "Waiting for CDP..."
for i in $(seq 1 15); do
  if curl -s "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
    echo "CDP ready at http://localhost:$PORT"
    curl -s "http://localhost:$PORT/json/version" | python3 -m json.tool 2>/dev/null || curl -s "http://localhost:$PORT/json/version"
    exit 0
  fi
  sleep 1
done

echo "Warning: CDP not responding after 15s. TradingView may still be loading."
echo "Check manually: curl http://localhost:$PORT/json/version"
