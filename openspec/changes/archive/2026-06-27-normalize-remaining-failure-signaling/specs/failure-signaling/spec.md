## ADDED Requirements

### Requirement: List functions throw instead of returning success-with-error
`alerts.list()` and `pine.listScripts()` SHALL throw on a page-side failure (an `error` in the extracted
payload) so the tool layer wraps it into `{ success: false, error }`. They SHALL NOT return
`{ success: true }` with an embedded `error` field.

#### Scenario: alert list failure surfaces as success:false
- **WHEN** the alert REST extraction fails and returns `{ alerts: [], error: "<msg>" }`
- **THEN** `alerts.list()` throws and `alert_list` returns `{ success: false, error: "<msg>" }` with the
  MCP `isError` flag, not `{ success: true, error: "<msg>" }`

#### Scenario: script list failure surfaces as success:false
- **WHEN** the pine-facade extraction fails and returns `{ scripts: [], error: "<msg>" }`
- **THEN** `pine.listScripts()` throws and the tool returns `{ success: false, error: "<msg>" }`

### Requirement: deleteAlerts throws for unsupported operations
`alerts.deleteAlerts()` SHALL throw for the unsupported individual-deletion branch instead of returning a
`{ success: false }` shape directly from core, so the tool wrapper sets the MCP `isError` flag.

#### Scenario: unsupported deletion is an error response
- **WHEN** `alert_delete` is called without `delete_all: true`
- **THEN** `deleteAlerts()` throws and the tool returns `{ success: false, error: "..." }` with the MCP
  `isError` flag set
