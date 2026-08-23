"""
Same day-by-day trade plotting as strategies/asian_failed_breakout/plot_trades.py,
for the NY-session liquidity-sweep-reversal engine (MNQ1!'s best condition:
NY hours, swing-sized target). Reuses that module's plot_day (engine-agnostic
— it just reads the shared SetupLogRecord column names) rather than
duplicating the plotting code.

Unlike the Asian engine, the NY engine's asian_range_high/low level refers to
the *completed* overnight Asian range (not a still-developing one — Asian
session has already ended by the time NY hours start), so it's kept as an
eligible level here; only the Asian engine's own still-developing range gets
excluded.

Run as a module from the repo root:
    python -m strategies.ny_open_strategies.plot_trades --symbol MNQ1! --days 7 --tier swing
"""
import argparse
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import pandas as pd

from ..asian_failed_breakout.config import StrategyConfig
from ..asian_failed_breakout.plot_trades import LEVEL_COLOR, plot_day
from .common import RAW_DIR, ET
from .liquidity_sweep_reversal import run_backtest

OUT_DIR = Path.home() / "data" / "ny-strategy-backtests" / "plots"

TIERS = {
    "scalp": {"target_points": 30.0, "max_risk_points": 10.0},
    "swing": {"target_points": 100.0, "max_risk_points": 30.0},
}


def build_config(tier: str) -> StrategyConfig:
    cfg = StrategyConfig()
    cfg.risk.target_mode = "fixed_price"
    cfg.risk.target_price_points = TIERS[tier]["target_points"]
    cfg.risk.max_risk_points = TIERS[tier]["max_risk_points"]
    return cfg


def _load_bars(symbol: str, timeframe: str) -> pd.DataFrame:
    stem = symbol.replace(":", "_").replace("!", "")
    path = RAW_DIR / f"{stem}_{timeframe}.parquet"
    return pd.read_parquet(path).sort_values("time").reset_index(drop=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="MNQ1!")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--tier", choices=list(TIERS), default="swing")
    parser.add_argument("--include-empty-days", action="store_true", help="also plot days with zero trades")
    parser.add_argument("--out-dir", help="output directory for the PNGs")
    args = parser.parse_args()

    cfg = build_config(args.tier)
    trades_df = run_backtest(args.symbol, cfg, days=args.days)
    filled = trades_df[trades_df["setup_status"].isin(["FILLED", "OPEN_AT_BACKTEST_END"])].copy()

    price_df = _load_bars(args.symbol, "1")
    cutoff = int(price_df["time"].max()) - args.days * 86400
    price_df = price_df[price_df["time"] >= cutoff].reset_index(drop=True)
    price_et = pd.to_datetime(price_df["time"], unit="s", utc=True).dt.tz_convert(ET)
    price_df["date"] = price_et.dt.strftime("%Y-%m-%d")

    filled["entry_date"] = pd.to_datetime(filled["ema9_trigger_timestamp"], unit="s", utc=True).dt.tz_convert(ET).dt.strftime("%Y-%m-%d")

    dates = sorted(price_df["date"].unique())
    out_dir = Path(args.out_dir) if args.out_dir else OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.symbol.replace(":", "_").replace("!", "")

    written = []
    for date in dates:
        day_trades = filled[filled["entry_date"] == date]
        if day_trades.empty and not args.include_empty_days:
            continue

        day_mask = price_df["date"] == date
        day_price = price_df[day_mask]
        day_times = price_et[day_mask]

        fig, ax = plt.subplots(figsize=(14, 7))
        if day_trades.empty:
            ax.plot(day_times, day_price["close"], color="black", linewidth=0.8)
            ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=ET))
            ax.set_title(f"{date} — 0 trades")
            ax.set_ylabel("price")
        else:
            plot_day(ax, day_price, day_times, day_trades, date)
        fig.tight_layout()

        out_path = out_dir / f"{stem}_{args.tier}_{date}.png"
        fig.savefig(out_path, dpi=130)
        plt.close(fig)
        written.append(out_path)

    print(f"Wrote {len(written)} PNGs ({len(filled)} total trades) to {out_dir}")
    for p in written:
        print(p)


if __name__ == "__main__":
    main()
