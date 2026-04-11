# Repo Capabilities

This is the shortest honest map of what the repo can do right now and what data each path uses.

## 1. TradingView MCP Bridge

Purpose:

- connect to a locally running TradingView chart via CDP
- change symbols and timeframes
- read chart state
- compile Pine
- automate chart-side workflows

Code:

- [src](/Users/mananagarwal/Desktop/trading%20view%20mcp/src)
- [tests](/Users/mananagarwal/Desktop/trading%20view%20mcp/tests)

Validation:

- `npm run test:unit`
- `npm test` when a live TradingView CDP target is available

Data used:

- no stored historical market lake required
- operates against the locally running TradingView instance

## 2. Nifty Live Paper Trade

Purpose:

- run the current Nifty intraday option paper path
- use the underlying signal as the trigger
- buy an ATM option as the primary vehicle
- journal a companion debit spread as a secondary overlay

Code:

- [kite_index_paper_trade.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/kite_index_paper_trade.py)
- [live_paper_strategy.json](/Users/mananagarwal/Desktop/trading%20view%20mcp/config/live_paper_strategy.json)

Current default behavior:

- `NIFTY`
- `0.50%` threshold
- proxy `VWAP` confirmation from `NIFTYBEES`
- no new entries after `14:45 IST`
- Nifty hard exit disabled by default
- ATM option primary, debit spread secondary

Data used:

- `market/raw/kite/NIFTY_15minute.parquet`
- `market/raw/kite/NIFTY_daily.parquet`
- `market/raw/kite/NIFTYBEES_15minute.parquet`
- `market/raw/kite/reference/instruments_latest.csv`
- live/current option candles fetched and cached under `market/raw/kite/options/`

Current local coverage:

- `NIFTY_daily.parquet`: `2020-01-01` to `2026-04-10`, `1559` rows
- `NIFTY_15minute.parquet`: `2020-01-01 09:15` to `2026-04-10 15:15`, `38797` rows
- `NIFTYBEES_15minute.parquet`: `2020-01-01 09:15` to `2026-04-10 15:15`, `38797` rows

## 3. Nifty Expanding-Window Research

Purpose:

- test Nifty signal variants on local Kite history
- use expanding-window OOS selection
- keep a recent holdout outside candidate selection

Code:

- [nifty_kite_enhanced_research.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/nifty_kite_enhanced_research.py)

Data used:

- `market/raw/kite/NIFTY_15minute.parquet`
- `market/raw/kite/NIFTY_daily.parquet`
- `market/raw/kite/NIFTYBEES_15minute.parquet`
- `market/raw/yfinance/_idx_INDIAVIX.pkl`

Current local coverage:

- India VIX cache: `2012-04-02` to `2026-04-02`, `3434` rows

Important note:

- this is still a futures-style underlying proxy research path
- it is not an exact historical option backtest

## 4. Strict Charge-Aware Futures Proxy Report

Purpose:

- apply Kite/Zerodha-style order charges to the underlying directional proxy
- stress-test whether the signal survives realistic costs

Code:

- [kite_strict_execution_report.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/kite_strict_execution_report.py)

Data used:

- same Kite index caches as the research harness
- current order-charge calls from Kite

Important note:

- useful for signal economics
- not the same thing as exact historical futures execution

## 5. NSE Option Archive Overlay

Purpose:

- reconstruct real historical Nifty option contracts from official NSE bhavcopy
- overlay signal days onto archived option EOD prices
- extract regime clues

Code:

- [fetch_nse_fo_bhavcopy.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/fetch_nse_fo_bhavcopy.py)
- [nifty_option_eod_overlay.py](/Users/mananagarwal/Desktop/trading%20view%20mcp/scripts/nifty_option_eod_overlay.py)

Data used:

- `market/raw/nse/options/NIFTY_OPTIDX_eod.parquet`
- signal days from the Nifty research harness

Current local coverage:

- `NIFTY_OPTIDX_eod.parquet`: `2022-01-03` to `2024-07-05`, `205681` rows
- `131` trade dates
- `61` expiries
- `263` strikes
- option types: `CE`, `PE`

Important note:

- this is EOD option history only
- it is good for structure and regime analysis
- it is not an intraday historical option bar backtest
