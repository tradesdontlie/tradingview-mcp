---
title: Tool catalog — all MCP tools by group
type: tool-catalog
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/server.js
  - src/tools/
related:
  - "[[overview]]"
  - "[[architecture]]"
  - "[[context-management]]"
---

# Tool catalog

Ground-truth list of registered MCP tools, grouped by `register*Tools` module
(`src/server.js:84-108`). **~79 tools** derived from `grep server.tool src/tools/`.

> Count drift: `src/server.js:36` prompt says "78", `CLAUDE.md` says "68". This
> catalog (re-derive on ingest) is authoritative. Each row links its core module
> where a wiki page exists.

## Health & connection — `tools/health.js`
- `tv_health_check` — CDP connection + chart state
- `tv_discover` — report available `KNOWN_PATHS`
- `tv_ui_state` — panels, buttons, chart state
- `tv_launch` — auto-detect + launch TV with CDP (Mac/Win/Linux)

## Chart control — `tools/chart.js` → [[core-chart]]
- `chart_get_state` — symbol, timeframe, type, studies + entity IDs (**call first**)
- `chart_set_symbol`, `chart_set_timeframe`, `chart_set_type`
- `chart_manage_indicator` — add/remove (**full names only**)
- `chart_get_visible_range`, `chart_set_visible_range`, `chart_scroll_to_date`
- `symbol_info`, `symbol_search`

## Data — `tools/data.js` → [[core-data]]
- `data_get_ohlcv` (**summary=true**), `data_get_candles`
- `quote_get`, `depth_get`
- `data_get_study_values`, `data_get_indicator`
- `data_get_pine_lines`, `data_get_pine_labels`, `data_get_pine_tables`,
  `data_get_pine_boxes` → [[pine-graphics-path]] (**study_filter**, visible only)
- `data_get_equity`, `data_get_strategy_results`, `data_get_trades`

## Pine Script — `tools/pine.js` → [[core-pine]]
- `pine_set_source`, `pine_get_source` (**200KB+ risk**)
- `pine_compile`, `pine_smart_compile`, `pine_check`
- `pine_get_errors`, `pine_get_console`
- `pine_new`, `pine_open`, `pine_save`, `pine_list_scripts`
- `pine_analyze` (pure/offline static analysis)

## Capture — `tools/capture.js` → [[core-capture]]
- `capture_screenshot` — regions full/chart/strategy_tester; optional date zoom

## Indicators — `tools/indicators.js`
- `indicator_set_inputs`, `indicator_toggle_visibility`

## Drawing — `tools/drawing.js`
- `draw_shape` (horizontal_line/trend_line/rectangle/text), `draw_list`,
  `draw_remove_one`, `draw_clear`, `draw_get_properties`

## Alerts — `tools/alerts.js`
- `alert_create`, `alert_list`, `alert_delete`

## Replay — `tools/replay.js`
- `replay_start`, `replay_step`, `replay_autoplay`, `replay_trade`,
  `replay_status`, `replay_stop`

## Batch — `tools/batch.js`
- `batch_run` — run an action across multiple symbols/timeframes

## Panes & tabs — `tools/pane.js`, `tools/tab.js`
- `pane_list`, `pane_set_layout` (s/2h/2v/4/6/8), `pane_focus`, `pane_set_symbol`
- `tab_list`, `tab_new`, `tab_close`, `tab_switch`

## Layouts & watchlist — `tools/*`
- `layout_list`, `layout_switch`
- `watchlist_get`, `watchlist_add`

## UI automation — `tools/ui.js` → [[core-ui]]
- `ui_open_panel`, `ui_click`, `ui_mouse_click`, `ui_hover`, `ui_type_text`,
  `ui_keyboard`, `ui_scroll`, `ui_find_element`, `ui_fullscreen`, `ui_evaluate`

## External data & analysis (non-CDP satellites)
Registered groups in `src/server.js` whose core fns hit external APIs or compute
locally rather than driving TV:
- `tools/news_sentiment.js`, `tools/tv_analysis.js`, `tools/screener.js`,
  `tools/snapshots.js`, `tools/composed.js`, `tools/egx.js`,
  `tools/backtest_tools.js`, `tools/hyperliquid_tools.js`, `tools/brokers.js`,
  `tools/stream.js`, `tools/signal.js`
- These back data sources (Yahoo, Hyperliquid, brokers, screeners, RSS news) and
  the local signal DSL/engine. **[unverified]** exact per-tool names — not yet
  enumerated here; expand on next ingest.

## Conventions (all tools)
- Every tool returns `{ success: true/false, ... }`; errors are caught and
  returned as `{ success:false, error }` ([[architecture]]).
- Entity IDs from `chart_get_state` are session-specific — don't cache across
  sessions.
- Honor [[context-management]] defaults (summary/study_filter/caps).
