## 1. Bounded discovery
- [x] 1.1 Add `fetchWithTimeout(url, ms)` (AbortController) to `connection.js`; use it in
      `findChartTarget()` with a ~5s deadline. (Already landed via change #1; verified `findChartTarget`
      calls `fetchWithTimeout` with the default ~5s deadline.)

## 2. evaluate retry + probe throttle
- [x] 2.1 Wrap `c.Runtime.evaluate` so a connection-reset error nulls the singleton, reconnects, and
      retries once before throwing. (Gated on `isConnectionResetError()`; real JS exceptions are not retried.)
- [x] 2.2 Throttle the `getClient()` liveness probe via a `lastProbeAt` timestamp (skip within ~1s).
- [x] 2.3 Bound total connection wait (~10s) rather than only per-attempt (30s) backoff.

## 3. Stream output + backoff
- [x] 3.1 Route stream output through an injectable sink; guard so nothing writes to stdout/stderr on the
      MCP path. (Defaults to a NOOP sink; CLI passes process.stdout/stderr writers.)
- [x] 3.2 Replace the fixed 2s silent retry with exponential backoff (cap ~30s).
- [x] 3.3 After N consecutive CDP failures, emit one error event/line (N=10; CLI keeps running, no exit).

## 4. Tests
- [x] 4.1 Unit test: `evaluate` retries once on a simulated `Target closed` then succeeds.
      (tests/connection.test.js; also tests no-retry on real JS error + the reset-classifier helper.)
- [x] 4.2 Unit test: discovery aborts when `/json/list` never resolves within the deadline.
      (Already covered by tests/tab.test.js `fetchWithTimeout aborts a non-resolving fetch`; not duplicated.)

## 5. Validate
- [x] 5.1 `openspec validate improve-cdp-connection-resilience --strict`
