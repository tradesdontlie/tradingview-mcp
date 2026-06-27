# Change: Make TradingView launch non-destructive and observable

## Why
`tv_launch` (`src/core/health.js`) is biased toward destruction and hides spawn failures:
- On Windows it runs `taskkill /F /IM TradingView.exe` (`health.js:216`), terminating **every**
  TradingView process system-wide — killing a user's other chart/profile windows, not just the target
  (A3 S-10).
- `kill_existing` defaults to `true`, so a user with TradingView already open (possibly with unsaved
  drawings or an active replay) gets force-killed merely by invoking the tool (A3 S-21/B-17).
- The spawned child is `unref()`'d with no `'error'` handler, so an async spawn failure (binary
  unreadable, permission denied) is discarded; the function then reports "launched but CDP not
  responding" when the binary never started (A3 S-16).

## What Changes
- **BREAKING**: default `kill_existing` to `false`. When the CDP port already responds, skip the kill and
  return "already running — pass `kill_existing: true` to restart".
- When a restart is requested, kill only the process the tool spawned (track the PID), not all processes
  by image name.
- Attach an `'error'` handler to the spawned child before `unref()`; surface that error in the timeout
  response so the user sees the real cause.

## Impact
- Affected specs: `tradingview-launch` (new capability)
- Affected code: `src/core/health.js`, `src/tools/health.js` (schema default + description), `tests/`
