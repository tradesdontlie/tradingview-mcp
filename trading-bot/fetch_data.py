"""Download historical candles from your running MT5 terminal to CSV.

Requires: Windows, MT5 terminal installed and logged in to a (demo) account.

Usage:
    python fetch_data.py --symbol EURUSD --timeframe H1 --start 2023-01-01 --end 2025-01-01
"""
import argparse
from datetime import datetime, timezone
from pathlib import Path

import MetaTrader5 as mt5
import pandas as pd

TIMEFRAMES = {
    "M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30, "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}


def parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--symbol", required=True)
    p.add_argument("--timeframe", default="H1", choices=TIMEFRAMES)
    p.add_argument("--start", required=True)
    p.add_argument("--end", required=True)
    args = p.parse_args()

    if not mt5.initialize():
        raise SystemExit(f"MT5 initialize failed: {mt5.last_error()}")
    try:
        if not mt5.symbol_select(args.symbol, True):
            raise SystemExit(f"Symbol {args.symbol} not available at your broker")

        rates = mt5.copy_rates_range(
            args.symbol, TIMEFRAMES[args.timeframe],
            parse_date(args.start), parse_date(args.end),
        )
        if rates is None or len(rates) == 0:
            raise SystemExit(f"No data returned: {mt5.last_error()}")

        df = pd.DataFrame(rates)
        df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)

        info = mt5.symbol_info(args.symbol)
        print(f"{args.symbol}: point={info.point}, digits={info.digits}, "
              f"current spread={info.spread} points")

        out = Path("data") / f"{args.symbol}_{args.timeframe}.csv"
        out.parent.mkdir(exist_ok=True)
        df.to_csv(out, index=False)
        print(f"Saved {len(df)} candles to {out}")
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
