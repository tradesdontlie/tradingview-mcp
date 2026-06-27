## MODIFIED Requirements

### Requirement: Optional alert deletion mode
`alert_delete` SHALL accept either `alert_ids` (a single alert id or an array of ids) or
`delete_all: true`, and SHALL delete the targeted alerts via the pricealerts REST API. `delete_all`
remains optional defaulting to `false`. When neither `alert_ids` nor `delete_all` is supplied, or when the
REST call returns a non-`ok` status, `deleteAlerts()` SHALL THROW an `Error` from core — so the tool
wrapper converts it into `{ success: false, error }` with the MCP `isError` flag set — rather than
returning a non-throwing `{ success: false }` payload directly from core. (This supersedes the prior
"individual deletion unsupported" contract: per-id deletion is now supported.)

#### Scenario: Called with no target
- **WHEN** `alert_delete` is invoked without `alert_ids` and without `delete_all`
- **THEN** `deleteAlerts()` throws an `Error` explaining that an id or `delete_all` is required
- **AND** the tool surfaces `{ success: false, error }` with the MCP `isError` flag set

#### Scenario: Delete by id
- **WHEN** `alert_delete` is invoked with one or more `alert_ids`
- **THEN** `deleteAlerts()` deletes exactly those alerts and returns the deleted ids on success

#### Scenario: REST call fails
- **WHEN** the pricealerts API returns a non-`ok` status (or a transport error)
- **THEN** `deleteAlerts()` throws an `Error` carrying the failure, instead of reporting success
