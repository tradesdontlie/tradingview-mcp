#!/usr/bin/env python3
"""
Asian index snapshot — Hang Seng (HK), Nikkei 225 (Japan), KOSPI (Korea).
A big overnight drop in any of these during Asia hours can spill over into
MNQ/ES futures before NY open, so we flag moves beyond a threshold.

Usage:
    python3 asia_indices.py [--drop-threshold -1.5]

Output (stdout, JSON):
    {
      "HSI":   { "name": "Hang Seng",  "price": 17890.2, "changePct": -2.13, "bigDrop": true,  ... },
      "N225":  { "name": "Nikkei 225", "price": 38210.5, "changePct": -0.42, "bigDrop": false, ... },
      "KOSPI": { "name": "KOSPI",      "price": 2580.1,  "changePct": -1.81, "bigDrop": true,  ... }
    }
"""
import sys
import json
import argparse

import yfinance as yf

TICKERS = {
    "HSI":   {"symbol": "^HSI",  "name": "Hang Seng (HK)"},
    "N225":  {"symbol": "^N225", "name": "Nikkei 225 (JP)"},
    "KOSPI": {"symbol": "^KS11", "name": "KOSPI (KR)"},
}


def fetch_one(key, meta, drop_threshold):
    try:
        t = yf.Ticker(meta["symbol"])
        hist = t.history(period="5d", interval="1d")
        if hist is None or hist.empty or len(hist) < 2:
            return {"name": meta["name"], "error": "no data"}

        last_close = float(hist["Close"].iloc[-1])
        prev_close = float(hist["Close"].iloc[-2])
        change_pct = round((last_close - prev_close) / prev_close * 100, 2)

        # also grab intraday last price if available (more current than daily close)
        intraday_price = last_close
        try:
            fast = t.fast_info
            if fast and fast.get("lastPrice"):
                intraday_price = float(fast["lastPrice"])
        except Exception:
            pass

        return {
            "name": meta["name"],
            "price": round(intraday_price, 2),
            "prevClose": round(prev_close, 2),
            "changePct": change_pct,
            "bigDrop": change_pct <= drop_threshold,
            "bigRally": change_pct >= abs(drop_threshold),
        }
    except Exception as e:
        return {"name": meta["name"], "error": str(e)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--drop-threshold", type=float, default=-1.5,
                         help="changePct at/below this marks bigDrop=true (default -1.5)")
    args = parser.parse_args()

    out = {}
    for key, meta in TICKERS.items():
        out[key] = fetch_one(key, meta, args.drop_threshold)

    print(json.dumps(out))


if __name__ == "__main__":
    main()
