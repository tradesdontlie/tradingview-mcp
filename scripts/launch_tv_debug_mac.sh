#!/bin/bash
# Launch TradingView Desktop on macOS with Chrome DevTools Protocol enabled
# Usage: ./scripts/launch_tv_debug_mac.sh [port]

PORT="${1:-9222}"

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

# ── Kill any existing TradingView, then WAIT FOR THE PORT TO ACTUALLY BE FREE ──────
# ⛔ 2026-08-11: this used to be `pkill; sleep 1` and launch regardless. TradingView is a
# large Electron app and does not reliably release the listening socket on $PORT within one
# second. When it doesn't, the new instance loses the bind and dies with
#   ERROR:net/socket/socket_posix.cc:248] bind() failed: Address already in use (48)
#   ERROR:devtools_http_handler.cc:310] Cannot start http server for devtools.
# — the kill succeeds, the relaunch fails, and you are left WORSE off than before: no CDP at
# all. Observed 2026-08-07 06:51 (via cdp_prewarm) and again 2026-08-11 09:50 (via
# tv_ensure_up recovering a crash view), each time knocking out the whole CDP window for
# every consumer. THREE scripts share this launcher — tv_ensure_up.sh, cdp_prewarm.sh and
# reboot_recovery.sh — so all of them inherited the race.
# Poll for the socket instead of guessing, escalate to SIGKILL, and FAIL LOUDLY rather than
# launch into a collision. A launch that cannot bind is worse than no launch.
port_free() { ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

# ⛔⛔ 2026-09-05 — port_free() ALONE IS THE WRONG GATE, AND IT SHIPS A DEAD CDP THAT LOOKS FINE.
# A TradingView started WITHOUT --remote-debugging-port (macOS `open -a`, a Dock/Finder click, a
# login item, or Electron's own quit+relaunch — see tv_ensure_up.sh's 2026-08-18 note) binds NO
# socket at all. So port_free() is TRUE on the very first poll: the graceful-shutdown loop breaks
# instantly, the SIGKILL escalation never runs, the ABORT never fires, and this script prints
# "safe to launch" while a live TradingView is still sitting there.
# What happens next is INVISIBLE in this script's own output:
#   1. the new instance starts and DOES bind $PORT  ->  "DevTools listening on ws://...:9222"
#   2. Electron's single-instance lock is still held by the OLD live process
#      (~/Library/Application Support/TradingView/SingletonLock, a symlink stamped <host>-<pid>)
#   3. the new instance loses requestSingleInstanceLock(), hands off to the old one, and QUITS
#   4. $PORT is released again; the flagless original survives; CDP is dead
# Measured 2026-09-05 10:51 — pid 1869 (flagless) survived the pkill, pid 2071 launched and
# printed "DevTools listening", then vanished; 9222 unbound; 1869 still alive 3 minutes later.
# Every symptom points at "the launch failed", but the launch WORKED and was then undone.
# ⭐⭐⭐ THE CHECK WAS ANSWERING A DIFFERENT QUESTION THAN THE ONE BEING ASKED: we need to know
# "is the old app GONE?" and we were asking "is the SOCKET free?" — which a flagless instance
# answers yes to by construction. Gate on the PROCESS. Keep the socket check too: the 2026-08-11
# bind race above is real and must not regress. BOTH conditions, or we do not launch.
# ⛔ Do NOT match the bare string "TradingView" here — it also hits the Electron helpers and this
# repo's own paths. $APP is the resolved MAIN binary; helpers live under
# .../Frameworks/TradingView Helper.app/... and do not contain that substring, so this stays
# pinned to the real main process(es), which is exactly what owns the single-instance lock.
tv_gone() { ! pgrep -f "$APP" >/dev/null 2>&1; }

# The field is clear only when BOTH hold. Either one alone is a documented failure mode.
field_clear() { tv_gone && port_free; }

pkill -f "TradingView" 2>/dev/null
for i in $(seq 1 20); do            # up to ~10s of graceful shutdown
  field_clear && break
  sleep 0.5
done

if ! field_clear; then
  echo "TradingView process and/or port $PORT still present after graceful kill — escalating to SIGKILL"
  pkill -9 -f "TradingView" 2>/dev/null
  for i in $(seq 1 20); do          # up to another ~10s
    field_clear && break
    sleep 0.5
  done
fi

# Process check first: a survivor here is the single-instance-lock holder, and its symptom
# (launch appears to succeed, then CDP silently dies) is far more confusing than a bind error.
if ! tv_gone; then
  SURVIVORS=$(pgrep -f "$APP" | tr '\n' ' ')
  echo "ABORT: a TradingView MAIN process is STILL alive after SIGKILL (pid(s): ${SURVIVORS%% })." >&2
  echo "Refusing to launch — it holds Electron's single-instance lock, so a new instance would" >&2
  echo "hand off to it and quit, leaving CDP dead while appearing to have launched fine." >&2
  echo "Investigate those pids, then re-run." >&2
  exit 3
fi

if ! port_free; then
  HOLDER=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" (PID "$2")"}')
  echo "ABORT: port $PORT is STILL held by ${HOLDER:-an unknown process} after SIGKILL." >&2
  echo "Refusing to launch — a second instance cannot bind $PORT and would leave CDP dead." >&2
  echo "Investigate that holder, then re-run." >&2
  exit 3
fi
echo "no TradingView main process alive and port $PORT confirmed free — safe to launch"

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
