# Change: Improve CDP connection and stream resilience

## Why
The connection layer and the stream loop degrade poorly under real-world CDP instability:
- `findChartTarget()` (`src/connection.js:90-97`) calls `fetch('/json/list')` with no timeout. If
  TradingView accepts the TCP connection but never responds (a known wedged state), `fetch` hangs
  forever and the 5×backoff retry envelope never gets to expire — the tool call blocks indefinitely
  (A3 S-6, A5 S-4).
- `evaluate()` (`src/connection.js:106-121`) is not retry-wrapped: a socket that drops between
  `getClient()` and `Runtime.evaluate` throws a raw error even though a single reconnect-and-retry would
  mask the transient (A3 S-12).
- The liveness probe runs a full `Runtime.evaluate('1')` on **every** `getClient()` call, adding a CDP
  round-trip to every tool invocation (A3 S-18/P-4).
- The backoff caps per-attempt at 30s, so total wait can reach ~15.5s before failing when TV is simply
  down (A1 S-6, A3 P-11).
- `stream.js` writes JSONL/banners directly to `process.stdout`/`stderr` — if ever reached from the MCP
  stdio path it would corrupt the protocol stream (A2 S-8) — and on CDP errors it retries silently every
  2s forever with no backoff or escalation (A1 S-4, A3 S-7).

## What Changes
- Wrap all CDP debug-endpoint `fetch` calls in an `AbortController` deadline (shared `fetchWithTimeout`).
- `evaluate()` SHALL retry once on a connection-reset class error (`ECONNRESET`/`socket hang up`/
  `Target closed`): null the singleton, reconnect, retry, then throw if it still fails.
- Throttle the liveness probe (skip it if it succeeded within a short window) or replace it with a
  `disconnect` event handler.
- **BREAKING (behavioral)**: bound total connection wait (fail faster when TV is down) rather than
  capping only per-attempt delay.
- **BREAKING (behavioral)**: stream functions SHALL NOT write to stdout/stderr when reachable from the
  MCP path (guard or event-emitter output), SHALL back off exponentially on repeated CDP errors, and
  SHALL surface an error event after N consecutive failures.

## Impact
- Affected specs: `cdp-connection` (new capability)
- Affected code: `src/connection.js`, `src/core/stream.js`, `src/cli/commands/stream.js`, `tests/`
