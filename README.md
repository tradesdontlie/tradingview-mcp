# TradingView MCP Bridge

Personal AI assistant for your TradingView Desktop charts. Connects Claude Code to your local TradingView app via Chrome DevTools Protocol, with an Electron bridge fallback for already-running TradingView Desktop sessions, for AI-assisted chart analysis, Pine Script development, and workflow automation.

> **For personal use only.** See [Disclaimer](#disclaimer) for important information about TradingView's Terms of Service.

## What It Does

Gives your AI assistant eyes and hands on your own chart:

- **Pine Script development** — write, inject, compile, debug, and iterate on scripts with AI assistance
- **Chart navigation** — change symbols, timeframes, zoom to dates, add/remove indicators
- **Visual analysis** — read your chart's indicator values, price levels, and annotations
- **Draw on charts** — trend lines, horizontal lines, rectangles, text annotations
- **Manage alerts** — create, list, and delete price alerts
- **Replay practice** — step through historical bars, practice entries/exits
- **Screenshots** — capture chart state for AI visual analysis
- **Launch TradingView** — auto-detect and launch with debug mode from any platform

## Quick Start

### 1. Install

```bash
git clone https://github.com/thedailyprofiler/tradingview-mcp.git
cd tradingview-mcp
npm install
```

### 2. Launch TradingView

Best path: run TradingView Desktop with Chrome DevTools Protocol enabled on port 9222.
If TradingView is already running without port 9222, the server can fall back to
an Electron inspector bridge on port 9229 without relaunching TradingView.

**Mac:**
```bash
./scripts/launch_tv_debug_mac.sh
```

**Windows:**
```bash
scripts\launch_tv_debug.bat
```

**Linux:**
```bash
./scripts/launch_tv_debug_linux.sh
```

**Or launch manually on any platform:**
```bash
/path/to/TradingView --remote-debugging-port=9222
```

**Or use the MCP tool** (auto-detects your install):
> "Use tv_launch to start TradingView in debug mode"

### 3. Add to Claude Code

Add to your Claude Code MCP config (`~/.claude/.mcp.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/path/to/tradingview-mcp/src/server.js"]
    }
  }
}
```

Replace `/path/to/tradingview-mcp` with your actual path.

### 4. Verify

Ask Claude: *"Use tv_health_check to verify TradingView is connected"*

## How Claude Knows Which Tool to Use

Claude reads [`CLAUDE.md`](CLAUDE.md) automatically when working in this project. It contains a complete decision tree:

| You say... | Claude uses... |
|------------|---------------|
| "What's on my chart?" | `chart_get_state` → `data_get_study_values` → `quote_get` |
| "What levels are showing?" | `data_get_pine_lines` → `data_get_pine_labels` |
| "Read the session table" | `data_get_pine_tables` with `study_filter` |
| "Give me a full analysis" | `quote_get` → `data_get_study_values` → `data_get_pine_lines` → `data_get_pine_labels` → `data_get_pine_tables` → `data_get_ohlcv` (summary) → `capture_screenshot` |
| "Switch to AAPL daily" | `chart_set_symbol` → `chart_set_timeframe` |
| "Write a Pine Script for..." | `pine_set_source` → `pine_smart_compile` → `pine_get_errors` |
| "Start replay at March 1st" | `replay_start` → `replay_step` → `replay_trade` |
| "Compare ES, NQ, YM" | `batch_run` with symbols array |
| "Draw a level at 24500" | `draw_shape` (horizontal_line) |
| "Take a screenshot" | `capture_screenshot` |

## Tool Reference (68 tools)

### When You Need to Know What's on Your Chart

| Tool | When to use | Output size |
|------|------------|-------------|
| `chart_get_state` | First call — get symbol, timeframe, all indicator names + IDs | ~500B |
| `data_get_study_values` | Read current RSI, MACD, BB, EMA values from all indicators | ~500B |
| `quote_get` | Get latest price, OHLC, volume | ~200B |
| `data_get_ohlcv` | Get price bars. **Use `summary: true`** for compact stats | 500B (summary) / 8KB (100 bars) |

### When You Need Custom Indicator Data (Pine Drawings)

These read `line.new()`, `label.new()`, `table.new()`, `box.new()` output from any visible Pine indicator — even protected ones.

| Tool | When to use | Output size |
|------|------------|-------------|
| `data_get_pine_lines` | Read horizontal price levels (support/resistance, session levels, etc.) | ~1-3KB |
| `data_get_pine_labels` | Read text annotations + prices ("PDH 24550", "Bias Long ✓", etc.) | ~2-5KB |
| `data_get_pine_tables` | Read data tables (session stats, analytics dashboards) | ~1-4KB |
| `data_get_pine_boxes` | Read price zones / ranges as {high, low} pairs | ~1-2KB |

**Always use `study_filter`** to target a specific indicator: `study_filter: "Profiler"` or `study_filter: "NY Levels"`.

### When You Need to Change the Chart

| Tool | What it does |
|------|-------------|
| `chart_set_symbol` | Change ticker (BTCUSD, AAPL, ES1!, NYMEX:CL1!) |
| `chart_set_timeframe` | Change resolution (1, 5, 15, 60, D, W, M) |
| `chart_set_type` | Change style (Candles, HeikinAshi, Line, Area, Renko) |
| `chart_manage_indicator` | Add/remove indicators. **Use full names**: "Relative Strength Index" not "RSI" |
| `chart_scroll_to_date` | Jump to a date (ISO: "2025-01-15") |
| `chart_set_visible_range` | Zoom to exact range (unix timestamps) |
| `symbol_info` | Get symbol metadata — exchange, type, description |
| `symbol_search` | Search for symbols by name/keyword |
| `indicator_set_inputs` | Change indicator settings (length, source, period) |
| `indicator_toggle_visibility` | Show/hide an indicator |

### When You Need to Write Pine Script

| Tool | Step |
|------|------|
| `pine_set_source` | 1. Inject code into editor |
| `pine_smart_compile` | 2. Compile with auto-detection + error check |
| `pine_get_errors` | 3. Read compilation errors if any |
| `pine_get_console` | 4. Read log.info() output |
| `pine_save` | 5. Save to TradingView cloud |
| `pine_get_source` | Read current script (**warning: can be 200KB+ for complex scripts**) |
| `pine_new` | Create blank indicator/strategy/library |
| `pine_open` | Open a saved script by name |
| `pine_list_scripts` | List saved scripts |

### When You Need to Practice or Replay

| Tool | Step |
|------|------|
| `replay_start` | Enter replay at a date |
| `replay_step` | Advance one bar |
| `replay_autoplay` | Auto-advance (set speed in ms) |
| `replay_trade` | Buy/sell/close positions |
| `replay_status` | Check position, P&L, date |
| `replay_stop` | Return to realtime |

### When You Need to Draw, Alert, or Automate UI

| Tool | What it does |
|------|-------------|
| `draw_shape` | Draw horizontal_line, trend_line, rectangle, text |
| `draw_list` / `draw_remove_one` / `draw_clear` | Manage drawings |
| `draw_get_properties` | Inspect a drawing's price/style |
| `alert_create` / `alert_list` / `alert_delete` | Manage price alerts |
| `capture_screenshot` | Screenshot (regions: full, chart, strategy_tester) |
| `batch_run` | Run action across multiple symbols/timeframes |
| `ui_open_panel` | Open/close pine-editor, strategy-tester, watchlist, alerts |
| `ui_click` | Click any button by aria-label or text |
| `ui_evaluate` | Execute custom JavaScript in TradingView |
| `ui_find_element` / `ui_hover` / `ui_keyboard` / `ui_mouse_click` / `ui_scroll` / `ui_type_text` | Low-level UI automation |
| `layout_list` / `layout_switch` | Manage saved layouts |
| `watchlist_get` / `watchlist_add` | Read/modify watchlist |
| `tv_launch` | Launch TradingView with CDP (auto-detects platform) |
| `tv_health_check` / `tv_discover` / `tv_ui_state` | Connection diagnostics |

## Context Management

Tools return compact output by default to minimize context usage. For a typical "analyze my chart" workflow, total context is ~5-10KB instead of ~80KB.

| Feature | How it saves context |
|---------|---------------------|
| Pine lines | Returns deduplicated price levels only, not every line object |
| Pine labels | Capped at 50 per study, text+price only |
| Pine tables | Pre-formatted row strings, no cell metadata |
| Pine boxes | Deduplicated {high, low} zones only |
| OHLCV summary mode | Stats + last 5 bars instead of all bars |
| Indicator inputs | Encrypted/encoded blobs auto-filtered |
| `verbose: true` | Pass on any pine tool to get raw data with IDs/colors when needed |
| `study_filter` | Target one indicator instead of scanning all |

## Finding TradingView on Your System

Launch scripts and `tv_launch` auto-detect TradingView. If auto-detection fails:

| Platform | Common Locations |
|----------|-----------------|
| **Mac** | `/Applications/TradingView.app/Contents/MacOS/TradingView` |
| **Windows** | `%LOCALAPPDATA%\TradingView\TradingView.exe`, `%PROGRAMFILES%\WindowsApps\TradingView*\TradingView.exe` |
| **Linux** | `/opt/TradingView/tradingview`, `~/.local/share/TradingView/TradingView`, `/snap/tradingview/current/tradingview` |

The key flag: `--remote-debugging-port=9222`

## Testing

```bash
# Requires TradingView running with --remote-debugging-port=9222
# or an already-running TradingView Desktop session reachable through the
# Electron bridge fallback.
npm test
```

57 tests covering: connection adapter, chart control, OHLCV data, Pine graphics pipeline, data window values, UI control, screenshots, context size validation, tool schema conversion, timeframe normalization, replay date parsing, and Pine compile parsing.

## Architecture

```
Claude Code  ←→  MCP Server (stdio)  ←→  CDP (port 9222) or Electron bridge (port 9229)  ←→  TradingView Desktop
```

- **Transport**: MCP over stdio
- **Connection**: Chrome DevTools Protocol on localhost:9222, with an Electron webContents debugger bridge fallback on localhost:9229
- **No dependencies** beyond `@modelcontextprotocol/sdk` and `chrome-remote-interface`

## Requirements

- TradingView Desktop (Electron app) with `--remote-debugging-port=9222`
- Node.js 18+
- Claude Code with MCP support

## Disclaimer

This project is provided **for personal, educational, and research purposes only**.

**This tool is not affiliated with, endorsed by, or associated with TradingView Inc.** TradingView is a trademark of TradingView Inc.

By using this software, you acknowledge and agree that:

1. **You are solely responsible** for ensuring your use of this tool complies with [TradingView's Terms of Use](https://www.tradingview.com/policies/) and all applicable laws.
2. TradingView's Terms of Use **restrict automated data collection, scraping, and non-display usage** of their platform and data. This tool uses Chrome DevTools Protocol to programmatically interact with the TradingView Desktop app, which may conflict with those terms.
3. **You assume all risk** associated with using this tool. The authors are not responsible for any account bans, suspensions, legal actions, or other consequences resulting from its use.
4. This tool **must not be used** to:
   - Redistribute, resell, or commercially exploit TradingView's market data
   - Circumvent TradingView's access controls or subscription restrictions
   - Perform automated trading or algorithmic decision-making using extracted data
   - Violate the intellectual property rights of Pine Script indicator authors
5. Market data displayed by TradingView is sourced from exchanges and data providers with their own licensing terms. **Do not redistribute this data.**
6. This tool accesses internal, undocumented TradingView APIs that may change or break at any time without notice.

**Use at your own risk.** If you are unsure whether your intended use complies with TradingView's terms, do not use this tool.

## License

MIT — see [LICENSE](LICENSE) for details.

The MIT license applies to the source code of this project only. It does not grant any rights to TradingView's software, data, trademarks, or intellectual property.
