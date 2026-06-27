## ADDED Requirements

### Requirement: TradingView API paths reference KNOWN_PATHS only
Core modules SHALL reference the TradingView internal API paths through `KNOWN_PATHS` (or a local alias
of a `KNOWN_PATHS` member) and SHALL NOT redeclare the path strings as inline literals. `pine.js` SHALL
reuse `KNOWN_PATHS.pineFacadeApi` rather than re-deriving the pine-facade base URL.

#### Scenario: chart and collection paths come from KNOWN_PATHS
- **WHEN** `data.js`, `pane.js`, or `stream.js` builds an `evaluate()` payload referencing the chart API
  or chart-widget-collection path
- **THEN** the path is sourced from `KNOWN_PATHS.chartApi` / `KNOWN_PATHS.chartWidgetCollection`, not a
  hardcoded `window.TradingViewApi...` literal

#### Scenario: pine-facade base URL has a single definition
- **WHEN** `pine.js` needs the pine-facade base URL
- **THEN** it uses `KNOWN_PATHS.pineFacadeApi` (including its `PINE_FACADE_URL` override and
  trailing-slash trim), with no duplicate env-resolution in `pine.js`

#### Scenario: substitution is behavior-preserving
- **WHEN** the literals are replaced by `KNOWN_PATHS` references
- **THEN** the resulting expression strings are identical and the existing test suite passes unchanged
