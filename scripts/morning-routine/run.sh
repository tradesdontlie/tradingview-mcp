#!/bin/bash
# Wrapper script for morning markup routine
# Runs via launchd at 8:45 AM ET weekdays

set -e

PROJECT_DIR="/Users/ledgepipe/tradingview-mcp"
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

DATE=$(date +%Y-%m-%d)
WRAPPER_LOG="$LOG_DIR/wrapper-$DATE.log"

echo "=== $(date) — wrapper start ===" >> "$WRAPPER_LOG"
echo "PATH=$PATH" >> "$WRAPPER_LOG"
echo "TZ=$TZ" >> "$WRAPPER_LOG"

# Ensure node is reachable when launched by launchd (which has minimal PATH)
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

cd "$PROJECT_DIR"

# Run the markup script
/usr/local/bin/node "$PROJECT_DIR/scripts/morning-routine/markup.cjs" >> "$WRAPPER_LOG" 2>&1
EXIT_CODE=$?

echo "=== $(date) — wrapper end (exit=$EXIT_CODE) ===" >> "$WRAPPER_LOG"
exit $EXIT_CODE
