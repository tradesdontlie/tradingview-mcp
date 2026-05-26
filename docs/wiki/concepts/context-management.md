---
title: Context management — keeping payloads small
type: concept
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/server.js:74
  - CLAUDE.md
related:
  - "[[architecture]]"
  - "[[pine-graphics-path]]"
  - "[[core-data]]"
  - "[[core-capture]]"
---

# Context management

CDP can hand back enormous payloads. A complex Pine source is 200KB+; OHLCV is
unbounded; scanning every study's drawings floods the window. Because the consumer
is an LLM with a finite context, **keeping responses small is a first-class design
constraint**, baked into tool defaults and the server prompt
(`src/server.js:74-79`, expanded in `CLAUDE.md`).

## The rules (enforced + advised)

1. **`data_get_ohlcv` → always `summary: true`** unless individual bars are
   needed. Summary ≈ 500 bytes; 100 bars ≈ 8KB.
2. **Pine tools → always `study_filter`** when the target indicator is known.
   Don't scan all studies. See [[pine-graphics-path]].
3. **Never `verbose: true`** on pine tools unless the user asks for raw
   drawing data with IDs/colors.
4. **Avoid `pine_get_source`** on complex scripts (200KB+). Only read to edit.
5. **Avoid `data_get_indicator`** on protected/encrypted indicators — inputs are
   encoded blobs. Use `data_get_study_values` for current values.
6. **`capture_screenshot` returns a file path, not image bytes** (~300 bytes vs
   ~300KB). Prefer a screenshot for visual context over pulling large datasets.
   See [[core-capture]].
7. **Call `chart_get_state` once**, reuse the entity IDs; don't re-poll.
8. **Cap OHLCV requests** — `count: 20` quick, `100` deeper, `500` only when
   needed (hard cap 500; trades cap 20; labels cap 50/study).

## Output-size cheat sheet

| Tool | Typical output |
|------|----------------|
| `quote_get` | ~200 B |
| `data_get_study_values` | ~500 B (all indicators) |
| `data_get_pine_lines` | ~1–3 KB / study |
| `data_get_pine_labels` | ~2–5 KB / study (cap 50) |
| `data_get_ohlcv` (summary) | ~500 B |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 B (path only) |

## Where it's implemented

The defaults live in the tool Zod schemas (`src/tools/data.js`, `pine.js`,
`capture.js`) and the guidance is duplicated in the server `instructions`
(`src/server.js`) and `CLAUDE.md` so both the MCP client and any agent reading
the repo see it. When adding a tool that can return a large payload, give it a
`summary`/`count`/`filter` knob and default it to the small option.
