## 1. Wire orphaned suites (do first — cheap, high value)
- [x] 1.1 Add `tests/sanitization.test.js` and `tests/replay.test.js` to `test`, `test:unit`, `test:all`
      in `package.json`. (Also added all offline suites — tab/connection/wait/chart_readiness/router/
      input_validation/data_perf/screenshot_retention/launch_safety/data/alerts — to `test:unit` and
      `test:all`. The two LIVE-NETWORK suites pine_analyze.test.js + cli.test.js are kept out of the
      offline-green `test:unit` and live in a separate `test:unit:network` script plus `test:all`.)
- [x] 1.2 Run `npm run test:all`; fix or quarantine (with a tracked note) any newly-surfaced failure.
      Fixed: (a) sanitization.test.js Windows path bug (`import.meta.url`.pathname → `fileURLToPath`);
      (b) sanitization.test.js path-traversal assertions updated to the current `safeScreenshotName()`
      helper (capture.js/batch.js no longer use the old `.replace(/[\/\\]/g,'_')`); (c) replay.test.js
      stale "hideReplayToolbar must not appear" assertion updated to the current guarded-try/catch
      contract committed in replay.js. Remaining `test:all` failures are the EXPECTED live-only ones:
      e2e.test.js (needs live TV @9222) and 2 cli.test.js pine-facade network compile tests.

## 2. DI rollout (by priority)
- [x] 2.1 `data.js` — add `_resolve(deps)`; route `evaluate`/`evaluateAsync` through it (all 14 readers).
- [x] 2.2 `pine.js`, `indicators.js`, `ui.js`.
- [x] 2.3 `alerts.js`, `batch.js`, `watchlist.js`, `capture.js`, `tab.js`, `pane.js`, `health.js`,
      `stream.js`. ALL remaining CDP-touching core modules now carry the `_resolve(_deps)` seam —
      no module left non-DI'd. (health.js launch helpers and pine.js analyze/check stay pure as before.)

## 3. New unit suites (failure paths)
- [x] 3.1 `data.js`: `_warnings` surfaced on broken graphics shape; numeric study values; `getOhlcv`
      propagates eval error (and only emits loading hint on empty extraction); strategy reader throws
      on payload error. (tests/data.test.js)
- [x] 3.2 `alerts.js`: `create` throws when Create button missing; `deleteAlerts` returns success:false
      (no throw) without `delete_all`. (tests/alerts.test.js)
- [x] 3.3 `tab.js`: `switchTab` reconnect — activates + disconnect()/reconnect(target.id) on a valid
      index, and does NOT reconnect when activate throws. (tests/tab.test.js — deferred from #1, now
      unblocked by the tab.js `_deps` seam.)
- [x] 3.4 `ui.js`: selector sanitization (click/findElement route values through safeString) +
      keyboard mapping (mapKey, keyboard() rejects unsupported keys). (tests/ui.test.js, via `_deps`.)

## 4. Validate
- [x] 4.1 `openspec validate complete-dependency-injection-and-tests --strict`
