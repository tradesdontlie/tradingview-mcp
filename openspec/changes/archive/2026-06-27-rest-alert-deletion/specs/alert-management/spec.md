## ADDED Requirements

### Requirement: Delete alerts via the pricealerts API
`deleteAlerts()` SHALL remove alerts through `POST https://pricealerts.tradingview.com/delete_alerts`
using a `text/plain` body of the form `{"payload":{"alert_ids":[...]}}`, rather than driving the alerts
context menu. It SHALL support deleting a specific id, an array of ids, or — with `delete_all` — every
currently listed alert (its ids obtained from `list()`).

#### Scenario: Delete specific alerts
- **WHEN** `deleteAlerts({ alert_ids: [id1, id2] })` is called
- **THEN** exactly those alerts are deleted via the REST API
- **AND** the result reports `deleted_count` and `deleted_ids` for the deleted alerts

#### Scenario: Delete all alerts
- **WHEN** `deleteAlerts({ delete_all: true })` is called
- **THEN** the current alert ids are read from `list()` and all are deleted via the REST API

#### Scenario: Nothing to delete with delete_all
- **WHEN** `deleteAlerts({ delete_all: true })` is called and no alerts exist
- **THEN** it succeeds with `deleted_count: 0` rather than failing
