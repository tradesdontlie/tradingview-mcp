# Project Context

## Purpose
TradingView MCP is a bridge that lets an AI assistant (and a `tv` CLI) read and control a **live
TradingView Desktop chart** over the Chrome DevTools Protocol (CDP, port 9222). It exposes ~70 tools for
chart state, OHLCV/quotes, custom Pine-indicator graphics (lines/labels/tables/boxes), Pine Script
editing, replay, drawings, alerts, screenshots, and a prompt-driven HTML/PDF report pipeline.

## Tech Stack
- Node.js ≥18, ES Modules (`"type": "module"`)
- `@modelcontextprotocol/sdk` (stdio MCP server) for the tool layer
- `chrome-remote-interface` for the CDP session to TradingView Desktop (Electron)
- `zod` for MCP tool-input schemas
- `node --test` for tests (no external test runner); Python + Playwright (Chromium) only for HTML→PDF

## Project Conventions

### Code Style
- ESM with named exports; `camelCase` functions, `SCREAMING_SNAKE_CASE` module constants.
- All user-controlled values interpolated into CDP `evaluate()` payloads MUST go through `safeString()`
  (and numeric coordinates through `requireFinite()`) from `src/connection.js`. Never hand-roll quote
  escaping for selectors or JS payloads.
- No linter/formatter is configured yet (a candidate for a future change).

### Architecture Patterns
Three layers, strictly:
```
src/server.js / src/cli/index.js  (entry points)
  → src/tools/*.js   MCP registrars: Zod schema + jsonResult() wrapper (catches errors → {success:false})
  → src/core/*.js    business logic: builds CDP eval payloads, parses results
  → src/connection.js  CDP client, KNOWN_PATHS, safeString/requireFinite, evaluate(), retry/backoff
```
- **Failure contract:** core functions THROW on failure; the tools layer wraps every call in
  `try/catch` and returns `{success:false, error}` via `jsonResult(..., true)`. Core must not return
  `{success:true}` with an embedded `error` field.
- **Dependency injection:** newer core modules accept an optional `_deps` bag and resolve it through a
  `_resolve(deps)` helper (canonical shape in `src/core/drawing.js`), defaulting to the real
  `connection.js` imports. This is the seam unit tests inject mocks into.
- **Canonical paths:** TradingView internal API paths live in `KNOWN_PATHS` in `src/connection.js`;
  modules import them rather than redeclaring the literal.

### Testing Strategy
- `node --test` suites under `tests/`. DI-based unit suites (`sanitization.test.js`, `replay.test.js`)
  mock `_deps` and need no live TradingView. `e2e.test.js` requires a live TradingView at port 9222.
- Every npm test script MUST include the DI unit suites so regression coverage actually runs.

### Git Workflow
- Feature branches → PR to `main`. Conventional, descriptive commit subjects.

## Domain Context
TradingView Desktop is an Electron app; its renderer exposes `window.TradingViewApi`. Custom/commercial
Pine indicators (MarketCipher, Prophesier, Prophet, Sibyl) hold the user's hand-tuned settings and must
never be programmatically re-added. Pine graphics are read via
`study._graphics._primitivesCollection.<dwg*>...`. React class names are hashed and change per TV
release, so DOM selectors are best-effort and prefer stable `data-name` attributes.

## Important Constraints
- The MCP transport is **stdio** — nothing on the server path may write to `process.stdout`/`stderr`.
- Single shared CDP client bound to one page target; tab/target changes must rebuild it.
- TradingView's internal API surface can shift between releases; silent-catch error handling hides those
  shifts and must surface warnings instead.

## External Dependencies
- TradingView Desktop with `--remote-debugging-port=9222` (CDP).
- `pine-facade.tradingview.com` REST endpoint for Pine compile/translate and saved-script open.
