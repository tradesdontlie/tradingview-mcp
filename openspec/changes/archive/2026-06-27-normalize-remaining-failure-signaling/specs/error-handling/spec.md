## MODIFIED Requirements

### Requirement: Optional alert deletion mode
`alert_delete` SHALL treat `delete_all` as optional defaulting to `false`, and SHALL signal an
unsupported individual deletion by THROWING an `Error` from core — so the tool wrapper converts it into
`{ success: false, error }` with the MCP `isError` flag set — rather than returning a non-throwing
`{ success: false }` payload directly from core. (This supersedes the prior non-throwing contract from
`normalize-failure-signaling`, aligning `deleteAlerts()` with the core-throws failure-signaling rule.)

#### Scenario: Called with no arguments
- **WHEN** `alert_delete` is invoked without `delete_all`
- **THEN** `deleteAlerts()` throws an `Error` explaining that individual deletion is unsupported
- **AND** the tool surfaces `{ success: false, error }` with the MCP `isError` flag set
