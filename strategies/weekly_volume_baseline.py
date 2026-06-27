#!/usr/bin/env python3
"""
Weekly volume baseline — average 1-minute volume per hour-of-day (ET) over the
trailing week, sourced from yfinance. This replaces the in-browser CDP volume
calculation, which was limited to whatever bars TradingView happened to have
buffered in memory.

Usage:
    python3 weekly_volume_baseline.py MNQ=F,MGC=F [--interval 1m] [--period 7d]

Output (stdout, JSON):
    {
      "MNQ=F": { "0": 412.3, "1": 388.1, ..., "23": 501.9, "_samples": {"0": 35, ...} },
      "MGC=F": { ... }
    }
Hour keys are ET hour-of-day (0-23), values are mean per-bar volume in that hour
bucket across all days in the lookback window.
"""
import sys
import json
import argparse

import yfinance as yf
import pandas as pd


def compute_baseline(ticker: str, interval: str, period: str) -> dict:
    df = yf.download(ticker, period=period, interval=interval, progress=False)
    if df is None or df.empty:
        return {"error": "no data returned"}

    # yfinance sometimes returns a MultiIndex column (Price, Ticker) — flatten it
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC").tz_convert("America/New_York")
    else:
        df.index = df.index.tz_convert("America/New_York")

    df["hour"] = df.index.hour
    grouped = df.groupby("hour")["Volume"]
    means = grouped.mean()
    counts = grouped.count()

    result = {str(h): round(float(means.get(h, 0.0)), 2) for h in range(24)}
    result["_samples"] = {str(h): int(counts.get(h, 0)) for h in range(24)}
    result["_bars_total"] = int(len(df))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("tickers", help="comma-separated yfinance tickers, e.g. MNQ=F,MGC=F")
    parser.add_argument("--interval", default="1m")
    parser.add_argument("--period", default="7d")
    args = parser.parse_args()

    out = {}
    for ticker in args.tickers.split(","):
        ticker = ticker.strip()
        if not ticker:
            continue
        try:
            out[ticker] = compute_baseline(ticker, args.interval, args.period)
        except Exception as e:
            out[ticker] = {"error": str(e)}

    print(json.dumps(out))


if __name__ == "__main__":
    main()
