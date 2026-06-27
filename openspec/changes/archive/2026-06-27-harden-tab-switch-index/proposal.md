# Change: Validate the `tab_switch` index lower bound

## Why
`switchTab()` guards only the upper bound of the tab index (`idx >= tabs.tab_count`,
`src/core/tab.js:126`), and the tool schema is `z.coerce.number()` with no `.int().nonnegative()`
(`src/tools/tab.js:13`). A negative or `NaN` index passes the `>=` check, then `tabs.tabs[idx]` is
`undefined` and `target.id` throws an opaque `TypeError: Cannot read properties of undefined (reading
'id')` instead of a clear out-of-range error (audit 2026-06-26 finding S-4). This is inconsistent with
the `pane.js` tools (which use `.int().nonnegative()`) and the `harden-input-validation` contract.

## What Changes
- The `tab_switch` tool schema SHALL constrain `index` to a non-negative integer
  (`z.coerce.number().int().nonnegative()`).
- `switchTab()` SHALL reject a negative, non-integer, `NaN`, or out-of-range index with the same clear
  "Tab index N out of range (have M tabs)" error it already produces for the upper bound — never an
  opaque `TypeError`.

## Impact
- Affected specs: `input-validation` (new capability)
- Affected code: `src/core/tab.js`, `src/tools/tab.js`, `tests/`
- Extends `harden-input-validation` to the one tool it missed; no API change for valid inputs.
