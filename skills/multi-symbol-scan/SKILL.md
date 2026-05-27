---
name: multi-symbol-scan
description: Scan multiple symbols for setups, patterns, or strategy performance. Use when comparing across instruments or screening for opportunities.
---

# Multi-Symbol Scanner

You are scanning multiple symbols for trading setups or comparing performance.

## Step 1: Define the Scan

Determine:
- **Symbols**: Which instruments to scan (user-provided or watchlist via `watchlist_get`)
- **Timeframe**: Which timeframe to analyze
- **Criteria**: What to look for (indicator values, strategy results, visual patterns)

## Step 2: Run the Scan

### For Strategy Performance Comparison
Use `batch_run` with action `get_strategy_results`:
```
symbols: ["ES1!", "NQ1!", "YM1!", "RTY1!"]
timeframes: ["15"]
action: "get_strategy_results"
```

### For Screenshot Comparison
Use `batch_run` with action `screenshot`:
```
symbols: ["AAPL", "MSFT", "GOOGL", "AMZN"]
timeframes: ["D"]
action: "screenshot"
```

### For Per-Symbol Pine Output Extraction (audit C6/A1-F1)
**Use `pine_extract_per_symbol`** for any sweep >5 symbols reading Pine
labels/tables/lines/boxes. This single call replaces the manual loop
that shipped 8/244 tickers in the original audit session
(CC TV MCP.txt:431, 1337):

```
pine_extract_per_symbol({
  study_filter: "EarnsExtractor",
  symbols: ["TADAWUL:2222", "TADAWUL:1120", "TADAWUL:1031", ...],
  emit: ["labels"],
  wait_after_switch_s: 8,
  verify_with_known_good: "TADAWUL:2222",  // fail-fast on broken pipeline
  abort_after_consecutive_empty: 5,         // bail if Pine state degrades
})
```

### For Custom Analysis (per-symbol)
Loop through symbols manually ONLY when `pine_extract_per_symbol` cannot
express the read (e.g. needing OHLCV per symbol, not Pine output):
1. `chart_ensure_symbol(symbol, require_ready=true)` — hard-stops on
   not-ready (audit C11)
2. `pine_wait_for_output(study_filter, expected_for_symbol=symbol)` —
   NEVER use `Bash(sleep N)` to wait for TV state (audit C5)
3. `data_get_ohlcv` — pull price data
4. `data_get_indicator` — read indicator values
5. Analyze and record findings

### Pre-flight + cadence (audit C4/A1-F2/A2-F6)
Before any sweep:
1. Ask the user to close the **TradingView Desktop app**. Desktop +
   browser-tab sessions on the same account silently freeze Pine
   evaluation across symbol switches.
2. Call `tv_health_check` — verify `possible_session_contention:false`
   AND `api_available:true`.

During the sweep:
- Re-probe `tv_health_check` every ~10 symbols. Stop on
  `possible_session_contention:true` and ask the user to close the
  contending session.

## Step 3: Compile Results

Build a comparison table:
| Symbol | Key Metric 1 | Key Metric 2 | Signal |
|--------|-------------|-------------|--------|

Sort by the most relevant metric.

## Step 4: Report

Present findings:
- Ranked list of symbols by the scan criteria
- Highlight the strongest setups
- Note any divergences or anomalies
- Screenshot the top 1-2 charts for visual confirmation

## Watchlist Integration

To scan the user's watchlist:
1. `watchlist_get` — read all symbols
2. Use the symbol list for the scan
3. `watchlist_add` — add new finds to the watchlist
