# Wiki Index

Content catalog of the `tradingview-mcp` LLM wiki. Read this first on any query to
locate pages, then drill in. Conventions and workflows live in [AGENTS.md](AGENTS.md).

Raw source = the codebase (`src/**`, root `*.md`, `tests/**`). The wiki is the
synthesized layer over it. See [overview](wiki/overview.md) for the big picture.

## Overview
- [overview](wiki/overview.md) — what the project is, the load-bearing ideas, the stack.

## Architecture
- [architecture](wiki/architecture.md) — the three tiers (tools → core → connection) over the CDP bridge, the DI seam, the CLI mirror.

## Concepts
- [cdp-connection](wiki/concepts/cdp-connection.md) — singleton CDP client, attach/retry, target selection, popup auto-dismiss hazard.
- [evaluate-and-known-paths](wiki/concepts/evaluate-and-known-paths.md) — the `evaluate()` primitive, TV internal paths, returnByValue + ASI gotchas.
- [monaco-fiber-walk](wiki/concepts/monaco-fiber-walk.md) — finding the Pine Monaco editor by walking the React fiber tree.
- [bottom-widget-bar](wiki/concepts/bottom-widget-bar.md) — the redesigned footer panel API; how to actually open Pine Editor; dead ends.
- [pine-graphics-path](wiki/concepts/pine-graphics-path.md) — scraping line/label/table/box drawings invisible to normal APIs.
- [chart-ready-polling](wiki/concepts/chart-ready-polling.md) — gating reads behind async chart mutations.
- [cdp-injection-safety](wiki/concepts/cdp-injection-safety.md) — `safeString`/`requireFinite` and why injected JS needs them.
- [context-management](wiki/concepts/context-management.md) — keeping LLM payloads small; defaults + output-size cheat sheet.

## Modules
- [connection](wiki/modules/connection.md) — `src/connection.js`, the CDP chokepoint (highest blast radius).
- [core-pine](wiki/modules/core-pine.md) — `src/core/pine.js`, Pine Editor control + `ensurePineEditorOpen`.
- [core-chart](wiki/modules/core-chart.md) — `src/core/chart.js`, chart state/mutations + the DI seam.
- [core-data](wiki/modules/core-data.md) — `src/core/data.js`, OHLCV/quotes + Pine drawing scrapers.
- [core-capture](wiki/modules/core-capture.md) — `src/core/capture.js`, screenshots + date-zoom heuristic.
- [core-ui](wiki/modules/core-ui.md) — `src/core/ui.js`, generic UI automation + footer panel control.
- [wait](wiki/modules/wait.md) — `src/wait.js`, chart-ready polling.

## Tools
- [catalog](wiki/tools/catalog.md) — all ~79 MCP tools grouped by registration module (ground truth for tool count).

## Not yet documented
Source modules without a dedicated wiki page (candidates for future ingest):
- `src/core/replay.js`, `src/core/backtest.js`, `src/core/stream.js` +
  `src/core/streaming/*` (ring buffer + manager), `src/core/signals/*` (DSL +
  engine).
- External-data cores: `core/yahoo.js`, `core/hyperliquid.js`, `core/news.js`,
  `core/sentiment.js`, `core/options.js`, `core/tv_screener.js`, `core/tv_ta.js`,
  `core/egx_data.js`, `core/bitcoin_market.js`, `core/brokers/*`,
  `core/exchanges.js`, `core/extended_hours.js`, `core/secrets.js`,
  `core/indicators*.js`.
- `src/cli/*` — the CLI front-end (mirrors tools over the same core).
- Per-tool enumeration for the external/analysis tool groups (catalog lists the
  groups but not every tool name yet).
