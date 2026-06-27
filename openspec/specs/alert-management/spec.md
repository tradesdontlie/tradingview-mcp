# alert-management Specification

## Purpose
TBD - created by archiving change apply-alert-condition. Update Purpose after archive.
## Requirements
### Requirement: alert_create applies the requested condition
`alert_create` SHALL set the alert condition control in the dialog to the requested condition
(`crossing`, `crossing_up`, or `crossing_down`) before submitting the alert. It SHALL NOT rely on the
dialog's pre-selected default. The accepted `condition` values SHALL match the operators the live
TradingView alert dialog actually offers for a price alert ("Crossing", "Crossing Up", "Crossing Down").

#### Scenario: Requested condition is selected before Create
- **WHEN** `alert_create` is called with `condition: "crossing_up"`
- **THEN** the dialog's condition control is set to "Crossing Up" before the Create button is clicked

#### Scenario: Default condition is not silently accepted
- **WHEN** the dialog opens with a different pre-selected condition than the one requested
- **THEN** the requested condition is applied, overriding the pre-selected default

### Requirement: alert_create returns the verified condition
`alert_create` SHALL read back the condition the dialog actually holds and return that confirmed value.
The result SHALL NOT echo the requested condition without verifying it, and SHALL allow the caller to
tell the requested condition apart from the confirmed condition.

#### Scenario: Confirmed condition is reported
- **WHEN** an alert is created successfully with the requested condition applied
- **THEN** the result reports the condition read back from the dialog as the confirmed value, distinct
  from the requested value (e.g. `condition_requested` + `condition`)

#### Scenario: Requested and confirmed condition are distinguishable
- **WHEN** the result is returned
- **THEN** the caller can determine both what was requested and what was confirmed on the alert

### Requirement: Unapplicable condition is a failure
`alert_create` SHALL fail (`success: false` or throw) when the condition control cannot be located, the
requested condition is not offered by the dialog, or the read-back does not match the requested
condition, so that no alert is reported as successful with an unverified condition.

#### Scenario: Condition control missing
- **WHEN** the alert dialog exposes no recognizable condition control
- **THEN** `alert_create` returns `success: false` (or throws) with an error explaining the condition
  could not be applied, and does not report a successful alert

#### Scenario: Requested condition unavailable
- **WHEN** the requested condition is not offered by the dialog for the current symbol/context
- **THEN** `alert_create` fails with an explanatory error instead of creating an alert with a different
  condition

#### Scenario: Applied condition does not verify
- **WHEN** the condition is selected but the dialog reads back a different condition than requested
- **THEN** `alert_create` fails instead of clicking Create, so a mismatched alert is never created

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

