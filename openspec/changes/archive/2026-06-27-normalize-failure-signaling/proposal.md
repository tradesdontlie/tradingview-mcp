# Change: Normalize failure signaling across core, tools, and CLI

## Why
Failure signaling is inconsistent across the codebase, so real failures are reported as successes:
- Several core functions return `{success: true, ..., error: "..."}` — the caller checking `success`
  sees `true` while an error is buried in-band (A1 B-5; A2 S-2; A3 B-6; A5 B-2). Examples:
  `getStrategyResults`/`getTrades`/`getEquity` (`src/core/data.js:171-267`), unknown `batch_run`
  actions (`src/core/batch.js:74-85`), layout-list timeouts (`src/core/ui.js:121-134`).
- `alerts.create()` returns `{success:false}` **without throwing** (`src/core/alerts.js:72`), so the
  MCP tool wraps it as a non-error response (A2 S-6, A3 S-17).
- `getOhlcv` catches every evaluation error and replaces it with a generic "chart may still be loading"
  message (`src/core/data.js:62-84`), hiding the real cause (A2/A3 S-3/S-5).
- `buildGraphicsJS` swallows per-study parse failures in silent `catch(e){}` blocks
  (`src/core/data.js:11-58`), so a broken TradingView internal shape looks like "indicator has no lines"
  (A1 S-1, A3 S-3) — this silently produces empty sections in generated reports.
- The CLI prints the result and always `process.exit(0)` (`src/cli/router.js:131-135`), so scripts treat
  `success:false` payloads as success (A5 B-2).
- `alert_delete` throws when `delete_all` is omitted even though the schema makes it optional
  (A1 S-8, A3 S-11).

## What Changes
- **BREAKING**: Core functions SHALL signal failure by throwing; they SHALL NOT return `success:true`
  with an embedded `error`. The tools layer remains the single place that converts thrown errors into
  `{success:false, error}`.
- `alerts.create()` SHALL throw when the Create button cannot be found.
- `data_get_ohlcv` SHALL preserve the underlying evaluation error; the "chart may still be loading" hint
  applies only when extraction succeeded but returned zero bars.
- Pine-graphics reads (`data_get_pine_lines/labels/tables/boxes`) SHALL surface per-study parse failures
  in a `_warnings` array on the result instead of silently dropping them.
- **BREAKING**: The CLI SHALL exit non-zero when the handler result is `success:false`.
- `alert_delete` SHALL default `delete_all` to `false` and return a clear `success:false` (not throw)
  when individual deletion is requested-but-unsupported.

## Impact
- Affected specs: `error-handling` (new capability)
- Affected code: `src/core/data.js`, `src/core/alerts.js`, `src/core/batch.js`, `src/core/ui.js`,
  `src/cli/router.js`, `src/tools/*` (verify wrappers), `tests/`
