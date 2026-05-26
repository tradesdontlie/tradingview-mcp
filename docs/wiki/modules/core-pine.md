---
title: src/core/pine.js — Pine Script editor control
type: module
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/core/pine.js
related:
  - "[[monaco-fiber-walk]]"
  - "[[bottom-widget-bar]]"
  - "[[evaluate-and-known-paths]]"
  - "[[catalog]]"
---

# Module: src/core/pine.js

The largest core module (~756 lines). Drives TradingView's Pine Editor: open it,
inject/read source, compile, read errors and console, save, create/open scripts.
Also a pure offline analyzer.

## The gatekeeper: ensurePineEditorOpen()

Every editor-touching function first calls `ensurePineEditorOpen()`
(`src/core/pine.js:202`). It returns `{ ready, diagnostic, strategy }`:

- **READY_CHECK** (`src/core/pine.js:167`) is layout-agnostic: Monaco found via
  the fiber walk ([[monaco-fiber-walk]]) AND the `.pine-editor-monaco` container
  visible (`offsetParent !== null`) so the editor's action buttons are rendered.
  It deliberately does NOT require a footer tab — TV's toolbar Pine layout mounts
  Monaco without one. See [[bottom-widget-bar]].
- **OPEN_PINE_STRATEGIES** (`src/core/pine.js:60`) clicks, in confidence order: `data-qa-id="scripteditor"`
  → English `aria-label="Open/Close Pine Editor"` → locale-tolerant footer scan →
  legacy `[aria-label="Pine"]` toolbar button. Every click is visibility-gated.
- On failure it returns a **diagnostic snapshot** (bwb methods, footer buttons,
  enabled/instantiated widgets, config keys, origin) so the thrown error is
  actionable. Call sites throw via the shared `pineEditorError(diagnostic)`
  helper (`src/core/pine.js:40`, deduped across 9 sites).

**[verified live 2026-05-27]** works on BOTH the footer-tab layout (chart
Lh6IArQ8: already-ready ≈ 4ms, cold ≈ 220ms) and the toolbar Pine layout (chart
fU7D519k: open ≈ 300–500ms via the legacy `[aria-label="Pine"]` strategy).
setSource/getSource roundtrip and smartCompile confirmed working after open.

> Historical bug: the readiness poll suffered the ASI `undefined` bug
> ([[evaluate-and-known-paths]]) and the old open-strategies called the removed
> `bwb.activateScriptEditorTab`. Both fixed in the root-cause rewrite.

## Editor operations

| Function | What it does |
|----------|--------------|
| `getSource()` | read Monaco value (can be 200KB+ — avoid casually) |
| `setSource({source})` | `monaco.editor.setValue` |
| `compile()` | click "Add to chart"/"Save and add to chart" |
| `smartCompile()` | compile + detect study-count delta + read error markers |
| `getErrors()` | read Monaco model markers |
| `getConsole()` | scrape `log.info()` output |
| `save()` | Ctrl+S, handle the "Save Script" name dialog |
| `newScript({type})` | inject an indicator/strategy/library template |
| `openScript({name})` | load a saved script by name |

`FIND_MONACO` (`:9`) is the shared finder used by all of these — see
[[monaco-fiber-walk]].

## Pure / offline

`analyze({source})` does static analysis without TV: detects array
index-out-of-bounds, `.first()/.last()` on possibly-empty arrays,
`strategy.entry` without a `strategy()` decl, version sniffing. No CDP — unit
testable directly.

## "Add to chart" button matching

`compile()`/`smartCompile()` find the action button by scanning `button`
textContent for "Save and add to chart" / `^Add to chart$` / `^Update on chart$`.
**Caution:** TV sometimes renders doubled labels ("Add to chartAdd to chart" from
text + sr-only span); strict `^...$` regexes can miss these. Prefer substring
matching here.
