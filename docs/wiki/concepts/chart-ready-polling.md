---
title: Chart-ready polling — gating state changes
type: concept
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/wait.js:6
  - src/wait.js:48
  - src/core/chart.js:41
related:
  - "[[core-chart]]"
  - "[[evaluate-and-known-paths]]"
---

# Chart-ready polling

Mutations like `chart_set_symbol` are async in TV — the call returns before bars
load. `waitForChartReady()` (`src/wait.js:6`) polls the DOM until the chart
settles, so downstream reads see fresh data.

## What it polls

Every `POLL_INTERVAL` (200ms), up to `DEFAULT_TIMEOUT` (10s)
(`src/wait.js:3-4`), an injected IIFE returns
`{ isLoading, barCount, currentSymbol }` by reading the DOM
(`src/wait.js:11-31`):

- **Loading spinner** — `[class*="loader"]` / `[class*="loading"]` /
  `[data-name="loading"]` visible → not ready.
- **Bar count** — `[class*="bar"]` element count, used for a stability check
  (count must stop changing).
- **Current symbol** — from the legend title element.

"Ready" = not loading + (if `expectedSymbol` given) the symbol matches + bar count
is stable across polls.

## Exchange-prefix tolerance

When matching the expected symbol it strips any exchange prefix and compares
bidirectionally (`src/wait.js:48` onward): `expected.split(':').pop()` vs the
current symbol, each `.includes` the other. So `NSE:NIFTY` matches a chart
showing `NIFTY`, and an empty current symbol blocks until it populates.

> **Edge case to watch:** if the legend element never yields a symbol, the
> bidirectional-includes guard waits the full 10s timeout. Intentional (wait for
> load) but can feel like a hang.

## Used by

`core/chart.js` mutations call it after issuing the change — e.g. `setSymbol`
(`src/core/chart.js:41`) issues the symbol change, then `waitForChartReady(symbol)`,
then reads back the actual symbol to confirm the switch took (returns
`success: false` if it didn't). See [[core-chart]].
