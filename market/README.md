# Market Data Store

This folder is the local data lake for the repo's research and paper-trading layer.

It exists so we do not have to keep hitting broker or archive APIs every time we rerun a backtest.

## Layout

- `raw/kite/`
  - cached Kite index bars
  - reference instrument dumps
  - live-paper option candle caches
- `raw/groww/`
  - older Groww index and option research caches
- `raw/nse/`
  - official NSE derivative bhavcopy archive slices
  - normalized Nifty option EOD datasets
- `processed/`
  - aligned matrices and derived research datasets when needed
- `reports/`
  - generated research summaries
  - markdown reports are the human-friendly entry point
- `manifest.json`
  - lightweight store summary

## Current Important Datasets

### Kite

- `raw/kite/NIFTY_daily.parquet`
- `raw/kite/NIFTY_15minute.parquet`
- `raw/kite/NIFTYBEES_15minute.parquet`
- `raw/kite/reference/instruments_latest.csv`

### NSE archives

- `raw/nse/options/NIFTY_OPTIDX_eod.parquet`
  - normalized option EOD rows from official NSE derivative bhavcopy archives
  - fields include trade date, expiry, strike, option type, OHLC, settle, contracts, turnover, open interest

## Build / Refresh

### Kite index history

```bash
python3 scripts/fetch_kite_index_history.py --json
```

### Official NSE Nifty option EOD history

```bash
python3 scripts/fetch_nse_fo_bhavcopy.py --symbol NIFTY --start 2024-01-01 --end 2024-12-31 --json
```

The script merges new slices into the existing local option EOD store instead of overwriting prior backfills.

## Notes

- Most files in this folder are gitignored because they can be large and are reproducible from scripts.
- JSON and CSV reports are also mostly generated artifacts.
- The repo docs point to the scripts and markdown reports, while the heavy raw data stays local.
- The current option archive is honest but limited:
  - it gives real historical contracts and EOD prices
  - it does not yet give exact intraday option bars across history
