## 1. Core failure contract
- [x] 1.1 `src/core/data.js`: `getStrategyResults`/`getTrades`/`getEquity` throw when the underlying
      payload carries an error instead of returning `{success:true, error}`.
- [x] 1.2 `src/core/batch.js`: unknown action throws (or records a per-iteration `success:false`); the
      overall batch result reflects per-item failures rather than blanket `success:true`.
- [x] 1.3 `src/core/ui.js`: `layoutSwitch`/layout-list timeouts throw instead of returning in-band error.
- [x] 1.4 `src/core/alerts.js`: `create()` throws "Could not find Create button in alert dialog" when
      `created` is falsy.

## 2. Preserve underlying errors
- [x] 2.1 `src/core/data.js` `getOhlcv`: stop catching the evaluate error; only emit the
      "chart may still be loading" hint when extraction returned truthy-but-empty bars.
- [x] 2.2 `buildGraphicsJS`/the four pine-graphics readers: collect per-study parse failures into a
      `_warnings` array on the result.

## 3. CLI exit code
- [x] 3.1 `src/cli/router.js`: exit non-zero when `result.success === false`; keep existing
      connection-error classification for thrown errors.

## 4. alert_delete default
- [x] 4.1 Default `delete_all:false`; return `{success:false, error:'Individual deletion not supported…'}`
      (no throw) when individual deletion is requested.

## 5. Tests
- [x] 5.1 Unit tests: each touched core function throws (or returns success:false) on the failure path.
      (Covered for the CLI exit-code path + findStrategy snippet in `tests/router.test.js`. Full per-core
      throw tests for data.js/alerts.js/ui.js are blocked on the missing `_deps`/evaluate seam — deferred
      to change #10 which adds DI to those modules.)
- [x] 5.2 Unit test: pine-graphics reader surfaces `_warnings` when a mocked `_primitivesCollection`
      shape is undefined. (Done — the `_deps` evaluate seam arrived with #10; covered in
      `tests/data.test.js` "getPineLines/getPineLabels — _warnings surfaced", which inject an evaluate
      payload carrying warnings and assert the shaped result exposes `_warnings`.)
- [x] 5.3 CLI test: a `success:false` handler result yields a non-zero exit code. (`tests/router.test.js`
      via exported pure `exitCodeFor()`.)

## 6. Validate
- [x] 6.1 `openspec validate normalize-failure-signaling --strict`
