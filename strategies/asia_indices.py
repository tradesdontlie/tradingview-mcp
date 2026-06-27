#!/usr/bin/env python3
"""
Real-time Asian index snapshot — Hang Seng (HK), Nikkei 225 (Japan), KOSPI
(Korea). Uses intraday 1-minute bars (not daily candles) so a sharp drop or
reversal *during* the Asian session shows up immediately — this is what can
spill over into MNQ/ES before NY open, not yesterday's close-to-close move.

Usage:
    python3 asia_indices.py [--drop-threshold -1.0]

Output (stdout, JSON):
    {
      "HSI": {
        "name": "Hang Seng (HK)",
        "price": 22671.86,            # most recent intraday price
        "asOf": "2026-06-26T16:08:00+08:00",
        "marketOpen": true,           # is the last bar within the last ~10 min?
        "sessionOpen": 23076.91,      # today's opening print
        "sessionHigh": 23120.4,
        "sessionLow": 22650.1,
        "prevClose": 23076.91,        # prior session's close
        "changeFromOpenPct": -1.76,   # vs today's open
        "changeFromPrevClosePct": -2.10,
        "dropFromHighPct": -1.95,     # drawdown from today's session high (catches reversals)
        "bigDrop": true
      },
      ...
      "_impact": {
        "redCount": 2,
        "score": 3.85,
        "level": "HIGH"              # LOW / MEDIUM / HIGH spillover risk into MNQ
      }
    }
"""
import sys
import json
import argparse
from datetime import datetime, timezone

import yfinance as yf

TICKERS = {
    "HSI":   {"symbol": "^HSI",  "name": "Hang Seng (HK)"},
    "N225":  {"symbol": "^N225", "name": "Nikkei 225 (JP)"},
    "KOSPI": {"symbol": "^KS11", "name": "KOSPI (KR)"},
}

MARKET_STALE_MIN = 10  # if the last bar is older than this, treat the market as closed


def fetch_one(key, meta, drop_threshold):
    try:
        t = yf.Ticker(meta["symbol"])
        intraday = t.history(period="1d", interval="1m")
        daily = t.history(period="5d", interval="1d")

        if intraday is None or intraday.empty:
            return {"name": meta["name"], "error": "no intraday data"}
        if daily is None or daily.empty or len(daily) < 2:
            return {"name": meta["name"], "error": "no daily data"}

        last_price   = float(intraday["Close"].iloc[-1])
        session_open = float(intraday["Open"].iloc[0])
        session_high = float(intraday["High"].max())
        session_low  = float(intraday["Low"].min())
        prev_close   = float(daily["Close"].iloc[-2])

        last_ts = intraday.index[-1].to_pydatetime()
        now = datetime.now(last_ts.tzinfo) if last_ts.tzinfo else datetime.now()
        age_min = (now - last_ts).total_seconds() / 60.0
        market_open = age_min <= MARKET_STALE_MIN

        change_from_open       = round((last_price - session_open) / session_open * 100, 2)
        change_from_prev_close = round((last_price - prev_close) / prev_close * 100, 2)
        drop_from_high         = round((last_price - session_high) / session_high * 100, 2)

        return {
            "name": meta["name"],
            "price": round(last_price, 2),
            "asOf": last_ts.isoformat(),
            "marketOpen": market_open,
            "sessionOpen": round(session_open, 2),
            "sessionHigh": round(session_high, 2),
            "sessionLow": round(session_low, 2),
            "prevClose": round(prev_close, 2),
            "changeFromOpenPct": change_from_open,
            "changeFromPrevClosePct": change_from_prev_close,
            "dropFromHighPct": drop_from_high,
            "bigDrop": change_from_prev_close <= drop_threshold or drop_from_high <= drop_threshold,
        }
    except Exception as e:
        return {"name": meta["name"], "error": str(e)}


def compute_impact(results, drop_threshold):
    """Aggregate spillover-risk score across all three indices."""
    red_count = 0
    score = 0.0
    for r in results.values():
        if r.get("error"):
            continue
        worst = min(r.get("changeFromPrevClosePct", 0), r.get("dropFromHighPct", 0))
        if worst < 0:
            score += abs(worst)
        if r.get("bigDrop"):
            red_count += 1

    if red_count >= 2 and score >= 4:
        level = "HIGH"
    elif red_count >= 1 and score >= 1.5:
        level = "MEDIUM"
    else:
        level = "LOW"

    return {"redCount": red_count, "score": round(score, 2), "level": level}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--drop-threshold", type=float, default=-1.0,
                         help="changePct at/below this marks bigDrop=true (default -1.0)")
    args = parser.parse_args()

    out = {}
    for key, meta in TICKERS.items():
        out[key] = fetch_one(key, meta, args.drop_threshold)

    out["_impact"] = compute_impact(out, args.drop_threshold)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
