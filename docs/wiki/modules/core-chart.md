---
title: src/core/chart.js — chart state & mutations
type: module
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/core/chart.js
related:
  - "[[chart-ready-polling]]"
  - "[[evaluate-and-known-paths]]"
  - "[[cdp-injection-safety]]"
  - "[[catalog]]"
---

# Module: src/core/chart.js

Reads and mutates the chart: symbol, timeframe, type, indicators, visible range,
scroll-to-date. ~249 lines. Backs the `chart_*` tool group.

## The DI seam lives here

`_resolve(deps)` (`src/core/chart.js:9-16`) returns
`{ evaluate, evaluateAsync, waitForChartReady }`, defaulting to the real imports.
Every exported function takes an optional `_deps` and destructures from
`_resolve(_deps)`. This is the canonical test seam for the whole repo — fakes are
injected so `chart.js` logic (incl. sanitization) is unit-tested without a live
TV. New CDP-touching core fns should copy this pattern.

## Functions

| Function | Notes |
|----------|-------|
| `getState()` | symbol, timeframe, type, list of studies w/ entity IDs. **Call once**, reuse IDs (see [[context-management]]). |
| `setSymbol({symbol})` | issues change via `CHART_API`, `waitForChartReady(symbol)`, then reads back the actual symbol; returns `success:false` if the switch didn't take. See [[chart-ready-polling]]. |
| `setTimeframe({timeframe})` | resolution change. |
| `setType({chart_type})` | accepts name or number (Candles=1, HeikinAshi=8, …). |
| `manageIndicator({action,indicator,entity_id,inputs})` | add/remove study. **Full names only** ("Relative Strength Index", not "RSI"). |
| `getVisibleRange()` / `setVisibleRange({from,to})` | unix-timestamp range; numbers guarded by `requireFinite` ([[cdp-injection-safety]]). |
| `scrollToDate({date})` | jump to ISO date. |

## Symbol-switch verification

`setSymbol` strips exchange prefixes and compares bidirectionally to decide
`switched` (mirrors the logic in [[chart-ready-polling]]). README guidance: if a
switch returns `success:false`, retry without the exchange prefix
(`NIFTY` not `NSE:NIFTY`).
