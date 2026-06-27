# Change: Harden input validation at the MCP and CLI boundaries

## Why
Inputs are under-validated at every boundary, pushing failures deep into CDP where they surface as
opaque errors — or not at all:
- Many MCP schemas use `z.string()` for finite-value arguments: `batch_run.action`, `capture.region`,
  `capture.method`, `alert.condition`, `chart_set_type.chart_type`, `draw_shape.shape`,
  `replay_trade.action`, `pane.layout` (A1 B-1/B-2/B-3, A2 B-3, A3 B-8/B-9, A5 B-3). Typos and invented
  values pass validation and fail late.
- Numeric args have no `.max()` and arrays no length cap: `data_get_ohlcv.count`, `max_labels`,
  `max_trades`, and especially `batch_run.symbols`/`timeframes` — an unbounded `symbols` list with the
  2s default delay can block for minutes and write unbounded screenshots (A3 S-4/B-10/B-11).
- `JSON.parse` on `inputsRaw`/`overridesRaw` is unguarded in `chart.js:89`, `drawing.js:12`,
  `indicators.js:9` — malformed JSON throws a raw `SyntaxError` (A3 S-8/S-14).
- The CLI passes `Number(undefined) → NaN` straight through to CDP payloads (`alerts/drawing/pane/tab/
  chart/ui` commands) with no validation (A2 B-2).
- `ui.js` builds `querySelector` strings with manual `.replace(/"/g, …)` escaping that misses
  backslashes/newlines, bypassing the canonical `safeString()` — a DOM-injection surface
  (A2 S-1, A3 S-9).
- `ui_keyboard` accepts any string; unmapped keys get wrong `code`/virtual-key values (e.g. `Key1`
  instead of `Digit1`) and silently no-op (A2 S-7, A3 S-15).
- `chart_manage_indicator` maps object inputs by insertion order via `Object.values`, which can permute
  positional study inputs (A5 S-5).
- CLI `parseArgs` runs `strict: false`, so `--summery` (typo) is silently dropped (A3 B-15).
- `ui_evaluate` is a raw-JS escape hatch but its description doesn't warn that it bypasses sanitization
  (A3 B-16).

## What Changes
- Replace `z.string()` with `z.enum([...])` for all finite-value args; add `.max()` numeric bounds and
  `.max(N)` array-length caps (`symbols ≤ 20`, `timeframes ≤ 10`, `count ≤ 500`, `max_labels ≤ 200`,
  `max_trades ≤ 20`).
- Wrap `JSON.parse` of inputs/overrides in try/catch and throw a friendly "must be valid JSON" error.
- Validate required numeric CLI args before calling core; reject `NaN` with a clear message.
- Replace manual selector escaping in `ui.js` with `safeString()`-based interpolation.
- Validate `ui_keyboard.key` against a supported set and map digits to `Digit<n>` codes.
- `chart_manage_indicator` SHALL resolve object inputs against the study's declared input order (or
  require an ordered array).
- Set CLI `parseArgs` `strict: true` so unknown flags error.
- Update the `ui_evaluate` description to warn it bypasses sanitization and runs with full page access.

## Impact
- Affected specs: `input-validation` (new capability)
- Affected code: `src/tools/{batch,capture,chart,alerts,drawing,replay,pane,ui}.js`,
  `src/core/{chart,drawing,indicators,ui}.js`, `src/cli/router.js`, `src/cli/commands/*`, `tests/`
