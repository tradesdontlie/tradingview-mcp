---
title: Architecture — three tiers over a CDP bridge
type: architecture
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/server.js
  - src/connection.js
  - src/tools/chart.js
  - src/core/chart.js
  - src/cli/router.js
related:
  - "[[cdp-connection]]"
  - "[[evaluate-and-known-paths]]"
  - "[[context-management]]"
  - "[[overview]]"
---

# Architecture

The codebase is a strict three-tier stack sitting on a single CDP bridge. The
discipline is consistent enough that once you've read one vertical slice
(`tool → core → evaluate`) you've read them all.

```
                 ┌─────────────────────────────────────────┐
   stdio  ◀────▶ │  src/server.js   (McpServer, 25 groups)  │
                 └─────────────────────────────────────────┘
                                   │ registerXTools(server)
                 ┌─────────────────▼───────────────────────┐
   TOOLS layer   │  src/tools/*.js                          │
                 │  zod schema + handler → core.fn()        │
                 │  wraps result in { success, ... }        │
                 └─────────────────┬───────────────────────┘
                                   │ import * as core
                 ┌─────────────────▼───────────────────────┐
   CORE layer    │  src/core/*.js                           │
                 │  plain async fns, throw on error,        │
                 │  build JS strings → evaluate()           │
                 └─────────────────┬───────────────────────┘
                                   │ evaluate(expr)
                 ┌─────────────────▼───────────────────────┐
   BRIDGE        │  src/connection.js                       │
                 │  CDP singleton, KNOWN_PATHS, evaluate(), │
                 │  popup dismiss, safeString/requireFinite │
                 └─────────────────┬───────────────────────┘
                                   │ chrome-remote-interface
                 ┌─────────────────▼───────────────────────┐
   TARGET        │  TradingView Desktop (Electron renderer) │
                 │  CDP on localhost:9222                   │
                 └─────────────────────────────────────────┘

   src/cli/*.js  ── parallel front-end to the same core layer (the `tv` binary)
```

## Tier 1 — Tools (`src/tools/*.js`)

Each file exports `registerXTools(server)` and is wired in `src/server.js:84-108`.
A registration is uniformly:

```js
server.tool('chart_set_symbol', 'Change the chart symbol', {
  symbol: z.string().describe('...'),
}, async ({ symbol }) => {
  try { return jsonResult(await core.setSymbol({ symbol })); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
});
```
(`src/tools/chart.js:11`). Invariants:

- **No business logic here.** Schema + delegate + format. Logic lives in core.
- **Errors never escape** — every handler `try/catch`es and converts a thrown
  error into `{ success: false, error }` via `jsonResult(..., true)`
  (`src/tools/_format.js`).
- The Zod `.describe()` strings are the LLM-facing API docs. They carry the
  hard-won usage rules ("USE FULL NAMES: Relative Strength Index not RSI",
  `src/tools/chart.js:34`).

## Tier 2 — Core (`src/core/*.js`)

The real work. Contract (stated in `src/core/pine.js:1-4`):

> All functions accept plain options objects and return plain JS objects. They
> throw on error (callers catch and format).

Most core functions assemble a JavaScript string and pass it to `evaluate()`,
which runs it inside the TV page and returns the value. The returned objects are
shaped `{ success: true, ... }` on the happy path. See
[[evaluate-and-known-paths]] for how the injected JS reaches TV's internals.

Some core modules don't touch CDP at all — they pull external data
(`core/yahoo.js`, `core/hyperliquid.js`, `core/news.js`, brokers) or compute
locally (`core/indicators_calc.js`, `core/signals/*`). Those are the non-CDP
satellites of the system.

### Dependency injection seam

Several core functions accept an optional `_deps` and resolve through a private
`_resolve(deps)` that defaults to the real `evaluate`/`evaluateAsync`
(`src/core/chart.js:9-16`). This is the test seam — tests inject fakes so unit
tests don't need a live TV. New core functions that hit CDP should follow it.

## Tier 3 — Bridge (`src/connection.js`)

One module owns all CDP I/O ([[connection]]). Everything else calls `evaluate()`.
Covered in [[cdp-connection]] and [[evaluate-and-known-paths]]. Key
responsibilities:

- Connect to the chart target and memoize the client (singleton).
- `evaluate()` — the universal "run JS in TV, return value" primitive.
- `KNOWN_PATHS` — the discovered map of TV internal API entry points.
- `dismissBlockingPopups()` — best-effort modal cleanup before each eval.
- `safeString` / `requireFinite` — injection + corruption guards
  ([[cdp-injection-safety]]).

## The CLI mirror (`src/cli/*.js`)

`src/cli/index.js` + `src/cli/router.js` register terminal commands that call the
**same core layer**. So core is the shared waist: both the MCP server and the
`tv` CLI are thin front-ends over it. A bug fixed in core fixes both.

## Why this shape

- **Testability** — pure core + `_deps` seam means logic is unit-testable
  without a browser.
- **Two front-ends, one brain** — MCP and CLI never diverge because neither holds
  logic.
- **Single CDP chokepoint** — retry, popup handling, and injection safety are
  implemented once in `connection.js` instead of scattered across 30 modules.

## Cross-cutting constraint: payload size

CDP can return enormous payloads (a complex Pine source is 200KB+; OHLCV is
unbounded). The whole stack is tuned to keep LLM context small — `summary` flags,
`study_filter`, label caps, "return a file path not image bytes" for screenshots.
This is a first-class architectural concern, see [[context-management]].
