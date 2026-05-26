---
title: src/core/capture.js — screenshots
type: module
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/core/capture.js
related:
  - "[[context-management]]"
  - "[[core-chart]]"
  - "[[catalog]]"
---

# Module: src/core/capture.js

Screenshots the chart via CDP `Page.captureScreenshot`, writing PNGs to
`screenshots/` and returning a **file path, not image bytes** — the key
context-saving move ([[context-management]]). ~Backs `capture_screenshot`.

## captureScreenshot({ region, filename, method, date, timeframe })

- **region** — `full` (default), `chart`, or `strategy_tester`. The `chart` region
  clips to `.layout__area--center` (canvas + price axis + time axis), with
  fallbacks to `.chart-container-border` / `.chart-container` /
  `[class*="chart-widget"]`.
- **method** — `cdp` (default, `Page.captureScreenshot`) or `api`
  (`chartWidgetCollection.takeScreenshot`).
- **date** (optional, ISO) — zoom to a specific trading day before shooting. The
  view is **not** restored afterward.
- **timeframe** (optional) — sets the zoom window width for the `date` jump.

## The date-zoom heuristic

When `date` is set, it reads the chart resolution (or uses `timeframe`), centers
on noon UTC, and expands a half-window sized by resolution: ±15d (D) → 1-month
view, ±91d (W) → 6-month, ±182d (M) → 1-year, ±2d (hourly), ±12h (intraday). Then
`setVisibleRange()` ([[core-chart]]) + a 600ms settle.

> Heuristic caveats: magic-number windows; noon-UTC centering can land
> mid-session for non-UTC markets (e.g. NSE intraday). Good enough for context
> screenshots; not for precise framing. **[unverified]** across all exchanges.

## Output

`{ success, method:'cdp', file_path, region, size_bytes, zoom? }`. Files are
timestamped; `date` is folded into the filename when present.
