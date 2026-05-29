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

## [2026-05-27] ingest | Toolbar Pine layout — READY_CHECK relaxed
- Live verification on a 2nd chart (fU7D519k) exposed a regression: the
  footer-tab READY_CHECK rejected the toolbar Pine layout, where Monaco mounts
  via the toolbar [aria-label="Pine"] button with no footer tab. Relaxed to
  Monaco-in-fiber + container-visible (layout-agnostic).
- ui.openPanel rewritten: pine open delegates to ensurePineEditorOpen; is-open
  uses visible-Monaco; close verifies the editor actually closed and reports
  honestly (toolbar Pine button is open-only — does not toggle closed).
- Updated pages: monaco-fiber-walk, bottom-widget-bar, core-pine, core-ui.
- New [verified live] facts: open works on both layouts; setSource/getSource
  roundtrip + smartCompile succeed. Pre-existing gaps recorded: openPanel
  right-sidebar selectors stale; strategy-tester needs a footer entry.

## [2026-05-27] ingest | screener_gap tool (branch feat/screener-gap)
- Documented the new gap-up/down screener: `screener_gap` MCP tool + `tv gap`
  CLI, backed by `gapScreener()` in `core/tv_screener.js`. Added a dedicated
  "Screeners" section to the tool catalog and enumerated the screener group's
  tools (previously only listed as a file).
- Bucketing logic recorded: held / faded / sold / reversed (gap sign × change
  sign). NSE+BSE dual-listing dedup noted.
- Code lives on branch feat/screener-gap (separate PR to develop), not in this
  docs branch's lineage — catalog entry is forward-looking; no path:line cites
  added for it to avoid cross-branch drift until merge.

## [2026-05-27] lint | Initial coverage note
- Coverage gaps enumerated in index.md. No contradictions yet (first pass).
- Citation freshness: all `path:line` cites taken against working tree at
  HEAD 93bd952. Re-verify on next code change.
- Behavioural-fact expiry: every `[verified live]` fact is tied to TV Desktop
  3.1.0 — re-probe after a TV update.
