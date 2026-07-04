# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

An MCP server (and mirrored `tv` CLI) that bridges Claude Code to a locally running TradingView Desktop app via the Chrome DevTools Protocol (CDP, port 9222). It exposes 78 tools for reading chart state, controlling the chart, developing Pine Script, drawing, alerts, replay mode, and multi-pane/tab layouts — all by evaluating JS against TradingView's internal (undocumented) Electron APIs.

```
Claude Code  ←→  MCP Server (stdio)  ←→  CDP (port 9222)  ←→  TradingView Desktop (Electron)
```

## Development Commands

```bash
npm install

# Tests (node:test, no extra runner)
npm run test:unit            # pine_analyze + cli — offline, no TradingView needed
npm run test:cli             # cli routing tests only
npm test                     # e2e + pine_analyze — e2e REQUIRES TradingView running with --remote-debugging-port=9222
npm run test:e2e             # e2e only (70+ tool tests against a live chart)
npm run test:verbose         # spec reporter for e2e + pine_analyze

# Run a single test file or a single test by name
node --test tests/cli.test.js
node --test --test-name-pattern="<name substring>" tests/pine_analyze.test.js

# CLI (mirrors every MCP tool as a `tv` subcommand, JSON output)
node src/cli/index.js <command>      # or: npm link && tv <command>
tv status                            # verify CDP connection — run before e2e tests

# Launch TradingView Desktop with the debug port enabled
scripts\launch_tv_debug.bat          # Windows
./scripts/launch_tv_debug_mac.sh     # Mac
./scripts/launch_tv_debug_linux.sh   # Linux
# or use the tv_launch / `tv launch` tool to auto-detect the install
```

There is no linter configured. `tests/sanitization.test.js` and `tests/cli.test.js` run offline; `tests/e2e.test.js` and `tests/replay.test.js` need a live, CDP-enabled TradingView instance with a chart open.

## Architecture

Three-layer design, with the CLI as a parallel transport over the same core:

```
tools/<name>.js   — MCP tool registration: zod schemas, jsonResult() wrapping, try/catch → {success:false}
cli/commands/<name>.js — CLI subcommand registration via router.js (parseArgs-based, zero deps)
        ↓ both call into ↓
core/<name>.js    — business logic: pure-ish async functions, the actual TradingView interaction
        ↓
connection.js     — CDP client (chrome-remote-interface), sanitization helpers, KNOWN_PATHS
```

Key points for working in this codebase:

- **`core/` is the single source of truth.** Both `tools/` (MCP) and `cli/commands/` (CLI) are thin adapters that call the same `core/<name>.js` functions — when adding a capability, implement it once in core and register it in both adapters (see how `chart_get_state` / `tv state` both call `core.getState()`).
- **Dependency injection for testing.** Core functions accept an optional `_deps` (e.g. `{ evaluate, evaluateAsync, waitForChartReady }`) so tests can mock the CDP evaluation layer without a live chart — see `mockDeps()` in `tests/sanitization.test.js`.
- **Sanitization is load-bearing, not optional.** Every value interpolated into a JS string that gets `Runtime.evaluate`'d via CDP must go through `safeString()` (string → JSON-escaped literal) or `requireFinite()` (numeric validation) from `connection.js`. This is what prevents injection into TradingView's internal APIs — `tests/sanitization.test.js` audits source files for raw interpolation.
- **`KNOWN_PATHS` in `connection.js`** holds internal TradingView/Electron object paths (`window.TradingViewApi._activeChartWidgetWV...`, the Pine facade REST endpoint, etc.) discovered via live probing. These are undocumented and can break on any TradingView update — changes here are the most likely source of breakage.
- **Pine graphics (lines/labels/tables/boxes)** are read by walking `study._graphics._primitivesCollection...`, not through any public API — see `core/data.js` and the path noted at the bottom of the tool-usage section below.
- **`src/core/index.js`** re-exports the core modules as the `tradingview-mcp/core` package export for programmatic use outside the MCP/CLI transports.
- **`scripts/pine_pull.js` / `pine_push.js`** sync Pine Script source between the local filesystem and the TradingView editor (used alongside the `pine_*` tools).
- **`agents/performance-analyst.md`** and **`skills/*/SKILL.md`** define a Claude Code subagent and skills that orchestrate these tools for higher-level workflows (strategy review, chart analysis, multi-symbol scans, replay practice, Pine development).

## Using the TradingView Tools (when operating a live chart)

The rest of this file is the tool-selection guide Claude Code reads when *using* this MCP server against a live TradingView chart (as opposed to developing on this repo). 78 tools — pick by task:

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_list` → view active alerts
- `alert_delete` → remove alerts

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`
