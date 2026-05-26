---
title: src/core/ui.js — generic UI automation
type: module
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/core/ui.js
related:
  - "[[bottom-widget-bar]]"
  - "[[catalog]]"
---

# Module: src/core/ui.js

Generic UI driving (~300 lines): open panels, click/hover/type, scroll,
fullscreen, evaluate arbitrary JS. The escape hatch when no dedicated tool exists.
Backs the `ui_*` tool group.

## openPanel({ panel, action })

Opens/closes/toggles bottom panels (`pine-editor`, `strategy-tester`) and right
sidebars (`watchlist`, `alerts`, `trading`).

For the **bottom** panels it drives footer tab buttons by `data-qa-id`
(`scripteditor` / `backtesting`) — **not** the old `bwb.activateScriptEditorTab` /
`showWidget` / `hideWidget`, which TV removed. See [[bottom-widget-bar]]. State
is read from `data-active` + an "Open panel"/"Collapse panel" check.

> The `ui_open_panel` e2e test was failing on `bwb.hideWidget is not a function`
> until this was rewritten to footer-tab clicks.

For the **right** panels it clicks by `data-name`/`aria-label` from a small
selector map (`src/core/ui.js:61` region) and checks the right sidebar width.

## Generic interaction functions

| Function | Backing tool |
|----------|--------------|
| `ui_click` / `ui_mouse_click` | click by aria-label/text/data-name, or by coords |
| `ui_hover` | hover |
| `ui_type_text` / `ui_keyboard` | type / key events |
| `ui_scroll` | scroll |
| `ui_find_element` | locate by selector |
| `ui_fullscreen` | toggle fullscreen |
| `ui_evaluate` | run arbitrary JS (power-user / debugging) |

## When to use

Prefer a dedicated `chart_*`/`pine_*`/`data_*` tool when one exists. Reach for
`ui_*` only for actions with no first-class tool. `ui_evaluate` is the ultimate
fallback but bypasses all the safety/normalization the core layer provides.
