# Change: Fix out-of-scope `evaluate` in three `chart.js` functions

## Why
`src/core/chart.js` imports the CDP helper under an alias (`import { evaluate as _evaluate, ... }`,
`src/core/chart.js:4`) and every function obtains the live reference via
`const { evaluate } = _resolve(_deps)`. Three functions were missed by the DI rollout
(`complete-dependency-injection-and-tests`) and call a **bare `evaluate(...)`** that does not exist in
module scope:
- `getVisibleRange()` — `src/core/chart.js:183`
- `scrollToDate()` — `src/core/chart.js:230`, `src/core/chart.js:242`
- `symbolInfo()` — `src/core/chart.js:264`

At runtime each throws `ReferenceError: evaluate is not defined`; the tool wrappers catch it and return
`{success:false, error:"evaluate is not defined"}`, so the MCP tools `chart_get_visible_range`,
`chart_scroll_to_date`, and `symbol_info` (and their CLI equivalents) are **permanently broken for all
inputs**. The defect ships green because `tests/e2e.test.js` exercises visible-range via its own
`evaluate`, bypassing the core function (audit 2026-06-26 finding S-1).

## What Changes
- `getVisibleRange`, `scrollToDate`, and `symbolInfo` SHALL accept an optional `_deps` bag and resolve
  `evaluate` through `_resolve(_deps)` before use, matching every other function in the module.
- A DI-mocked unit test SHALL call each of the three core functions with an injected `evaluate` and
  assert the function issues its `evaluate` call and returns the parsed result (so the regression cannot
  recur silently).

## Impact
- Affected specs: `chart-control` (new capability)
- Affected code: `src/core/chart.js`, `tests/` (new DI-mocked coverage for the three functions)
- No API/return-shape change for callers — this restores the documented behavior of three already-shipped
  tools. Pure bug fix surfaced as a proposal per the audit-to-OpenSpec workflow.
