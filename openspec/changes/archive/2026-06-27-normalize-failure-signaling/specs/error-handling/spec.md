## ADDED Requirements

### Requirement: Single failure channel
Core functions SHALL signal logical failure by throwing an `Error`. They SHALL NOT return a payload with
`success: true` that also carries an `error` field. The tools layer SHALL be the single place that
converts a thrown error into `{ success: false, error }`.

#### Scenario: Strategy read with no strategy present
- **WHEN** a strategy-data read (results/trades/equity) cannot find a strategy or the page reports an error
- **THEN** the core function throws
- **AND** the MCP tool returns `{ success: false, error }`

#### Scenario: Alert create button missing
- **WHEN** `alert_create` cannot locate the Create button in the dialog
- **THEN** the core `create()` throws rather than returning `{ success: false }` from a non-throwing path
- **AND** the tool surfaces `{ success: false, error }`

#### Scenario: Unknown batch action
- **WHEN** `batch_run` is given an action it does not implement
- **THEN** the result does not report the run as an unqualified success
- **AND** the failure is visible to the caller via `success: false`

### Requirement: Underlying errors are preserved
Error messages returned to the caller SHALL preserve the underlying cause. Generic hints SHALL NOT
replace a real exception message.

#### Scenario: OHLCV extraction throws
- **WHEN** the OHLCV extraction `evaluate()` throws (CDP drop, moved API path, page error)
- **THEN** the original error message is propagated to the caller
- **AND** the "chart may still be loading" hint is used only when extraction succeeded but returned zero bars

### Requirement: Partial parse failures are surfaced, not swallowed
Pine-graphics reads (lines/labels/tables/boxes) SHALL include a `_warnings` array describing studies
whose primitives could not be parsed, instead of silently dropping them.

#### Scenario: Internal shape changed for one study
- **WHEN** one study's primitives collection cannot be read while others succeed
- **THEN** the result still returns the studies that parsed
- **AND** `_warnings` contains an entry naming the failing study and the reason

### Requirement: CLI exit code reflects failure
The CLI SHALL exit with a non-zero status code when a command handler returns a result with
`success: false`.

#### Scenario: Failing command in a script
- **WHEN** a `tv` CLI command produces a `success: false` result
- **THEN** the process exits non-zero so scripts and CI detect the failure

### Requirement: Optional alert deletion mode
`alert_delete` SHALL treat `delete_all` as optional defaulting to `false` and SHALL return a clear
`success: false` (without throwing) when an unsupported individual deletion is requested.

#### Scenario: Called with no arguments
- **WHEN** `alert_delete` is invoked without `delete_all`
- **THEN** it does not throw an uncaught exception
- **AND** it returns `{ success: false, error }` explaining that individual deletion is unsupported
