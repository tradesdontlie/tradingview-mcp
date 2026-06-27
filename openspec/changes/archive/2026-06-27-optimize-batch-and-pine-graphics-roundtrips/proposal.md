# Change: Realize the one-round-trip pine-graphics and batch-OHLCV paths

## Why
Two CDP round-trip optimizations are present in the code but unrealized (audit 2026-06-26 findings P-1,
P-2):

- `optimize-pine-graphics-and-streaming` landed `getAllGraphics()`/`getAllGraphicsShaped()`
  (`src/core/data.js:167-192`) to fetch all four pine-primitive types in **one** `evaluate()` with one
  `model.dataSources()` scan, but the helpers are **dead code** — only `data.js` and `tests/data.test.js`
  reference them. The four `data_get_pine_*` tools (`src/tools/data.js:54,63,70,78`) still each call a
  per-type reader, so the CLAUDE.md "Analyze my chart" / report pipeline pays **four** CDP round-trips
  and four full study scans where one would do.
- The batch `get_ohlcv` action (`src/core/batch.js:98-108`) calls `exportData({includeSeries:true})`,
  which materializes and serializes the entire chart history in-page on every iteration (up to
  `MAX_BATCH_ITERATIONS` = 50), then keeps only the last `N` bars. `getOhlcv()` already shows the cheap
  tail-read via `bars.valueAt(i)` from `lastIndex()-limit` (`src/core/data.js:200-213`).

## What Changes
- A single MCP tool (e.g. `data_get_pine_graphics`) SHALL return all four pine-primitive types in one CDP
  round-trip, backed by `getAllGraphicsShaped()`. The four existing per-type tools remain for targeted
  use. **(non-breaking — additive tool.)**
- The batch `get_ohlcv` action SHALL read only the requested tail via `valueAt()` (as `getOhlcv` does),
  instead of exporting the full chart history per iteration.

## Impact
- Affected specs: `pine-graphics` (new capability)
- Affected code: `src/core/data.js` (wire `getAllGraphicsShaped`), `src/tools/data.js` (new tool),
  `src/core/batch.js` (tail-read), `tests/`
- Completes the round-trip economy `optimize-pine-graphics-and-streaming` set out to achieve.
