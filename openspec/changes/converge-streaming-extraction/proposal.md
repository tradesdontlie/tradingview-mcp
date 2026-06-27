# Change: Converge `stream.js` extraction with `data.js` and bound its error loop

## Why
Commit `897366e` (`optimize-pine-graphics-and-streaming`) converged `src/core/data.js` onto the
deterministic extraction paths — study values from `_study.data()._items` and pine graphics from
`_primitivesCollection…_primitivesDataById` — and documented that the old `dataWindow`/last-bar-cache
paths are "empty (or stale...) for headless callers" (`src/core/data.js:493-501`). The streaming module
was only given fingerprint dedup in that commit; its extractors were **not migrated** and still read the
abandoned shapes (audit 2026-06-26 findings S-2, R4-2):
- `fetchValues` reads `src._lastBarValues || src._data` (`src/core/stream.js:207-208`)
- `fetchLines`/`fetchLabels`/`fetchTables` read `line.points[0].price` / `pc.ownFirstValue()` /
  `table.data[r][c].text` — object shapes `data.js` no longer uses.

So `stream values/lines/labels/tables` can silently emit empty/stale studies where the equivalent
`data_*` tools now succeed, and the two extractors will drift further on any TradingView-side change.
Separately, the stream poll loop only applies escalation/backoff to transport errors — a persistent
non-CDP error (e.g. a moved API path) logs every interval forever with no cap (finding S-3). Neither the
extractors nor the readiness contract have unit coverage (findings R4-3, R4-4).

## What Changes
- The `stream.js` `fetch*` extractors SHALL read the same series/primitive paths `data.js` uses, so the
  live and streaming surfaces return equivalent data for the same chart state. Where practical they
  SHALL share the `data.js` payload builders rather than maintaining a second extractor.
- The `stream.js` poll loop SHALL bound **all** persistent errors (not only `/CDP|ECONNREFUSED/`) with a
  consecutive-error counter, backoff, and a terminal escalation, so a non-transport failure cannot spin
  an unbounded log loop.
- The stream extractors SHALL gain offline unit coverage asserting parity with the `data.js` extraction
  for a fixed mock chart state. The stream functions already accept a `_deps` bag
  (`streamValues`/`streamLines`/… at `src/core/stream.js:158-442`), so this change reuses that existing
  seam rather than adding a new one.

## Impact
- Affected specs: `chart-streaming` (new capability)
- Affected code: `src/core/stream.js`, `src/core/data.js` (extracted shared builders), `tests/`
- Coordinates with `optimize-pine-graphics-and-streaming` (completes the streaming half it began) and
  `improve-cdp-connection-resilience` (the loop's transport-error handling). See `design.md` for the
  share-vs-duplicate decision.
