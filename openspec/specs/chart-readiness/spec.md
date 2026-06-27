# chart-readiness Specification

## Purpose
TBD - created by archiving change verify-chart-readiness. Update Purpose after archive.
## Requirements
### Requirement: Readiness verifies the requested timeframe
The chart-readiness check SHALL verify the chart's actual resolution against the requested timeframe
(when one is provided), not only the symbol.

#### Scenario: Timeframe change confirmed
- **WHEN** `chart_set_timeframe` requests a new resolution
- **THEN** readiness is reported only after the chart's actual resolution matches the requested one

#### Scenario: Timeframe never applied
- **WHEN** the requested resolution never takes effect within the timeout
- **THEN** readiness reports a timeout (not ready)

### Requirement: Readiness probe is scoped to the chart series
The bar-count stability probe SHALL be scoped to the chart canvas/series container so unrelated UI
elements whose class names contain "bar" cannot satisfy it.

#### Scenario: Toolbar does not count as bars
- **WHEN** the chart series is still loading but toolbar/progress elements are present
- **THEN** the readiness probe does not report ready based on those non-series elements

### Requirement: Mutating operations fail on readiness timeout
Chart-mutating tools SHALL return `success: false` with an explanatory error when readiness times out,
rather than reporting success with a separate `chart_ready: false` flag. This applies to
`chart_set_symbol`, `chart_set_timeframe`, and each `batch_run` iteration.

#### Scenario: Symbol change times out
- **WHEN** `chart_set_symbol` is called and the chart never stabilizes within the timeout
- **THEN** the tool returns `success: false` with an error describing the timeout

#### Scenario: Batch iteration times out
- **WHEN** a `batch_run` iteration's chart never reaches the requested symbol/timeframe in time
- **THEN** that iteration is marked `success: false` so its data is not treated as valid

### Requirement: Study creation is confirmed by polling
After creating a study, the system SHALL poll for the new study's appearance (bounded) rather than
waiting a fixed delay before reading back the study list.

#### Scenario: New study appears
- **WHEN** an indicator is added
- **THEN** the system polls until the study list grows (or a max elapsed) before returning the new entity id

