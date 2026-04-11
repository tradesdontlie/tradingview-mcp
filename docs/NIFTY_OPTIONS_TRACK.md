# Nifty Options Track

## What This Is

This repo now has two layers:

- the original TradingView MCP bridge for chart control, Pine editing, replay, and screenshots
- a local Nifty options research and paper-trading stack built on Kite caches and archived NSE derivative data

The current research direction is:

- use the underlying index signal as the signal engine
- trade Nifty options, not futures, as the primary vehicle
- keep execution paper-only until option-specific history and forward validation are strong enough
- stay intraday-first, not overnight-ATM-carry-first

## Current Default Nifty Setup

The live-paper default now uses:

- signal family: midday continuation
- threshold: `0.50%`
- confirmation: proxy `VWAP`
- instrument mode: `atm_option`
- latest entry: `14:45 IST`
- hard exit: disabled for Nifty by default, so the option trade holds to end of day unless overridden
- primary vehicle: ATM option buy
- secondary vehicle: companion debit spread journal

Config file:

- [live_paper_strategy.json](/Users/mananagarwal/Desktop/trading%20view%20mcp/config/live_paper_strategy.json)

## Main Scripts

### Live / paper trade

- [kite_index_paper_trade.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/kite_index_paper_trade.py)
  - current live-paper runner
  - can trade:
    - underlying-direction proxy
    - ATM option buy
    - companion Nifty debit spread journal
  - now supports:
    - optional hard exit
    - proxy VWAP confirmation
    - archive-derived caution flags for extreme move days and Tuesdays

### Research

- [nifty_kite_enhanced_research.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/nifty_kite_enhanced_research.py)
  - Nifty-only expanding-window OOS research harness
  - compares time variants and filter variants
  - separates research sample from untouched recent holdout

- [kite_strict_execution_report.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/kite_strict_execution_report.py)
  - strict charge-aware futures-style proxy report

- [nifty_option_eod_overlay.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/nifty_option_eod_overlay.py)
  - first archived-option overlay
  - joins signal days with archived NSE option EOD data
  - important limitation:
    - this is an EOD option overlay, not an intraday option backtest

### Historical option data

- [fetch_nse_fo_bhavcopy.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/fetch_nse_fo_bhavcopy.py)
  - downloads official NSE derivative bhavcopy zip archives
  - normalizes `OPTIDX` rows for Nifty
  - merges slices into a local reusable option EOD store

## Stored Data

### Local-only raw caches

These are intentionally gitignored:

- `market/raw/kite/`
  - Kite daily, 1h, 15m index bars
  - instrument dumps
  - option candle caches
- `market/raw/groww/`
  - earlier Groww historical/cache experiments
- `market/raw/nse/`
  - official NSE derivative bhavcopy archive slices
  - normalized Nifty option EOD tables
- `market/paper_trades*/`
  - paper-trade journals

### Useful current local datasets

- `market/raw/kite/NIFTY_15minute.parquet`
- `market/raw/kite/NIFTY_daily.parquet`
- `market/raw/kite/NIFTYBEES_15minute.parquet`
- `market/raw/nse/options/NIFTY_OPTIDX_eod.parquet`

## Reports

Current Nifty research summaries are generated into `market/reports/`.

Most JSON/CSV outputs are gitignored because they are generated artifacts. The key narrative report is:

- [nifty_todo_report_2026-04-10.md](/Users/mananagarwal/Desktop/trading%20view%20mcp/market/reports/nifty_todo_report_2026-04-10.md)

## Tests

### Existing repo tests

The original TradingView MCP bridge has its JavaScript test suite under:

- [tests](/Users/mananagarwal/Desktop/trading%20view%20mcp/tests)

These cover the MCP/CLI surface, not the Python trading research scripts.

### Python validation style

The Python research layer is currently validated by:

- `py_compile` smoke checks
- direct script runs against cached data
- generated JSON report inspection
- live-paper journal inspection

This is good enough for research iteration, but not yet a formal Python unit-test suite.

## What Is Ready vs Not Ready

### Ready

- local historical index research
- option paper-trade journaling
- archived NSE option EOD storage
- same-day ATM option and debit-spread paper examples

### Not ready

- unattended live broker execution
- exact intraday historical option backtests across years
- LLM-controlled execution
- production risk engine

## Current Honest Limitation

The biggest remaining blocker is still data granularity:

- archived NSE bhavcopy gives us real option contract history and settlements
- but it is daily EOD, not intraday option bars

That means the repo can now support:

- exact option contract reconstruction
- expiry/strike/turnover/open-interest history
- daily option overlays

But it still cannot claim:

- exact intraday ATM option P&L back to 2020

for that, we still need richer historical option bar data.

## Current Practical Rules

- Do not treat signal-day-close to next-day-close ATM option carry as the default strategy.
- Keep the live option path intraday-first.
- Keep ATM option buys as the primary simple vehicle.
- Keep spreads as a secondary overlay, especially when we want capped premium and less volatility exposure.
- Treat `1.00%+` signal days and Tuesdays as caution regimes from the archive slice, not as hard proven skip rules yet.
