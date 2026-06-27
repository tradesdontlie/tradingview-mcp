## ADDED Requirements

### Requirement: Finite-value arguments are constrained by enum
MCP tool arguments that accept a finite set of values SHALL be declared as enumerations so invalid values
are rejected at the schema boundary with a clear message, not deep in CDP logic.

#### Scenario: Invalid action rejected early
- **WHEN** `batch_run` is called with an action outside its enumerated set (e.g. a typo)
- **THEN** the MCP layer rejects the call with a validation error naming the allowed values

#### Scenario: Valid enum value accepted
- **WHEN** a tool is called with a value present in its enumeration
- **THEN** the call proceeds to the core function

### Requirement: Numeric and array arguments are bounded
Numeric arguments SHALL declare maximum bounds and array arguments SHALL declare maximum lengths at the
schema boundary, with the core enforcing total work caps as defense in depth.

#### Scenario: Oversized batch rejected
- **WHEN** `batch_run` is called with more symbols than the allowed maximum
- **THEN** the call is rejected before any symbol switching or screenshot writing occurs

#### Scenario: OHLCV count capped
- **WHEN** `data_get_ohlcv` is called with a count above the maximum
- **THEN** the request is rejected or clamped to the documented maximum

### Requirement: JSON inputs are parsed defensively
Tool/core code that parses caller-supplied JSON (study inputs, drawing overrides) SHALL catch parse
errors and surface a friendly message including a preview of the bad input.

#### Scenario: Malformed inputs JSON
- **WHEN** a caller passes malformed JSON for indicator inputs or drawing overrides
- **THEN** the operation fails with a message stating the value must be valid JSON
- **AND** no raw `SyntaxError` propagates uncaught

### Requirement: CLI numeric arguments are validated
The CLI SHALL validate required numeric arguments before invoking core functions and SHALL reject
missing or non-numeric values rather than passing `NaN` into CDP payloads.

#### Scenario: Missing required price
- **WHEN** a CLI command requiring a numeric price is run without one
- **THEN** the CLI reports a clear validation error and does not call the core function

### Requirement: DOM selectors use canonical sanitization
DOM selector strings built from caller-supplied values SHALL be constructed via the canonical
`safeString()` helper, not manual quote replacement.

#### Scenario: Selector injection attempt
- **WHEN** a value containing selector-breaking characters (quotes, brackets, backslashes) is supplied
- **THEN** the value is safely encoded and cannot terminate the selector or inject additional queries

### Requirement: Keyboard keys are validated and correctly mapped
`ui_keyboard` SHALL validate the requested key against a supported set and map it to the correct DOM
`code` and virtual-key value, including digits mapped to `Digit<n>`.

#### Scenario: Digit key
- **WHEN** `ui_keyboard` is asked to press a digit key
- **THEN** the dispatched event uses code `Digit<n>` (not `Key<n>`)

#### Scenario: Unsupported key
- **WHEN** `ui_keyboard` is given a key outside the supported set
- **THEN** the call is rejected rather than silently dispatching an incorrect event

### Requirement: Indicator object inputs respect declared order
When `chart_manage_indicator` receives inputs as an object, the system SHALL map them to the study's
declared positional input order rather than relying on object insertion order.

#### Scenario: Multi-input study via object
- **WHEN** a multi-input study is added with inputs supplied as an object
- **THEN** each value is applied to the input it names in the study's declared order

### Requirement: Unknown CLI flags error
The CLI argument parser SHALL run in strict mode so unknown flags produce an error instead of being
silently dropped.

#### Scenario: Typo'd flag
- **WHEN** a CLI command is run with a misspelled flag
- **THEN** the CLI reports an unknown-option error rather than ignoring it
