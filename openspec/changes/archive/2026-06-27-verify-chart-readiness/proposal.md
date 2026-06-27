# Change: Verify chart readiness (timeframe + timeout) before reporting success

## Why
`waitForChartReady(expectedSymbol, expectedTf, timeout)` (`src/wait.js:6-71`) never reads `expectedTf`,
so `chart_set_timeframe` and multi-timeframe `batch_run` can proceed while the chart is still on the old
resolution (A5 S-2). Worse, both `chart_set_symbol`/`chart_set_timeframe` (`src/core/chart.js:51-64`) and
`batch_run` (`src/core/batch.js:29-35`) return `success: true` even when readiness **times out** and
returns `false` — only a `chart_ready:false` field hints at the problem, which callers ignore, yielding
stale reads and stale screenshots (A1 S-2, A2 S-7). The bar-count stability probe matches any element
whose class contains `"bar"` (toolbars, progress bars), so it can report ready while the series is still
loading (A3 S-6). A misleading comment says it "returns true anyway" while the code returns `false`
(A4 S-4). The fixed 1500ms post-`createStudy` wait (`src/core/chart.js:111`) is the same class of
guess and should poll instead (A3 S-11).

## What Changes
- `waitForChartReady` SHALL read and verify the actual chart resolution against `expectedTf` as part of
  the readiness condition.
- The bar-count stability probe SHALL be scoped to the chart canvas container rather than any `"bar"`
  class match.
- **BREAKING**: Mutating tools (`chart_set_symbol`, `chart_set_timeframe`, `batch_run` per iteration)
  SHALL return `success:false` (with an explanatory error) when readiness times out, instead of
  `success:true` + `chart_ready:false`.
- `batch_run` SHALL pass the requested timeframe through its readiness check.
- Replace the fixed 1500ms post-`createStudy` wait with a bounded poll for the new study id.
- Fix the `wait.js` timeout comment to match the actual return.

## Impact
- Affected specs: `chart-readiness` (new capability)
- Affected code: `src/wait.js`, `src/core/chart.js`, `src/core/batch.js`, `tests/`
