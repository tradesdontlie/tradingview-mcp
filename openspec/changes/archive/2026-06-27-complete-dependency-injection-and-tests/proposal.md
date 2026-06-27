# Change: Complete dependency injection and wire orphaned test suites

## Why
The DI refactor (commits `f23eb1b`/`4111f24`) added a `_deps`/`_resolve` seam to only `chart.js`,
`drawing.js`, and `replay.js`. The other 13 core modules (`data.js`, `ui.js`, `pine.js`, `health.js`,
`alerts.js`, `batch.js`, `watchlist.js`, `stream.js`, `capture.js`, `tab.js`, `indicators.js`,
`pane.js`, plus `connection.js` consumers) hard-call `evaluate`/`getClient` directly and can only be
tested against a live TradingView at port 9222 (A1 S-5, A2 S-5/B-1, A3 S-8, A5 B-1). Separately, the two
DI-based unit suites that protect the most safety-critical fixes — `tests/sanitization.test.js`
(CDP-injection sanitization) and `tests/replay.test.js` (autoplay-delay validator behind the
account-corruption fix) — are **not referenced by any npm script**, so `npm run test:all` runs neither
(A4 S-2/B-2). The regression coverage exists but is dead.

## What Changes
- Extend the canonical `_resolve(deps)` pattern (from `src/core/drawing.js`) to every core module that
  performs CDP I/O, defaulting to the real `connection.js` imports.
- Wire `tests/sanitization.test.js` and `tests/replay.test.js` into the `test`, `test:unit`, and
  `test:all` npm scripts.
- Add DI-based unit suites for the newly-injectable modules covering at least their failure paths
  (the ones tightened in the other proposals): `data.js` graphics warnings, `alerts.create` throw,
  `tab_switch` reconnect, `ui` selector sanitization.

## Impact
- Affected specs: `testability` (new capability)
- Affected code: 12–13 `src/core/*.js` modules, `package.json` (test scripts), new files under `tests/`
