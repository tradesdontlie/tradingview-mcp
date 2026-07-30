#!/bin/bash
# Launch TradingView Desktop on macOS with Chrome DevTools Protocol enabled
# Usage: ./scripts/launch_tv_debug_mac.sh [port]

PORT="${1:-9222}"

# Auto-detect TradingView install location. `open -a` needs the .app bundle,
# not the inner Mach-O binary.
BUNDLE=""
LOCATIONS=(
  "/Applications/TradingView.app"
  "$HOME/Applications/TradingView.app"
)

for loc in "${LOCATIONS[@]}"; do
  if [ -d "$loc" ]; then
    BUNDLE="$loc"
    break
  fi
done

# Fallback: search with mdfind (Spotlight)
if [ -z "$BUNDLE" ]; then
  BUNDLE=$(mdfind "kMDItemCFBundleIdentifier == 'com.niceincontact.TradingView'" 2>/dev/null | head -1)
fi

# Fallback: find any TradingView.app
if [ -z "$BUNDLE" ] || [ ! -d "$BUNDLE" ]; then
  BUNDLE=$(find /Applications "$HOME/Applications" -name "TradingView.app" -maxdepth 2 2>/dev/null | head -1)
fi

if [ -z "$BUNDLE" ] || [ ! -d "$BUNDLE" ]; then
  echo "Error: TradingView not found."
  echo "Checked: /Applications/TradingView.app, ~/Applications/TradingView.app"
  echo ""
  echo "If installed elsewhere, run manually:"
  echo "  open -a /path/to/TradingView.app --args --remote-debugging-port=$PORT"
  exit 1
fi

BIN="$BUNDLE/Contents/MacOS/TradingView"

# Quit any running instance: `open --args` only forwards arguments when the app
# is not already running. Match $BIN rather than the bare name — `pkill -f TradingView`
# also matches unrelated processes that merely mention it.
osascript -e 'quit app "TradingView"' 2>/dev/null
for _ in $(seq 1 10); do
  pgrep -f "$BIN" > /dev/null 2>&1 || break
  sleep 1
done
if pgrep -f "$BIN" > /dev/null 2>&1; then
  pkill -f "$BIN" 2>/dev/null
  sleep 2
fi

echo "Found TradingView at: $BUNDLE"
echo "Launching with --remote-debugging-port=$PORT ..."

# Launch via `open` so launchd owns the process (PPID 1). Launching $BIN directly
# makes it a child of the calling shell; under a degraded GUI session — e.g. an
# editor extension host — CDP answers but the renderer never finishes booting:
# the chart sits on a spinner and api_available stays false indefinitely.
#
# ELECTRON_RUN_AS_NODE is exported by some editor extension hosts. When set, the
# Electron stub runs as a plain Node interpreter and rejects the flag with
# "bad option: --remote-debugging-port=$PORT".
env -u ELECTRON_RUN_AS_NODE open -a "$BUNDLE" --args --remote-debugging-port="$PORT"

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
