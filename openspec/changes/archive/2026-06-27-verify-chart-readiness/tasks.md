## 1. waitForChartReady
- [x] 1.1 Read the current chart resolution inside the poll loop and require it to match `expectedTf`
      (when provided) as part of the ready condition. Reads `chart.resolution()` via the chart API in
      the same `evaluate` payload; comparison is normalized ("1D"==="D", etc.). Graceful degradation:
      only blocks when a DIFFERENT resolution is positively read; if resolution can't be read (null),
      it does not gate on timeframe.
- [x] 1.2 Scope the bar-count probe to the chart canvas container (counts canvases within
      `[data-name="pane"]` / `[class*="chart-container"] canvas`) instead of `[class*="bar"]`.
- [x] 1.3 Fix/remove the misleading timeout comment so it matches the `false` return.

## 2. Treat timeout as failure for mutations
- [x] 2.1 `chart.setSymbol`/`setTimeframe`: when readiness times out, return `success:false` with an
      explanatory error (not `success:true, chart_ready:false`).
- [x] 2.2 `batch_run`: pass the requested timeframe into the readiness check and mark that iteration
      `success:false` on timeout.

## 3. Poll instead of fixed wait
- [x] 3.1 Replace the 1500ms post-`createStudy` sleep with a bounded `pollUntil` until
      `getAllStudies().length` increases (max elapsed kept at the former 1500ms budget; falls back to a
      final read on timeout so it still reports whatever exists).

## 4. Tests
- [x] 4.1 Unit test (mocked deps): readiness failure path — `setTimeframe`/`setSymbol` return
      `success:false` when injected `waitForChartReady` resolves false. (wait.js's own resolution-match
      coverage deferred to #10 since it imports `evaluate` directly with no DI seam.)
- [x] 4.2 Unit test: `setTimeframe` returns `success:false` on readiness timeout, plus the
      createStudy bounded-poll path resolves the new entity id when the study count grows.

## 5. Validate
- [x] 5.1 `openspec validate verify-chart-readiness --strict`
