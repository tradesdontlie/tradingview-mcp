# Scripts Inventory

This folder now contains two kinds of scripts:

- the original TradingView MCP helper scripts
- the added India index / Nifty options research and paper-trading scripts

## Main Entry Points

### TradingView MCP helpers

- `launch_tv_debug_mac.sh`
- `launch_tv_debug_linux.sh`
- `launch_tv_debug.bat`
- `pine_pull.js`
- `pine_push.js`

### Nifty options track

- [kite_index_paper_trade.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/kite_index_paper_trade.py)
  - main live-paper runner
  - current Nifty default path
  - supports underlying proxy, ATM option buy, and companion debit spread journal

- [nifty_kite_enhanced_research.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/nifty_kite_enhanced_research.py)
  - Nifty-only expanding-window OOS research harness
  - compares threshold, timing, and filter variants

- [nifty_option_eod_overlay.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/nifty_option_eod_overlay.py)
  - overlays historical signal days onto archived NSE option EOD data
  - useful for contract reconstruction and pattern checks
  - not an intraday option backtester

## Data Fetchers

- [fetch_kite_index_history.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/fetch_kite_index_history.py)
  - fetches and caches Kite index history plus reference files

- [fetch_nse_fo_bhavcopy.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/fetch_nse_fo_bhavcopy.py)
  - downloads official NSE derivative bhavcopy archives
  - merges Nifty `OPTIDX` rows into a reusable local EOD option store

- [fetch_groww_index_backtest_data.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/fetch_groww_index_backtest_data.py)
- [fetch_groww_index_intraday_data.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/fetch_groww_index_intraday_data.py)
  - older Groww cache builders kept for comparison and fallback

## Research / Diagnostics

- [india_intraday_research.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/india_intraday_research.py)
  - broad multi-variant research harness
  - original rolling-window OOS path

- [kite_strict_execution_report.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/kite_strict_execution_report.py)
  - applies strict Kite charge assumptions to directional futures-style proxies

- [audit_kite_market_store.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/audit_kite_market_store.py)
  - checks local Kite coverage and enrichment gaps

- [single_name_intraday_research.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/single_name_intraday_research.py)
  - HDFCBANK / BAJFINANCE exploratory work

## Paper-Trading Utilities

- [groww_index_paper_trade.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/groww_index_paper_trade.py)
- [groww_index_daily_runner.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/groww_index_daily_runner.py)
- [groww_index_ledger_report.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/groww_index_ledger_report.py)
- [index_forward_trial.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/index_forward_trial.py)
- [index_go_no_go_review.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/index_go_no_go_review.py)

These are still useful for historical context, but the repo's primary path has shifted toward `Kite + Nifty options`.

## Auth / Webhooks

- [kite_api.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/kite_api.py)
  - common Kite REST helpers

- [kite_auth_session.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/kite_auth_session.py)
  - handles login flow, token exchange, and local session storage

- [kite_callback_listener.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/kite_callback_listener.py)
- [tradingview_webhook_listener.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/tradingview_webhook_listener.py)
  - webhook / callback utilities

## Pine Scripts

- [index_midday_momentum_live.pine](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/index_midday_momentum_live.pine)
- [nifty_midday_momentum.pine](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/nifty_midday_momentum.pine)

These are visual / alert-side strategy representations, not the canonical research engine.

## Validation

Current validation style is:

- `npm test` for the original JavaScript bridge
- `python3 -m py_compile ...` smoke checks for Python scripts
- direct script runs against cached data
- report inspection in `market/reports/`
- paper-trade journal inspection in `market/paper_trades*`

There is not yet a dedicated Python unit-test suite for the research layer.
