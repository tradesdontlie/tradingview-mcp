## 1. Enum + bounds in MCP schemas
- [x] 1.1 `z.enum` for `batch_run.action`, `capture.region`, `capture.method`, `alert.condition`,
      `chart_set_type.chart_type`, `draw_shape.shape`, `replay_trade.action`, `pane.layout`.
- [x] 1.2 Add `.max()` to numeric args (`count ≤ 500`, `max_labels ≤ 200`, `max_trades ≤ 20`).
- [x] 1.3 Add array-length caps: `batch_run.symbols ≤ 20`, `timeframes ≤ 10`; enforce a total-iteration
      cap in `src/core/batch.js`.

## 2. Defensive JSON parsing
- [x] 2.1 Wrap `JSON.parse(inputsRaw/overridesRaw)` in `chart.js:89`, `drawing.js:12`, `indicators.js:9`
      with try/catch → throw `Error('… must be valid JSON; got: <preview>')`.

## 3. CLI numeric validation + strict flags
- [x] 3.1 Validate required numeric args (price, time, index, …) in `src/cli/commands/*` before calling
      core; reject `NaN`/missing with a clear error.
- [x] 3.2 Set `parseArgs({ strict: true })` in `src/cli/router.js`; let unknown flags error.

## 4. Selector + keyboard hardening
- [x] 4.1 Replace manual `.replace(/"/g, …)` in `src/core/ui.js` `click`/`hover`/`findElement` with
      `safeString()` interpolation.
- [x] 4.2 Validate `ui_keyboard.key` against a supported set; branch digits → `Digit<n>`, letters →
      `Key<X>` with correct virtual-key codes.

## 5. Indicator input ordering + ui_evaluate note
- [x] 5.1 In `chart_manage_indicator`, resolve object-keyed inputs against the study's declared input
      order (or require an ordered array for add-time overrides).
- [x] 5.2 Update `ui_evaluate` tool description to warn it bypasses sanitization and has full page access.

## 6. Tests
- [x] 6.1 Schema tests: invalid enum/over-cap values are rejected at the MCP boundary.
- [x] 6.2 Sanitization test: a `value` containing `"]` does not break out of the selector.
- [x] 6.3 Keyboard test: an unmapped/digit key maps to the correct `code`.
- [x] 6.4 JSON test: malformed inputs/overrides yield a friendly error, not a raw `SyntaxError`.

## 7. Validate
- [x] 7.1 `openspec validate harden-input-validation --strict`
