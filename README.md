# TradingView MCP Bridge

Personal AI assistant for your TradingView Desktop charts. Connects Claude Code to your locally running TradingView app via Chrome DevTools Protocol for AI-assisted chart analysis, Pine Script development, and workflow automation.

> [!WARNING]
> **This tool is not affiliated with, endorsed by, or associated with TradingView Inc.** It interacts with your locally running TradingView Desktop application via Chrome DevTools Protocol. Review the [Disclaimer](#disclaimer) before use.

> [!IMPORTANT]
> **Requires a valid TradingView subscription.** This tool does not bypass or circumvent any TradingView paywall or access control. It reads from and controls the TradingView Desktop app already running on your machine.

> [!NOTE]
> **All data processing occurs locally on your machine.** No TradingView data is transmitted, stored, or redistributed externally by this tool.

> [!CAUTION]
> This tool accesses undocumented internal TradingView APIs via the Electron debug interface. These can change or break without notice in any TradingView update. Pin your TradingView Desktop version if stability matters to you.

## How It Works (and why it's safe to run)

This tool does not connect to TradingView's servers, modify any TradingView files, or intercept any network traffic. It communicates exclusively with your locally running TradingView Desktop instance via Chrome DevTools Protocol (CDP) — a standard debugging interface built into all Chromium/Electron applications by Google, including VS Code, Slack, and Discord.

The debug port is disabled by default and must be explicitly enabled by you using a standard Chromium flag (`--remote-debugging-port=9222`). Nothing happens without that deliberate step.

## What This Tool Does Not Do

- Connect to TradingView's servers or APIs
- Store, transmit, or redistribute any market data
- Work without a valid TradingView subscription and installed Desktop app
- Bypass any TradingView paywall or access restriction
- Execute real trades (chart interaction only)
- Work if TradingView changes their internal Electron structure

## Research Context

This project explores an open research question: **how can LLM-based agents interact with professional trading interfaces to support human decision-making?**

Specifically it investigates:

- How structured tool APIs (MCP) can bridge LLMs and stateful desktop financial applications
- What latency, context, and reliability constraints emerge when an agent operates on live chart data
- How agents handle ambiguous financial UI state (e.g. interpreting Pine Script output, reading indicator tables)
- Whether natural language is an effective interface for chart navigation and Pine Script development
- The failure modes of LLM agents operating in real-time data environments

This is not a trading bot. It is an interface layer that makes a trading application legible to an LLM agent, allowing researchers and developers to study human-AI collaboration in financial workflows.

See [RESEARCH.md](RESEARCH.md) for open questions, findings, and related work.

## Prerequisites

- **TradingView Desktop app** (paid subscription required for real-time data)
- **Node.js 18+**
- **Claude Code** with MCP support (for MCP tools) or any terminal (for CLI)
- **macOS, Windows, or Linux**

## What It Does

Gives your AI assistant eyes and hands on your own chart:

- **Pine Script development** — write, inject, compile, debug, and iterate on scripts with AI assistance
- **Chart navigation** — change symbols, timeframes, zoom to dates, add/remove indicators
- **Visual analysis** — read your chart's indicator values, price levels, and annotations
- **Draw on charts** — trend lines, horizontal lines, rectangles, text annotations
- **Manage alerts** — create, list, and delete price alerts
- **Replay practice** — step through historical bars, practice entries/exits
- **Screenshots** — capture chart state for AI visual analysis
- **Multi-pane layouts** — set up 2x2, 3x1, etc. grids with different symbols per pane
- **Monitor your chart** — stream JSONL from your locally running chart for local monitoring scripts
- **CLI access** — every MCP tool is also a `tv` CLI command, pipe-friendly with JSON output
- **Launch TradingView** — auto-detect and launch with debug mode from any platform

## AI Market Analysis

In raw images the ai will mistake prices.LLM's are better at recognising patterns in ASCII than in raw data or images.
Four tools give Claude a structured, text-based view of price action that it can reason over directly — no screenshot required. All tools require a candlestick-based chart type (Candles, Bars, Hollow Candles, Heikin Ashi). Renko, Kagi, P&F, and Line Break charts are unsupported. 

Combined with chart images it helps the LLM to accurately determine prices and price action sequences and patterns.

---

### `chart_structure` — Swing Structure, Trend Lines, S/R, Al Brooks Signals

The primary analysis tool. Detects swing highs and lows using a ±lookback bar window, labels each confirmed swing as **HH / LH / HL / LL** relative to the prior swing, derives trend lines through consecutive swing points, extracts support and resistance levels, and overlays **Al Brooks consecutive H/L signal bar counts** (H1/H2/H3/H4 = consecutive bullish signal bars; L1/L2/L3/L4 = consecutive bearish).

```
   4825.70 ┤                                     H         H │
           ┤                                 █ █ ▓       │ █ █ ▓
           ┤                               │ █ │ ▓ ▓ │ │ █ █ │ ▓
           ┤                 H       █ │   █ █     ▓ █ ▓ █     ▓
   4774.04 ┤                 │ │     █ ▓ │ █       ▓ █ │ │     ▓
           ┤               █ ▓ █ ▓ █ █ ▓ █ █       L           ▓
           ┤   │ │         █ ▓ █ ▓ █   ▓ █ │                   ▓                                                             H
           ┤   █ ▓       │ █ ▓ █ │                             ▓ │                       H                                   │
   4722.37 ┤ █ █ ▓ ▓ │   │ █                                   ▓ ▓ │                     │         H                       █ ▓ ▓ ▓
           ┤ █   │ ▓ ▓ ▓ █ █                                   │ ▓ ▓ ▓ │                 █ ▓       │ │               │   █ █   │ ▓ █
           ┤ │         ▓ █                                     │ │ │ ▓ ▓                 █ ▓ │ │ █ █ █ │       │     │ █ █
           ┤           L                                       │ │   │ ▓               │ █ ▓ ▓ ▓ █ │   │ │     │   █ ▓ █ │
   4670.71 ┤                                                   L       ▓   █ ▓         █ █   │ ▓ █     ▓ ▓   │ █ ▓ █ │ │ │
           ┤                                                           ▓   █ ▓ │ │ │ │ █ │             │ ▓ │ │ █ │
           ┤                                                           ▓   █ ▓ █ ▓ ▓ │ █               │ ▓ █ █ │ │
           ┤                                                           ▓ │ █   │ │ ▓ █ █               │ ▓ █
   4619.05 ┤                                                           ▓ █ █       │ │ │                   L
           ┤                                                           │ │             │
           ┤                                                             │             L
           ┤                                                             L
           └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
               H L L   L H H       H H L   H H H L L H   H H   L     L L   H     L L H H H   L   H H   L L   H H   H     H H   L L
               1 1 2   1 1 2       1 2 1   1 2 3 1 2 1   1 2   1     1 2   1     1 2 1 2 3   1   1 2   1 2   1 2   1     1 2   1 2
H=SwingHigh L=SwingLow  H1/H2=Bull signal  L1/L2=Bear signal  █=Bull ▓=Bear
```

Alongside the chart, Claude receives structured data it can reason over:

```json
{
  "trend_lines": [
    {
      "role": "Resistance",
      "label": "UpTrend",
      "from": { "bar": 43, "price": 4708.6 },
      "to":   { "bar": 56, "price": 4733.3 },
      "slope": 1.9,
      "current_price": 4739.0
    },
    {
      "role": "Support",
      "label": "UpTrend",
      "from": { "bar": 37, "price": 4605.4 },
      "to":   { "bar": 47, "price": 4625.6 },
      "slope": 2.02,
      "current_price": 4649.84
    }
  ],
  "resistance": [
    { "price": 4733.3, "bar": 56, "label": "HH" },
    { "price": 4708.6, "bar": 43, "label": "LH" },
    { "price": 4726.5, "bar": 38, "label": "LH" }
  ],
  "support": [
    { "price": 4625.6, "bar": 47, "label": "HL" },
    { "price": 4605.4, "bar": 37, "label": "HL" },
    { "price": 4580.3, "bar": 30, "label": "LL" }
  ],
  "brooks_signals": [
    { "bar": 49, "signal": "H2", "price": 4697.7 },
    { "bar": 51, "signal": "H1", "price": 4685.3 },
    { "bar": 54, "signal": "H1", "price": 4714.3 },
    { "bar": 55, "signal": "H2", "price": 4724.6 },
    { "bar": 57, "signal": "L1", "price": 4708.9 },
    { "bar": 58, "signal": "L2", "price": 4703.3 }
  ]
}
```

**Swing detection** is a direct port of `ownership.py:label_structure` — each bar in the lookback window is tested as the highest high or lowest low in a `±lookback` bar range. **Trend lines** connect the last two confirmed swing highs (resistance line) and the last two confirmed swing lows (support line), with slope in points-per-bar and a projected current price. **Al Brooks signals** count consecutive bullish or bearish breakout bars — a bar qualifies as H if it is bullish and its high exceeds the prior bar's high; as L if bearish and its low is below the prior bar's low.

---

### `chart_price_action` — Bar-by-Bar ASCII Candlestick Chart

Renders all bars as a candlestick chart and returns per-bar structure labels Claude can reference.

```
   4825.70 ┤                 │         │ │
           ┤             █ █ ▓       │ █ █ ▓
           ┤           │ █ │ ▓ ▓ │ │ █ █ │ ▓
           ┤     █ │   █ █     ▓ █ ▓ █     ▓
   4774.04 ┤     █ ▓ │ █       ▓ █ │ │     ▓
           ┤ ▓ █ █ ▓ █ █                   ▓
           ┤ ▓ █   ▓ █ │                   ▓
           ┤ │                             ▓ │                                                           │
   4722.37 ┤                               ▓ ▓ │                     │                                 █ ▓ ▓ ▓
           ┤                               │ ▓ ▓ ▓ │                 █ ▓       │ │               │   █ █   │ ▓ █
           ┤                               │ │ │ ▓ ▓                 █ ▓ │ │ █ █ █ │       │     │ █ █
           ┤                               │ │   │ ▓               │ █ ▓ ▓ ▓ █ │   │ │     │   █ ▓ █ │
   4670.71 ┤                                       ▓   █ ▓         █ █   │ ▓ █     ▓ ▓   │ █ ▓ █ │ │ │
           ┤                                       ▓   █ ▓ │ │ │ │ █ │             │ ▓ │ │ █ │
           ┤                                       ▓   █ ▓ █ ▓ ▓ │ █               │ ▓ █ █ │ │
           ┤                                       ▓ │ █   │ │ ▓ █ █               │ ▓ █
   4619.05 ┤                                       ▓ █ █       │ │ │
           ┤                                       │ │             │
           ┤                                         │
           ┤                                         │
           └──────────────────────────────────────────────────────────────────────────────────────────────────────
Legend: █=Bullish  ▓=Bearish  │=Wick
```

Each bar in the returned `bars` array includes:

```json
{
  "index": 15,
  "time": 1775091600,
  "open": 4810.5, "high": 4812.9, "low": 4677.5, "close": 4723.7,
  "volume": 72209,
  "direction": "Bear",
  "vs_high": "LH",
  "vs_low": "LL",
  "pattern": "Bearish Engulf",
  "vol": "AboveAvg"
}
```

Pass `style="heikin_ashi"` for a noise-filtered Heikin-Ashi view that makes trend direction easier to read at a glance.

**Pattern classification** is a direct port of `anatomy.py` — eight patterns detected: Marubozu Bull/Bear (body > 90% of range), Hammer, Shooting Star (dominant wick > 2× the other wick and > 2× the body), Doji (body < 5% of range), Spinning Top (body < 30%, both wicks present), Bullish/Bearish Engulf (body > 60% of range).

---

### `chart_individual_bar` — Single Bar Anatomy

Deep-dives a single bar with an ASCII anatomy diagram and battle narrative.

```
  High  4706.20  ── │  ← Upper wick (37%)
                    │
  Close 4705.60  ── ╔══╗  ← Body (63%) [Bullish]
                    ║  ║
  Open  4704.60  ── ╚══╝
                    │
  Low   4704.60  ── │  ← Lower wick (0%)
```

```json
{
  "anatomy": {
    "total_range": 1.6,
    "body_size":   1.0,
    "body_pct":    63,
    "upper_wick":  0.6,
    "upper_wick_pct": 37,
    "lower_wick":  0.0,
    "lower_wick_pct": 0,
    "direction": "Bullish"
  },
  "candlestick_pattern": "Bullish Engulf",
  "volume_character": "BelowAvg",
  "structure": { "vs_prev_high": "LH", "vs_prev_low": "HL" },
  "battle_narrative": {
    "open":      "Opened at 4704.60",
    "high_move": "High 4706.20 (+1.60 from open)",
    "low_move":  "Low 4704.60 (0.00 from open)",
    "close":     "Closed at 4705.60 (+1.00 net)"
  }
}
```

Use `bar_index` to select any bar in the window (0 = oldest, default = most recent).

---

### `chart_volume_profile` — Volume Distribution Histogram

Builds a volume profile across price buckets and renders a horizontal histogram showing where volume traded and which side dominated at each level.

```
   4817.81 ┤ █████░                   (   42949)
   4802.02 ┤ ██████░░░                (   70441)
   4786.24 ┤ █████░░░░                (   68784)
   4770.45 ┤ █████░░░░░               (   75701)
   4754.67 ┤ ███████░░░░░             (   86894)
   4738.88 ┤ ████░░░░                 (   59923)
   4723.10 ┤ ███████░░░░░░░░          (  113743) ← VAH
   4707.31 ┤ ██████████░░░░░░░░░░░    (  157785)
   4691.53 ┤ ████████████░░░░░░░░░░░░ (  178034) ← POC
   4675.74 ┤ ███████████░░░░░░░       (  134688)
   4659.96 ┤ █████████░░░░░░░         (  115734)
   4644.17 ┤ ███████████░░░░░░░       (  131712)
   4628.39 ┤ █████████░░░░░░          (  107966)
   4612.60 ┤ ███████░░░░              (   82708)
   4596.82 ┤ ██████████░░░░░░         (  118254)
   4581.03 ┤ █████████░░░░░           (  106728)
   4565.25 ┤ █████████░░░░░░░         (  119473) ← VAL
   4549.46 ┤ ███████░░░░░░            (   94607)
   4533.68 ┤ ████░░                   (   47326)
   4517.89 ┤ ██                       (   11619)
Legend: █=Buying  ░=Selling  POC=Point of Control  VAH/VAL=Value Area
```

Returns Point of Control (highest-volume price), Value Area High and Low (the band containing 70% of total session volume), and per-level buying vs selling volume split. Use to identify high-volume nodes where price accepted value, thin areas price will move through quickly, and the dominant side at each level.


### Example Usage
```
Analyse the chart using al brooks and price action tools
```

```
**MGC1! — Micro Gold Futures | 5-min | 4720.00**

---

**Macro Structure (60 bars)**

Bullish HH sequence intact: 4688 → 4693 → 4720.7 → **4733.3** — four consecutive higher highs. However, the swing low sequence **broke down**: after HL at 4723.4, the last swing low printed **LL at 4712.4**. That LL is the warning sign — the uptrend is cracking.

**Resistance trend line** (through HHs): slope +0.63/bar, currently projecting **4742** — still rising but price is lagging it.
**Support trend line** (through lows): slope -0.85/bar, now at **4708** — falling, meaning bears are accelerating their lows.

---

**Recent Tape (last 15 bars)**

| Phase | What happened |
|---|---|
| **Bar 35** | Shooting Star at 4733.3 — top wick rejection, warned of exhaustion |
| **Bars 36–38** | Two Bearish Engulfs + above-avg volume (1886 on bar 37) — bears asserted hard, L1/L2 printed |
| **Bar 39** | H1 bull recovery — but stalled below 4724, couldn't make HH |
| **Bars 40–41** | Bearish Engulf cascade, LL confirmed at 4712.5 — bears broke the HL |
| **Bars 42–47** | Choppy bull recovery, two H1s — low conviction, spinning tops, no follow-through |
| **Bar 48** | ⚠️ **Key bar**: Opens 4722.1 → wicks to 4708.9 → closes 4718.9. Range 13.2pts, AboveAvg volume (1776). Bears drove 13 points and bulls only recovered 10. L1 signal. This bar dominates the recent context. |
| **Bar 49 (now)** | Hammer at 4719.7, BelowAvg volume (131) — tentative bounce, no conviction |

---

**Current Context**

Price is sitting on **old swing high 4720.7** — now being tested as support. The battle is whether this level holds as a pullback or cracks as a failed breakout.

- **Bulls need:** Close above 4724 (last H1 high) to signal H2 continuation toward 4733 then 4742
- **Bears need:** Break below 4712.4 (confirmed LL) to trigger next leg toward 4708 trend line → 4693 old HH

**The big bar 48 is the tell** — 13-point bear range on elevated volume means institutional selling returned at 4722. The current hammer is low volume and sitting inside bar 48's range. Until price breaks above 4722, bears own this pullback.

**Bias:** Neutral-to-bearish at 4720. Watch 4724 for bull reclaim, 4712 for bear continuation.
```

---

## Install with Claude Code

Paste this into Claude Code and it will handle the rest:

> Install the TradingView MCP server. Clone https://github.com/tradesdontlie/tradingview-mcp.git, run npm install, add it to my MCP config at ~/.claude/.mcp.json, and launch TradingView with the debug port. Then verify the connection with tv_health_check.

Or follow the manual steps below.

## Quick Start

### 1. Install

```bash
git clone https://github.com/tradesdontlie/tradingview-mcp.git
cd tradingview-mcp
npm install
```

### 2. Launch TradingView with CDP

TradingView Desktop must be running with Chrome DevTools Protocol enabled on port 9222.

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

## CLI

Every MCP tool is also accessible as a `tv` CLI command. All output is JSON for piping with `jq`.

```bash
# Install globally (optional)
npm link

# Or run directly
node src/cli/index.js <command>
```

### Quick Examples

```bash
tv status                          # check connection
tv quote                           # current price
tv symbol AAPL                     # change symbol
tv ohlcv --summary                 # price summary
tv screenshot -r chart             # capture chart
tv pine compile                    # compile Pine Script
tv pane layout 2x2                 # 4-chart grid
tv pane symbol 1 ES1!              # set pane symbol
tv stream quote | jq '.close'      # monitor price changes
```

### All Commands

```
tv status / launch / state / symbol / timeframe / type / info / search
tv quote / ohlcv / values
tv data lines/labels/tables/boxes/strategy/trades/equity/depth/indicator
tv pine get/set/compile/analyze/check/save/new/open/list/errors/console
tv draw shape/list/get/remove/clear
tv alert list/create/delete
tv watchlist get/add
tv indicator add/remove/toggle/set/get
tv layout list/switch
tv pane list/layout/focus/symbol
tv tab list/new/close/switch
tv replay start/step/stop/status/autoplay/trade
tv stream quote/bars/values/lines/labels/tables/all
tv ui click/keyboard/hover/scroll/find/eval/type/panel/fullscreen/mouse
tv screenshot / discover / ui-state / range / scroll
```

## Streaming

The `tv stream` commands poll your locally running TradingView Desktop instance at regular intervals via Chrome DevTools Protocol on localhost.

No connection is made to TradingView's servers. All data stays on your machine.

> [!WARNING]
> Programmatic consumption of TradingView data may conflict with their Terms of Use regardless of the data source. You are solely responsible for ensuring your usage complies.

```bash
tv stream quote                          # price tick monitoring
tv stream bars                           # bar-by-bar updates
tv stream values                         # indicator value monitoring
tv stream lines --filter "NY Levels"     # price level monitoring
tv stream tables --filter Profiler       # table data monitoring
tv stream all                            # all panes at once (multi-symbol)
```

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
| "Set up a 4-chart grid" | `pane_set_layout` → `pane_set_symbol` for each pane |
| "Draw a level at 24500" | `draw_shape` (horizontal_line) |
| "Take a screenshot" | `capture_screenshot` |

## Tool Reference (78 MCP tools)

### Chart Reading

| Tool | When to use | Output size |
|------|------------|-------------|
| `chart_get_state` | First call — get symbol, timeframe, all indicator names + IDs | ~500B |
| `data_get_study_values` | Read current RSI, MACD, BB, EMA values from all indicators | ~500B |
| `quote_get` | Get latest price, OHLC, volume | ~200B |
| `data_get_ohlcv` | Get price bars. **Use `summary: true`** for compact stats | 500B (summary) / 8KB (100 bars) |

### Custom Indicator Data (Pine Drawings)

Read `line.new()`, `label.new()`, `table.new()`, `box.new()` output from any visible Pine indicator.

| Tool | When to use | Output size |
|------|------------|-------------|
| `data_get_pine_lines` | Read horizontal price levels (support/resistance, session levels) | ~1-3KB |
| `data_get_pine_labels` | Read text annotations + prices ("PDH 24550", "Bias Long") | ~2-5KB |
| `data_get_pine_tables` | Read data tables (session stats, analytics dashboards) | ~1-4KB |
| `data_get_pine_boxes` | Read price zones / ranges as {high, low} pairs | ~1-2KB |

**Always use `study_filter`** to target a specific indicator: `study_filter: "Profiler"`.

### Chart Control

| Tool | What it does |
|------|-------------|
| `chart_set_symbol` | Change ticker (BTCUSD, AAPL, ES1!, NYMEX:CL1!) |
| `chart_set_timeframe` | Change resolution (1, 5, 15, 60, D, W, M) |
| `chart_set_type` | Change style (Candles, HeikinAshi, Line, Area, Renko) |
| `chart_manage_indicator` | Add/remove indicators. **Use full names**: "Relative Strength Index" not "RSI" |
| `chart_scroll_to_date` | Jump to a date (ISO: "2025-01-15") |
| `chart_set_visible_range` | Zoom to exact range (unix timestamps) |
| `symbol_info` / `symbol_search` | Symbol metadata and search |
| `indicator_set_inputs` / `indicator_toggle_visibility` | Change indicator settings, show/hide |

### Multi-Pane Layouts

| Tool | What it does |
|------|-------------|
| `pane_list` | List all panes with symbols and active state |
| `pane_set_layout` | Change grid: `s`, `2h`, `2v`, `2x2`, `4`, `6`, `8` |
| `pane_focus` | Focus a specific pane by index |
| `pane_set_symbol` | Set symbol on any pane |

### Tab Management

| Tool | What it does |
|------|-------------|
| `tab_list` | List open chart tabs |
| `tab_new` / `tab_close` | Open/close tabs |
| `tab_switch` | Switch to a tab by index |

### Pine Script Development

| Tool | Step |
|------|------|
| `pine_set_source` | 1. Inject code into editor |
| `pine_smart_compile` | 2. Compile with auto-detection + error check |
| `pine_get_errors` | 3. Read compilation errors if any |
| `pine_get_console` | 4. Read log.info() output |
| `pine_save` | 5. Save to TradingView cloud |
| `pine_get_source` | Read current script (**warning: can be 200KB+ for complex scripts**) |
| `pine_new` | Create blank indicator/strategy/library |
| `pine_open` / `pine_list_scripts` | Open or list saved scripts |
| `pine_analyze` | Offline static analysis (no chart needed) |
| `pine_check` | Server-side compile check (no chart needed) |

### Replay Mode

| Tool | Step |
|------|------|
| `replay_start` | Enter replay at a date |
| `replay_step` | Advance one bar |
| `replay_autoplay` | Auto-advance (set speed in ms) |
| `replay_trade` | Buy/sell/close positions |
| `replay_status` | Check position, P&L, date |
| `replay_stop` | Return to realtime |

### Drawing, Alerts, UI Automation

| Tool | What it does |
|------|-------------|
| `draw_shape` | Draw horizontal_line, trend_line, rectangle, text |
| `draw_list` / `draw_remove_one` / `draw_clear` | Manage drawings |
| `alert_create` / `alert_list` / `alert_delete` | Manage price alerts |
| `capture_screenshot` | Screenshot (regions: full, chart, strategy_tester) |
| `batch_run` | Run action across multiple symbols/timeframes |
| `watchlist_get` / `watchlist_add` | Read/modify watchlist |
| `layout_list` / `layout_switch` | Manage saved layouts |
| `ui_open_panel` / `ui_click` / `ui_evaluate` | UI automation |
| `tv_launch` / `tv_health_check` / `tv_discover` | Connection management |

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
npm test
```

29 tests covering: Pine Script static analysis, server-side compilation, and CLI routing.

## Architecture

```
Claude Code  ←→  MCP Server (stdio)  ←→  CDP (port 9222)  ←→  TradingView Desktop (Electron)
```

- **Transport**: MCP over stdio (78 tools) + CLI (`tv` command, 30 commands with 66 subcommands)
- **Connection**: Chrome DevTools Protocol on localhost:9222
- **Streaming**: Poll-and-diff loop with deduplication, JSONL output to stdout
- **No dependencies** beyond `@modelcontextprotocol/sdk` and `chrome-remote-interface`

## Attributions

This project is not affiliated with, endorsed by, or associated with:
- **TradingView Inc.** — TradingView is a trademark of TradingView Inc.
- **Anthropic** — Claude and Claude Code are trademarks of Anthropic, PBC.

This tool is an independent MCP server that connects to Claude Code via the standard MCP protocol. It does not contain or modify any Anthropic software.

## Disclaimer

This project is provided **for personal, educational, and research purposes only**.

**How this tool works:** This tool uses the Chrome DevTools Protocol (CDP), a standard debugging interface built into all Chromium-based applications by Google. It does not reverse engineer any proprietary TradingView protocol, connect to TradingView's servers, or bypass any access controls. The debug port must be explicitly enabled by the user via a standard Chromium command-line flag (`--remote-debugging-port=9222`).

By using this software, you acknowledge and agree that:

1. **You are solely responsible** for ensuring your use of this tool complies with [TradingView's Terms of Use](https://www.tradingview.com/policies/) and all applicable laws.
2. TradingView's Terms of Use **restrict automated data collection, scraping, and non-display usage** of their platform and data. This tool uses Chrome DevTools Protocol to programmatically interact with the TradingView Desktop app, which may conflict with those terms.
3. **You assume all risk** associated with using this tool. The authors are not responsible for any account bans, suspensions, legal actions, or other consequences resulting from its use.
4. This tool **must not be used** for, including but not limited to:
   - Redistributing, reselling, or commercially exploiting TradingView's market data
   - Circumventing TradingView's access controls or subscription restrictions
   - Performing automated trading or algorithmic decision-making using extracted data
   - Violating the intellectual property rights of Pine Script indicator authors
   - Connecting to TradingView's servers or infrastructure (all access is via the locally running Desktop app)
5. The streaming functionality monitors your locally running TradingView Desktop instance only. It does not connect to TradingView's servers or extract data from TradingView's infrastructure.
6. Market data accessed through this tool remains subject to exchange and data provider licensing terms. **Do not redistribute, store, or commercially exploit any data obtained through this tool.**
7. This tool accesses internal, undocumented TradingView application interfaces that may change or break at any time without notice.

**Use at your own risk.** If you are unsure whether your intended use complies with TradingView's terms, do not use this tool.

## License

MIT — see [LICENSE](LICENSE) for details.

The MIT license applies to the source code of this project only. It does not grant any rights to TradingView's software, data, trademarks, or intellectual property.
