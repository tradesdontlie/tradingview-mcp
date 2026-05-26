# Wiki Log

Append-only, chronological. Each entry starts with `## [YYYY-MM-DD] <op> | <subject>`
so `grep "^## \[" docs/log.md | tail -5` lists recent activity. See
[AGENTS.md](AGENTS.md) for the operations these record.

## [2026-05-27] ingest | Wiki bootstrap (HEAD 93bd952)
- Instantiated the LLM Wiki pattern for the tradingview-mcp codebase. Raw source
  = the code itself.
- Wrote schema `AGENTS.md`, `index.md`, this log.
- Created `wiki/overview.md` + `wiki/architecture.md` (3-tier tools→core→connection
  over CDP bridge, DI seam, CLI mirror).
- Created 8 concept pages: cdp-connection, evaluate-and-known-paths,
  monaco-fiber-walk, bottom-widget-bar, pine-graphics-path, chart-ready-polling,
  cdp-injection-safety, context-management.
- Created 7 module pages: connection, core-pine, core-chart, core-data,
  core-capture, core-ui, wait.
- Created `wiki/tools/catalog.md` — ~79 tools grouped by registration module.
- Folded in live-probe findings from TV Desktop 3.1.0 (CDP) captured this
  session: the rewritten `bottomWidgetBar` API (no `activateScriptEditorTab`;
  widget name `scripteditor`), the footer `data-qa-id` tab path, the Monaco
  fiber-walk depth, and the ASI bug in the readiness check. Marked `[verified
  live 2026-05-27]`.
- Open items recorded in index.md "Not yet documented": replay/backtest/stream/
  signals cores, external-data cores, CLI layer, per-tool names for the
  external/analysis groups. Version/tool-count inconsistencies flagged in
  overview.

## [2026-05-27] lint | Initial coverage note
- Coverage gaps enumerated in index.md. No contradictions yet (first pass).
- Citation freshness: all `path:line` cites taken against working tree at
  HEAD 93bd952. Re-verify on next code change.
- Behavioural-fact expiry: every `[verified live]` fact is tied to TV Desktop
  3.1.0 — re-probe after a TV update.
