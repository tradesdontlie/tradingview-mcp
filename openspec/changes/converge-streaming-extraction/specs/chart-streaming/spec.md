## ADDED Requirements

### Requirement: Streaming extraction matches the live data extraction
The `stream.js` extractors for study values and pine graphics SHALL read the same series and primitive
paths used by `src/core/data.js`, so that for a given chart state the `stream values/lines/labels/tables`
outputs are equivalent to the corresponding `data_get_study_values` / `data_get_pine_*` results. The
streaming surface SHALL NOT read the `dataWindow`/`_lastBarValues`/`_data` paths that `data.js` abandoned
as empty-or-stale for headless callers.

#### Scenario: streamed values match the data tool
- **WHEN** a study has computed last-bar values that `data_get_study_values` returns
- **THEN** the `stream values` output reports the same numeric values for that study, not an empty set

#### Scenario: streamed pine graphics match the data tool
- **WHEN** a Pine indicator draws lines/labels/tables that `data_get_pine_*` returns
- **THEN** the `stream lines/labels/tables` output reports the same primitives, read from the same
  `_primitivesDataById` path `data.js` uses

### Requirement: The stream poll loop bounds all persistent errors
The `stream.js` poll loop SHALL apply a consecutive-error counter, backoff, and terminal escalation to
every caught error, not only transport (`CDP`/`ECONNREFUSED`) errors. A persistent non-transport error
SHALL NOT produce an unbounded per-interval log loop.

#### Scenario: a persistent non-CDP error backs off and terminates
- **WHEN** the polled extraction throws the same non-transport error every cycle (e.g. a moved API path)
- **THEN** the loop increases its delay via backoff and, after a bounded number of consecutive failures,
  emits a terminal escalation and stops instead of logging at the base interval forever

### Requirement: Stream extractors have an offline test seam
The stream extractors SHALL accept injected dependencies (`_deps`) and be covered by an offline unit
test that asserts parity with the `data.js` extraction for a fixed mock chart state.

#### Scenario: parity test catches divergence
- **WHEN** the stream extractors and `data.js` are run against the same injected mock page state
- **THEN** the unit test asserts equivalent output, failing if the two extractors diverge again
