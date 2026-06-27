# pine-graphics Specification

## Purpose
TBD - created by archiving change optimize-batch-and-pine-graphics-roundtrips. Update Purpose after archive.
## Requirements
### Requirement: One-round-trip combined pine-graphics tool
The MCP surface SHALL provide a tool that returns all four pine-primitive types (lines, labels, tables,
boxes) in a single CDP round-trip, backed by `getAllGraphicsShaped()`. The full-report workflow SHALL be
able to obtain all pine graphics without issuing four separate per-type calls.

#### Scenario: combined tool fetches all four types in one round-trip
- **WHEN** the combined pine-graphics tool is called for a chart with Pine indicators
- **THEN** it returns `{ lines, labels, tables, boxes }` from a single `evaluate()` / one
  `model.dataSources()` scan

#### Scenario: per-type tools remain available
- **WHEN** a caller needs only one primitive type
- **THEN** the existing `data_get_pine_lines/labels/tables/boxes` tools still work unchanged

### Requirement: Batch get_ohlcv reads only the requested tail
The batch `get_ohlcv` action SHALL read only the last `N` bars via `valueAt()` from the series, and SHALL
NOT export and serialize the full chart history per iteration.

#### Scenario: batch get_ohlcv avoids full-history export
- **WHEN** the batch `get_ohlcv` action runs for a symbol with `ohlcv_count = N`
- **THEN** it reads the last `N` bars via a bounded `valueAt()` tail read and returns
  `{ bar_count, last_bar }`, without calling `exportData({ includeSeries: true })`

