## 1. Constrain the schema
- [x] 1.1 In `src/tools/tab.js:13`, change the `index` schema to
      `z.coerce.number().int().nonnegative()` (matching the `pane.js` tools).

## 2. Guard the core lower bound
- [x] 2.1 In `src/core/tab.js` `switchTab()`, after `const idx = Number(index)`, reject
      `!Number.isInteger(idx) || idx < 0 || idx >= tabs.tab_count` with the existing clear
      "Tab index N out of range (have M tabs)" error, before indexing `tabs.tabs[idx]`.

## 3. Tests
- [x] 3.1 Unit test (DI-mocked `list`): `switchTab({ index: -1 })` and `switchTab({ index: NaN })` throw
      the clear out-of-range error, not a `TypeError`.

## 4. Validate
- [x] 4.1 `openspec validate harden-tab-switch-index --strict`
