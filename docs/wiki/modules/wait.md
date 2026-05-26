---
title: src/wait.js — chart-ready polling
type: module
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/wait.js
related:
  - "[[chart-ready-polling]]"
  - "[[core-chart]]"
---

# Module: src/wait.js

Small (~60 lines) but load-bearing: `waitForChartReady()` is what makes async
chart mutations safe to read back. Full behaviour in [[chart-ready-polling]].

## Export

`waitForChartReady(expectedSymbol?, expectedTf?, timeout=10000)` (`src/wait.js:6`).
Polls every 200ms; returns when the chart is not loading, the symbol matches (if
expected, with exchange-prefix-tolerant bidirectional compare), and bar count is
stable. Returns a boolean-ish readiness.

## Consumers

`core/chart.js` mutations (`setSymbol`, `setTimeframe`, …) and anything that
changes what's on screen before reading it back. Imported via the `_deps` seam in
chart.js so it can be faked in tests ([[core-chart]]).

## Watch item

The "wait until symbol element populates" guard can burn the full 10s timeout if
the legend never yields a symbol — intentional, but looks like a hang. Flagged in
[[chart-ready-polling]].
