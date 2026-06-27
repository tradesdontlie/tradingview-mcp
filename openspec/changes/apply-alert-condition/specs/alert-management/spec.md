## ADDED Requirements

### Requirement: alert_create applies the requested condition
`alert_create` SHALL set the alert condition control in the dialog to the requested condition
(`crossing`, `greater_than`, or `less_than`) before submitting the alert. It SHALL NOT rely on the
dialog's pre-selected default.

#### Scenario: Requested condition is selected before Create
- **WHEN** `alert_create` is called with `condition: "greater_than"`
- **THEN** the dialog's condition control is set to "greater than" before the Create button is clicked

#### Scenario: Default condition is not silently accepted
- **WHEN** the dialog opens with a different pre-selected condition than the one requested
- **THEN** the requested condition is applied, overriding the pre-selected default

### Requirement: alert_create returns the verified condition
`alert_create` SHALL read back the condition the dialog actually holds and return that confirmed value.
The result SHALL NOT echo the requested condition without verifying it, and SHALL allow the caller to
tell the requested condition apart from the confirmed condition.

#### Scenario: Confirmed condition is reported
- **WHEN** an alert is created successfully with the requested condition applied
- **THEN** the result reports the condition read back from the dialog as the confirmed value

#### Scenario: Requested and confirmed condition are distinguishable
- **WHEN** the result is returned
- **THEN** the caller can determine both what was requested and what was confirmed on the alert

### Requirement: Unapplicable condition is a failure
`alert_create` SHALL fail (`success: false` or throw) when the condition control cannot be located or
the requested condition cannot be selected, so that no alert is reported as successful with an
unverified condition.

#### Scenario: Condition control missing
- **WHEN** the alert dialog exposes no recognizable condition control
- **THEN** `alert_create` returns `success: false` (or throws) with an error explaining the condition
  could not be applied, and does not report a successful alert

#### Scenario: Requested condition unavailable
- **WHEN** the requested condition is not offered by the dialog for the current symbol/context
- **THEN** `alert_create` fails with an explanatory error instead of creating an alert with a different
  condition
