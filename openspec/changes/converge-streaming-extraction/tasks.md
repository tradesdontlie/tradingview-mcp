## 1. Share the extraction builders
- [x] 1.1 In `src/core/data.js`, exposed the page-side extraction strings as named exported builders:
      `buildGraphicsJS(collection, mapKey, filter)` (the `_primitivesDataById` graphics path) and a new
      `buildStudyValuesJS(filter)` (the `_study.data()._items` values snippet, extracted verbatim from
      `getStudyValues`, which now calls it). `stream.js` reuses these EXACT proven strings.
- [x] 1.2 Re-pointed `fetchValues` to `buildStudyValuesJS` (was `src._lastBarValues || src._data`),
      reshaping the result to the stream's `{symbol, studies:[{name,values}]}` schema.
- [x] 1.3 Re-pointed `fetchLines`/`fetchLabels`/`fetchTables` to `buildGraphicsJS` + the proven shapers
      (`shapeLines`/`shapeLabels`; tables via a pure `shapeStreamTables` that reads the same
      tid/row/col/t fields but keeps the array-of-cells row schema). DESIGN: each extractor wraps the
      builder as `({ symbol: <CHART_API>.symbol(), data: <builder> })` so `symbol` (stream schema) and the
      data are read in ONE round-trip; only proven page-side calls are used, so there is no new
      unverifiable page-side JS — all new logic is the pure-JS reshape (offline-tested).

## 2. Bound the poll-loop error handling
- [x] 2.1 `pollLoop` now applies the consecutive-error counter + backoff + escalate-after-N to EVERY
      caught error via the exported pure `streamErrorAction(message, count)` helper, not just
      `/CDP|ECONNREFUSED/`.
- [x] 2.2 Non-transport errors terminate the loop after `ERROR_TERMINATE_AFTER` (20) consecutive failures
      (a moved API path can no longer spin an unbounded log loop). Transport errors back off forever (they
      may self-heal when TradingView restarts).

## 3. Tests
- [x] 3.1 `tests/stream.test.js`: the now-exported `fetch*` extractors reshape a fixed mock builder
      payload, and the result's per-study values/levels/labels are asserted EQUAL to `shapeLines`/
      `shapeLabels`/`getStudyValues` output for the same input (parity).
- [x] 3.2 `tests/stream.test.js`: `streamErrorAction` backs off (capped) for every error, never
      terminates transport errors, and terminates a persistent non-transport error at the threshold —
      a pure, instant test (no real 30s backoff loop).
- [x] 3.3 `tests/wait.test.js`: backfilled `normalizeResolution` (1D==D, 1W==W, 1M==M, plain "1" kept,
      null/empty) and `waitForChartReady` (matching-res ready, null-res does-not-gate, different-res
      blocks→timeout false, still-loading→timeout false) — enabled by a new injectable
      `evaluate`/`sleep` seam on `waitForChartReady`.

## 4. Validate
- [x] 4.1 `openspec validate converge-streaming-extraction --strict`
