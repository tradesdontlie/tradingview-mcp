---
title: Monaco fiber walk — finding the Pine editor instance
type: concept
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/core/pine.js:9
  - src/core/pine.js:167
  - src/core/pine.js:202
related:
  - "[[evaluate-and-known-paths]]"
  - "[[bottom-widget-bar]]"
  - "[[core-pine]]"
---

# Monaco fiber walk

The Pine Editor is a Monaco editor, but TradingView does **not** expose it on a
global (`window.monaco` is absent / unrelated). The only way to reach the live
editor instance is to find its DOM container and climb the React fiber tree
hanging off it until you hit the node whose props carry the `monacoEnv`.

## FIND_MONACO

`FIND_MONACO` (`src/core/pine.js:9`) is the injected finder:

1. `document.querySelector('.monaco-editor.pine-editor-monaco')` — the editor
   container. If absent, Pine Editor isn't mounted → return null.
2. Walk up to 20 ancestors looking for a `__reactFiber$…` key (React attaches the
   fiber to the DOM node under a hashed key).
3. From that fiber, walk up to 15 `.return` (parent-fiber) hops looking for
   `memoizedProps.value.monacoEnv` with an `env.editor.getEditors()` that returns
   ≥1 editor.
4. Return `{ editor, env }` or null.

**[verified live 2026-05-27 on TV Desktop 3.1.0]** the `monacoEnv` sits at fiber
depth 9 from the container; `getEditors()` returns exactly 1 editor when Pine is
open.

## Why it's fragile

- **Hashed keys**: `__reactFiber$<hash>` and CSS-module class suffixes
  (`-NRyfK2N8`) change between TV builds. The finder copes by prefix-matching
  `__reactFiber$` and using the stable `.pine-editor-monaco` class.
- **Depth limits**: 20 ancestors / 15 fiber hops are empirical. A TV reflow could
  exceed them.
- **The ASI bug**: the readiness check interpolates `FIND_MONACO` (which starts
  with a newline) into a `return`. Without wrapping parens, ASI made the IIFE
  return `undefined` → every Monaco poll read false → cold-open of Pine Editor
  timed out 100% of the time, while the already-open path (which assigns to a var
  first, no ASI) worked. Fixed by wrapping: `return (${FIND_MONACO}) !== null`
  inside `READY_CHECK` (`src/core/pine.js:167`). See [[evaluate-and-known-paths]]
  for the general rule.

## Used by

Every Pine tool that needs the editor model: `getSource`, `setSource`, `compile`,
`getErrors`, `save`, `getConsole`, `smartCompile`, `newScript`, `openScript` —
all gate on `ensurePineEditorOpen()` which now requires the fiber walk to succeed
**and** the footer tab to be active. See [[core-pine]] and [[bottom-widget-bar]].
