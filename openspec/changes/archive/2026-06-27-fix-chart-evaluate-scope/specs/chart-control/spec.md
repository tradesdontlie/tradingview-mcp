## ADDED Requirements

### Requirement: Visible-range, scroll-to-date, and symbol-info resolve `evaluate` via DI
`getVisibleRange`, `scrollToDate`, and `symbolInfo` in `src/core/chart.js` SHALL obtain the CDP
`evaluate` helper through `_resolve(_deps)` (accepting an optional `_deps` bag), exactly as the other
functions in the module do. They SHALL NOT reference a bare `evaluate` identifier that is absent from
module scope.

#### Scenario: chart_get_visible_range returns the range instead of a ReferenceError
- **WHEN** `chart_get_visible_range` is invoked against a ready chart
- **THEN** the core `getVisibleRange` resolves `evaluate` and returns `{ success: true, visible_range,
  bars_range }`, and the tool does not return `error: "evaluate is not defined"`

#### Scenario: chart_scroll_to_date applies the scroll
- **WHEN** `chart_scroll_to_date` is invoked with a valid ISO date
- **THEN** `scrollToDate` resolves `evaluate`, issues its zoom call, and returns `{ success: true }`
  without throwing a `ReferenceError`

#### Scenario: symbol_info returns symbol metadata
- **WHEN** `symbol_info` is invoked against a ready chart
- **THEN** `symbolInfo` resolves `evaluate` and returns the symbol/exchange/resolution fields without a
  `ReferenceError`

### Requirement: DI seam is covered by an offline unit test
The three functions SHALL be exercised by a unit test that injects a mock `evaluate` via `_deps`, so a
future regression that drops the DI resolution fails the test rather than only the live tool.

#### Scenario: injected evaluate proves the functions run offline
- **WHEN** the unit test calls `getVisibleRange`, `scrollToDate`, and `symbolInfo` with
  `_deps.evaluate` set to a fake
- **THEN** each function calls the injected `evaluate` and returns its shaped result with no thrown
  `ReferenceError`
