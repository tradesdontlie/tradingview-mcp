# UI Recorder → MCP Tool Codegen — Design Doc

Status: proposal (not yet implemented)
Scope: fork-only experiment. Do not upstream until it's been used end-to-end at least once.

## Problem

Most tools in this repo drive TradingView through reverse-engineered globals
(`window.TradingViewApi.*`). For flows that have no clean API hook —
right-click menus, modals mounted in portals, drag interactions, the Stock
Screener — we fall back to brittle DOM scraping. Writing those tools by hand
is slow, and selectors rot.

Idea: let a human perform the action once in the live TradingView Electron
window, capture the interaction over CDP, and generate a new MCP tool stub
from the recording.

## Architecture

```
TradingView Electron
  └─ in-page recorder (injected JS)        ← captures clicks/keys/inputs
       │
       ├─ window.__tvRecord  (event buffer)
       │
CDP :9222
  │
MCP server (this repo)
  ├─ src/core/recorder.js   ← start / stop / dump / clear
  ├─ src/tools/recorder.js  ← MCP wrappers
  └─ scripts/gen-tool.js    ← reads recording → emits new core+tool files
```

Three pieces, in order of build:

### 1. In-page recorder (`src/recorder/inject.js`)

A self-contained JS payload that the core module injects via
`Runtime.evaluate`. It does:

- Attaches capturing-phase listeners on `document` for: `click`, `keydown`,
  `input`, `change`, `submit`.
- Resolves a **stable selector** for each event's target, in priority order:
  1. `[data-name="…"]`
  2. `[aria-label="…"]`
  3. textContent (trimmed, ≤40 chars) via `:has-text` notation we resolve in replay
  4. CSS path with `nth-of-type` as last resort
- Attaches a `MutationObserver` on `document.body` to track portal-mounted
  modals (Screener, indicator-settings dialog, etc.) so the recording includes
  "after this click, a dialog with role=dialog appeared".
- Snapshots **before/after chart state** on each event: `symbol()`,
  `resolution()`, panel openness — so codegen knows what the action *did*.
- Pushes each event into `window.__tvRecord = []`. Buffer is read by polling,
  not by `consoleAPICalled` — keeps DevTools console clean.

Reset on `recorder_start`. Survives soft chart reloads because it lives on
`window` and we re-inject if `__tvRecord` is undefined.

### 2. MCP tools (`src/tools/recorder.js` + `src/core/recorder.js`)

Four tools, matching the project's existing tool/core split:

| Tool             | Purpose                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `recorder_start` | Injects the recorder if absent, clears the buffer, returns `{ ok }`. |
| `recorder_stop`  | Pulls the buffer to the server, writes `recordings/<name>.json`.     |
| `recorder_dump`  | Reads the buffer without stopping. Useful for live debugging.        |
| `recorder_clear` | Empties the buffer without re-injecting.                             |

Registered in `server.js` with one line: `registerRecorderTools(server)`.

### 3. Codegen (`scripts/gen-tool.js`)

CLI: `node scripts/gen-tool.js recordings/open-screener.json --name screener_open_v2`

Reads the JSON trace and emits two files:

- `src/core/<name>.js` — a function that replays the trace, using `evaluate()`
  to dispatch synthetic clicks and key events at the same selectors. Uses the
  existing `waitFor*` helpers from `src/wait.js` whenever the recording showed
  a mutation after an event.
- `src/tools/<name>.js` — Zod schema with parameters detected by the
  **parameterization step** below, plus the standard try/catch jsonResult
  wrapper.

Adds the registration line to `server.js` automatically via a marker comment
(`// @recorder:registrations`).

#### Parameterization step

Before codegen, run `node scripts/gen-tool.js --annotate <recording>`. It
opens a TUI that walks each captured input/typed value and asks: literal or
parameter? Parameters become Zod fields on the generated tool. This avoids
codegen guessing wrong about whether "AAPL" was the symbol-of-interest or
just an example.

## Open questions

1. **Canvas interactions.** Drawing a trendline by drag isn't recordable as
   a stable selector — it's pointer coordinates on a canvas. First version
   should refuse to record those (detect target is `<canvas>`, emit a
   warning event into the buffer). Coordinate-based replay is a v2 problem.
2. **Selector durability across TradingView updates.** Class names rotate.
   `data-name` is fairly stable; `aria-label` less so. We should add a CI
   smoke test that re-runs all generated tools weekly so rot is loud.
3. **Synthetic vs native events.** Some React/TV handlers ignore
   `element.click()`. We may need to use CDP `Input.dispatchMouseEvent` for
   reliability — slower but actually triggers the framework's event path.
   Existing `ui_click` in this repo already does this; reuse it.
4. **Privacy.** Recorded buffers can contain typed text (e.g., usernames if
   the user clicks into a search field with autofill). The dump tool should
   scrub anything from `<input type="password">` and warn before writing.

## Build order

1. `src/recorder/inject.js` — listener + selector resolver only. Verify by
   hand via DevTools console: open chart, paste the script, click around,
   `JSON.stringify(window.__tvRecord)`.
2. `src/core/recorder.js` + `src/tools/recorder.js` + register in
   `server.js`. Verify by calling `recorder_start`, doing one action, calling
   `recorder_stop`, inspecting the JSON file.
3. Replay-only codegen (no parameterization). Generate a tool that just
   replays the captured sequence verbatim. Verify on the Screener-open flow
   that's currently failing.
4. Parameterization TUI. Make at least one generated tool actually
   parameterized (e.g. `chart_symbol_search` where the typed text is the
   parameter).
5. CI smoke job that runs generated tools against a real chart, gated behind
   `RECORDER_E2E=1` so it doesn't run on every PR.

## Non-goals (for now)

- Cross-platform recording UI. CLI/MCP only.
- Multi-step macros with branching/conditionals. Linear playback only.
- Sharing recordings across TradingView accounts — selectors might differ by
  region/account tier.

## Where this lives

This doc and the implementation live on the fork
(`TradingSandbox/tradingview-mcp`) only. Upstream PR happens after at least
one generated tool ships and survives a week without selector rot.
