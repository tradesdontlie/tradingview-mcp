## ADDED Requirements

### Requirement: tab_switch rejects invalid indices with a clear error
The `tab_switch` tool SHALL constrain its `index` argument to a non-negative integer, and `switchTab()`
SHALL reject a negative, non-integer, `NaN`, or out-of-range index with a clear "out of range" error
before indexing the tab list. It SHALL NOT surface an opaque `TypeError` for these inputs.

#### Scenario: negative index is rejected clearly
- **WHEN** `tab_switch` is called with `index: -1`
- **THEN** it fails with "Tab index -1 out of range (have N tabs)" (not "Cannot read properties of
  undefined")

#### Scenario: NaN / non-integer index is rejected clearly
- **WHEN** `tab_switch` is called with a `NaN` or fractional index
- **THEN** it fails with the clear out-of-range error rather than throwing a `TypeError` deeper in the
  function

#### Scenario: valid index still switches
- **WHEN** `tab_switch` is called with a valid in-range index
- **THEN** the tab is activated and the CDP session reconnects as before
