## 1. Resolve `evaluate` via DI in the three functions
- [x] 1.1 In `src/core/chart.js` `getVisibleRange()`, change the signature to accept `{ _deps } = {}`
      and add `const { evaluate } = _resolve(_deps);` before the `await evaluate(...)` at line 183.
- [x] 1.2 In `scrollToDate()`, accept `_deps` and resolve `evaluate` so both call sites (`:230`, `:242`)
      use the resolved reference.
- [x] 1.3 In `symbolInfo()`, accept `_deps` and resolve `evaluate` for the call at `:264`.
- [x] 1.4 Confirm the tool registrars (`src/tools/chart.js`) and CLI commands still call these with no
      args — `_deps` stays optional and defaults to the real `connection.js` imports.

## 2. Tests
- [x] 2.1 Add a DI-mocked unit test (e.g. `tests/chart.test.js`) that calls `getVisibleRange`,
      `scrollToDate`, and `symbolInfo` with `{ _deps: { evaluate: fake } }` and asserts each invokes the
      injected `evaluate` and returns the shaped result — proving no `ReferenceError`.

## 3. Validate
- [x] 3.1 `openspec validate fix-chart-evaluate-scope --strict`
