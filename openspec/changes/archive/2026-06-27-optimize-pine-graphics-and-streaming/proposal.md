# Change: Optimize pine-graphics extraction and stream dedup

## Why
`buildGraphicsJS()` (`src/core/data.js:11-60`) is an O(studies × primitives) hot path used by four tools
(`data_get_pine_lines/labels/tables/boxes`). It rebuilds a ~35-line JS payload on every call and iterates
**all** data sources and primitives even when `study_filter` is provided — the filter is tested only
after `metaInfo()`/name extraction per source. With 10 studies × 50 primitives that's ~500 traversals
per call × 4 calls per report, multiplied again by `batch_run` (A1 P-1, A2 P-1, A3 P-1, A5 P-1).
Separately, `data_get_study_values` has no `study_filter` and always reads every study (A2 P-5); it also
returns indicator values as **strings** via `.toFixed(2)`, forcing consumers to re-parse (A3 B-6). And
the stream loop re-`JSON.stringify`s the entire payload every poll cycle just to compute a dedup hash —
~30KB/s of needless serialization at default intervals (A1 P-2, A2 P-2, A3 P-2/P-3, A5 P-2).

## What Changes
- When `study_filter` is set, pine-graphics extraction SHALL skip non-matching studies **before** deep
  primitive traversal.
- The four pine-graphics readers SHOULD share a single CDP round-trip that returns all primitive types,
  split client-side (eliminates 4× payload rebuilds).
- `data_get_study_values` SHALL accept an optional `study_filter` matching the pine-graphics tools.
- **BREAKING**: indicator values SHALL be returned as numbers (or the existing stringification documented
  explicitly in the tool schema).
- Stream dedup SHALL use a shallow fingerprint (e.g. key fields like time/close/volume or
  entity-id+plots), not a full `JSON.stringify`, and SHALL serialize the emitted line only once.

## Impact
- Affected specs: `data-performance` (new capability)
- Affected code: `src/core/data.js`, `src/core/stream.js`, `src/tools/data.js`, `tests/`
