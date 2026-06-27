# tab-management Specification

## Purpose
TBD - created by archiving change fix-tab-switch-cdp-reconnect. Update Purpose after archive.
## Requirements
### Requirement: Tab switch rebuilds the CDP session
When switching the active TradingView tab, the system SHALL rebuild the cached CDP session so that the
new tab becomes the target of all subsequent tool calls. Activating the tab in the UI without migrating
the CDP session SHALL NOT be considered a successful switch.

#### Scenario: Subsequent reads target the new tab
- **WHEN** `tab_switch` is called with a valid in-range index
- **THEN** the cached CDP client is invalidated and reconnected to the activated target id
- **AND** the next tool call (e.g. `chart_get_state`) returns data from the newly selected tab

#### Scenario: Out-of-range index is rejected
- **WHEN** `tab_switch` is called with an index ≥ the number of open chart tabs
- **THEN** the call throws an out-of-range error and does not alter the cached CDP session

### Requirement: CDP HTTP discovery uses a bounded deadline
All HTTP calls to the CDP debug endpoint (`/json/list`, `/json/activate/<id>`) SHALL use a request
deadline so a wedged TradingView cannot block a tool call indefinitely.

#### Scenario: Slow discovery aborts
- **WHEN** the CDP `/json/list` endpoint accepts the connection but does not respond within the deadline
- **THEN** the request is aborted and the operation fails fast with a connection error

### Requirement: Tab open/close are verified, not assumed
`tab_new` and `tab_close` SHALL confirm the open-tab count actually changed before reporting success,
rather than returning success after a fixed delay.

#### Scenario: New tab confirmed
- **WHEN** `tab_new` issues the new-tab shortcut
- **THEN** it polls the tab list until the count increases (bounded) before returning success
- **AND** if the count never increases within the bound, it reports failure

### Requirement: Shared CDP host/port configuration
Tab operations SHALL use the single `CDP_HOST`/`CDP_PORT` configuration exported by the connection layer
rather than redeclaring their own copies.

#### Scenario: Non-default port honored
- **WHEN** the connection layer is configured for a non-default CDP port
- **THEN** tab listing and activation use that same port

