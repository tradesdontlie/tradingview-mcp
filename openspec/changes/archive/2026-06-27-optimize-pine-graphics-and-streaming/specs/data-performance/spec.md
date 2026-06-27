## ADDED Requirements

### Requirement: Filtered graphics reads skip non-matching studies early
When a `study_filter` is provided, pine-graphics extraction SHALL skip non-matching studies before any
deep primitive traversal, so the cost is proportional to the matched studies, not all studies.

#### Scenario: Filter matches one study among many
- **WHEN** `data_get_pine_lines` is called with a `study_filter` matching one of many studies
- **THEN** only the matching study's primitives are traversed

### Requirement: Study values support filtering and are numeric
`data_get_study_values` SHALL accept an optional `study_filter` and SHALL return numeric values (or
explicitly document any stringified format in its schema).

#### Scenario: Filtered numeric values
- **WHEN** `data_get_study_values` is called with a `study_filter`
- **THEN** only matching studies are read
- **AND** their values are returned as numbers (not pre-formatted strings, unless documented)

### Requirement: Stream dedup avoids full re-serialization
Stream deduplication SHALL compare a shallow per-stream fingerprint rather than re-serializing the entire
payload each cycle, and the emitted line SHALL be serialized only once.

#### Scenario: Unchanged poll suppressed cheaply
- **WHEN** consecutive stream polls return equivalent data
- **THEN** the duplicate is suppressed using the fingerprint without a full payload `JSON.stringify`

#### Scenario: Changed poll emitted once
- **WHEN** a stream poll returns changed data
- **THEN** the output line is serialized a single time for emission
