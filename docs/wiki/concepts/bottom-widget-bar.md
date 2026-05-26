---
title: Bottom widget bar — the redesigned footer panel
type: concept
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/core/pine.js:202
  - src/core/pine.js:60
  - src/core/ui.js:31
related:
  - "[[monaco-fiber-walk]]"
  - "[[core-pine]]"
  - "[[core-ui]]"
  - "[[evaluate-and-known-paths]]"
---

# Bottom widget bar

TradingView's bottom panel (Strategy Tester / Pine Editor / Paper Trading / Replay)
is driven by `window.TradingView.bottomWidgetBar` (`bwb`). **TV rewrote this API**;
older code in this repo called methods that no longer exist. This is the single
biggest source of "it used to work" breakage and was the subject of a deep
root-cause fix.

## What the live API actually is

**[verified live 2026-05-27 on TV Desktop 3.1.0]**

- `bwb` methods are only: `open`, `close`, `hide`, `show`, `toggleMaximize`,
  `toggleMinimize` (+ private `_`-prefixed). The legacy
  `activateScriptEditorTab()` and `showWidget(name)` are **gone**.
- `bwb.open()` takes **no argument** — its source is
  `()=>{ isVisible() && mode==='minimized' && setMode('normal') }`. It only
  expands the panel; it does not select a widget.
- Widget config lives in `bwb._config`, keys:
  `paper_trading`, `backtesting`, `replay_trading`, **`scripteditor`** (one word —
  NOT `pine_editor`).
- `bwb._enabledWidgetsWV.value()` lists currently-enabled widgets; `bwb._widgets`
  lists instantiated ones. A widget in `_config` but not `_enabled` is **not a
  tab** until the user opens it once.

## The real way to open Pine Editor

The footer tab is a plain button in `#footer-chart-panel`:

- `button[aria-label="Open Pine Editor"]` (closed) / `"Close Pine Editor"`
  (active) — English-locale label.
- After first open it gains `data-qa-id="scripteditor"` and
  `data-active="true|false"` — **language-independent**, so prefer it.

Clicking that button instantiates the widget, expands the panel, and activates
the tab in one action — even from a collapsed panel.

## Dead ends (do not reintroduce)

- `bwb.activateScriptEditorTab()` / `bwb.showWidget('pine-editor')` — removed.
- `[data-widget-name="pine_editor"]` — wrong name; it's `scripteditor`.
- `[data-name="light-tab-N"]` iteration — those are sub-tabs **inside** the
  Strategy Tester body (`Strategy report`, `List of Trades`), not bottom-bar tabs.
- Synthetic `Ctrl/Cmd+\`` KeyboardEvent — TV has no such Pine Editor hotkey.

## How the code uses this now

- `ensurePineEditorOpen()` (`src/core/pine.js:202`, via `OPEN_PINE_STRATEGIES`
  `:60` / `READY_CHECK` `:167`) clicks `data-qa-id="scripteditor"` first, then English aria
  fallback, then a locale-tolerant footer scan, then legacy selectors for old
  builds. Readiness = Monaco-in-fiber AND footer tab active AND panel not
  collapsed. See [[core-pine]].
- `openPanel()` (`src/core/ui.js:31`) drives the same footer tabs by
  `data-qa-id` (`scripteditor` / `backtesting`) instead of the dead `bwb` methods.

## Lint reminder

Every fact on this page is a live-probe finding against TV 3.1.0. Re-verify after
a TV update — a new bundle can rename `scripteditor`, the aria labels, or the
footer structure.
