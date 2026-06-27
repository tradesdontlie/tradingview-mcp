# maintainability Specification

## Purpose
TBD - created by archiving change consolidate-shared-constants-and-timing. Update Purpose after archive.
## Requirements
### Requirement: Canonical TradingView API paths
Modules SHALL reference the shared `KNOWN_PATHS` definitions for TradingView internal API paths rather
than redeclaring path literals.

#### Scenario: API path changes in one place
- **WHEN** the TradingView chart-API path changes
- **THEN** updating `KNOWN_PATHS.chartApi` is sufficient and no module carries a divergent literal

### Requirement: Timing delays are named and justified
Fixed timing delays SHALL be defined as named constants with a comment explaining the value, rather than
inline magic numbers.

#### Scenario: Tuning a delay
- **WHEN** a maintainer needs to adjust a UI-timing delay
- **THEN** the value is a single named constant with a rationale comment

### Requirement: Shared helpers for duplicated logic
Repeated logic SHALL be factored into shared helpers: a generic poll-until utility, the compile-button
finder, the strategy finder, and the bar-index range search.

#### Scenario: Poll-until reused
- **WHEN** code needs to wait for a condition with an interval and timeout
- **THEN** it uses the shared `pollUntil` helper rather than a hand-rolled loop

### Requirement: Single source of truth for tool count
The advertised tool count SHALL come from a single source so server instructions, CLI banner, and docs do
not drift.

#### Scenario: Tool added or removed
- **WHEN** the set of registered tools changes
- **THEN** the count shown to LLMs (server instructions), the CLI banner, and the docs agree

### Requirement: Configurable Pine REST endpoint
The Pine REST base URL SHALL be overridable via an environment variable, defaulting to the current URL.

#### Scenario: Proxy environment
- **WHEN** the Pine REST base URL env var is set
- **THEN** Pine compile/translate/open requests use the configured URL

### Requirement: Node engine declared
The package manifest SHALL declare a minimum Node version consistent with the runtime features used.

#### Scenario: Install on old Node
- **WHEN** the package is installed under a Node version below the declared minimum
- **THEN** the package manager surfaces an engine warning

### Requirement: Replay stop hides the replay toolbar
`replay_stop` SHALL hide the replay toolbar before returning so the UI does not remain in replay chrome.

#### Scenario: Stop returns to realtime
- **WHEN** `replay_stop` is invoked
- **THEN** replay is stopped and the replay toolbar is hidden

