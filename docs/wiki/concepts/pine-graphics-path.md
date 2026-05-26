---
title: Pine graphics path — scraping custom indicator drawings
type: concept
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/core/data.js:27
  - src/core/data.js:362
  - CLAUDE.md
related:
  - "[[core-data]]"
  - "[[evaluate-and-known-paths]]"
  - "[[context-management]]"
---

# Pine graphics path

This is the project's signature capability. Custom Pine indicators draw with
`line.new()`, `label.new()`, `table.new()`, `box.new()`. These drawings are
**invisible to normal data APIs** — `data_get_study_values` won't see a price
level drawn by `line.new()`. They live in a deep private collection on the study
object, and the only way to read them is to walk that structure.

## The path

From `CLAUDE.md` and implemented in `src/core/data.js`:

```
study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById
```

In code (`src/core/data.js:27-49`): for each study, take `s._graphics`, require
`._primitivesCollection`, then iterate the relevant primitive collection and read
`._primitivesDataById` — a `Map` of `{ id → raw drawing data }`. Each kind of
drawing has its own collection key:

| Tool | Collection | What it returns |
|------|-----------|-----------------|
| `data_get_pine_lines` | `dwglines` → `lines` (`src/core/data.js:362`) | horizontal price levels, deduplicated, sorted high→low |
| `data_get_pine_labels` | labels | text annotations + price ("PDH 24550", "Bias Long ✓"), capped at 50 |
| `data_get_pine_tables` | tables | table cells as formatted rows (session stats dashboards) |
| `data_get_pine_boxes` | boxes | `{ high, low }` price zones, deduplicated |

## Hard constraints

- **The indicator must be VISIBLE on the chart.** Hidden/removed studies have no
  live `_graphics`. (`CLAUDE.md` repeats this.)
- **Use `study_filter`** (a name substring, e.g. `"Profiler"`) to target one
  indicator. Scanning all studies is slow and floods context — see
  [[context-management]].
- The raw map values are TV-internal shapes; the core layer normalizes them into
  compact, sorted, deduplicated output before returning.

## Why it's fragile

`_graphics`, `_primitivesCollection`, `dwglines`, `_primitivesDataById` are all
private internals (note the `_` prefixes). Like [[evaluate-and-known-paths]]
entries, a TV bundle update can rename any link in the chain. The dedup/sort
normalization is the stable, valuable part; the traversal is the brittle part.
