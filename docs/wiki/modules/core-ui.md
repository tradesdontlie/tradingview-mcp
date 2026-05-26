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

For the **bottom** panels it no longer uses the removed
`bwb.activateScriptEditorTab` / `showWidget` / `hideWidget`. Instead:
- **pine-editor open** delegates to the verified `ensurePineEditorOpen()`
  ([[core-pine]]) — full fallback chain incl. the toolbar `[aria-label="Pine"]`
  button, so it works on both Pine layouts ([[bottom-widget-bar]]).
- **strategy-tester open** uses a `data-qa-id` → aria-label → footer-scan chain.
- **is-open** for Pine is read from **visible Monaco** (layout-agnostic), not a
  footer tab.
- **close** uses footer handles only and **verifies the editor actually went
  away**, reporting `performed:'none'` honestly when it can't (the toolbar Pine
  button is open-only — re-clicking does not close, verified live).

> The `ui_open_panel` e2e test had been failing on `bwb.hideWidget is not a
> function`; the rewrite removed the dead API.

For the **right** panels it clicks by `data-name`/`aria-label` from a small
selector map. **[unverified / likely stale]** those selectors
(`base-watchlist-widget-button`, etc.) miss on the current TV build —
`openPanel('watchlist')` throws "Button not found". Pre-existing, unchanged by
the Pine fix; flagged for a future ingest.

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
