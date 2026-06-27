## 1. Canonical paths
- [x] 1.1 Import `KNOWN_PATHS` and use `KNOWN_PATHS.chartApi` in `chart.js`, `indicators.js`, `stream.js`;
      delete the local `CHART_API` literals.

## 2. Named timing constants
- [x] 2.1 Replace magic-number `setTimeout` delays with named module constants + a rationale comment each
      (chart, pine, ui, alerts, pane, tab, batch, replay).

## 3. Shared helpers
- [x] 3.1 Add `pollUntil(predicate, {interval, timeout})` to `wait.js`; refactor the pine-editor poll to use
      it. (waitForChartReady's readiness loop left intact per scope — that is change #4.)
- [x] 3.2 Extract `findCompileButton()` (pine), `findStrategy()` (data), `findBarIndexRange()` (chart).
      All three are exported snippet builders reused by their call sites (`compile`/`smartCompile`;
      `getStrategyResults`/`getTrades`/`getEquity`; `setVisibleRange`/`scrollToDate`), with snippet unit
      tests in `tests/router.test.js`. Behavior preserved (compile prefix-match vs smartCompile exact-match
      kept via the `exact` flag).
- [x] 3.3 Add `wrap(fn)` to `_format.js`; adopt it in a few tool registrars (indicators.js, tab.js).

## 4. Single source of truth + config
- [x] 4.1 Derive/align the tool count across `server.js`, `cli/index.js`, `CLAUDE.md` (78, from `server.tool(` count).
- [x] 4.2 Add a `PINE_FACADE_URL` env override (default to the current hardcoded URL).
- [x] 4.3 Add `engines.node >=18` to `package.json`.
- [x] 4.4 `replay_stop` calls `hideReplayToolbar()` before returning.

## 5. Validate
- [x] 5.1 `openspec validate consolidate-shared-constants-and-timing --strict`
