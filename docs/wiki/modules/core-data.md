---
title: src/core/data.js — chart data & Pine drawing scrapers
type: module
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/core/data.js
related:
  - "[[pine-graphics-path]]"
  - "[[context-management]]"
  - "[[catalog]]"
---

# Module: src/core/data.js

The data-reading core (~548 lines). Two distinct jobs: standard chart data
(OHLCV, quotes, study values) and the signature **Pine drawing scrapers** that
read `line/label/table/box` output invisible to normal APIs.

## Standard data

| Function | Notes |
|----------|-------|
| `getOhlcv({count,summary})` | bars from `mainSeriesBars`. **Default `summary:true`** — compact stats vs raw bars. Cap 500. |
| `getQuote()` | latest price/OHLC/volume for the **current** chart symbol (param dropped — switch symbol first). |
| `getStudyValues()` | current numeric values from all visible indicators. ~500B. |
| `getIndicator()` | study info + inputs. Avoid on encrypted indicators (blob inputs). |
| `getEquity()` / `getStrategyResults()` / `getTrades()` | strategy-tester data. |
| `getCandles()` / `depthGet()` | candle data / market depth. |

## Pine drawing scrapers

The heart of the module. `buildGraphicsJS(collection, key, filter)` constructs the
injected traversal; e.g. `data_get_pine_lines` calls
`buildGraphicsJS('dwglines', 'lines', filter)` (`src/core/data.js:362`). The
traversal reads
`study._graphics._primitivesCollection.<collection>…._primitivesDataById`
(`src/core/data.js:27-49`) — full explanation in [[pine-graphics-path]].

| Function | Returns |
|----------|---------|
| `getPineLines({study_filter})` | horizontal levels, deduped, sorted high→low |
| `getPineLabels({study_filter,max_labels})` | text+price annotations, cap 50 |
| `getPineTables({study_filter})` | table cells as rows |
| `getPineBoxes({study_filter})` | `{high,low}` zones, deduped |

**Always pass `study_filter`** and **the indicator must be visible** — see
[[pine-graphics-path]] and [[context-management]].

## Output discipline

Every scraper normalizes raw TV-internal map values into compact, sorted,
deduplicated output. This normalization is the stable, valuable layer; the
private-path traversal underneath is the brittle part to watch on TV updates.
