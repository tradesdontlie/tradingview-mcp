"""
Plots the liquidity-sweep strategy's trades over the most recent N days, one
PNG per calendar day (ET) — separate files, not a multi-page PDF, so each
day can be opened/zoomed independently. Each trade's swept level (PDH/PDL or
a confirmed swing point) is drawn as a line ending at the trade's entry time
— it shows what was known BEFORE the trade, not a claim that the level still
matters afterward.

The Asian session's own still-developing range (asian_range_high/low) is
excluded from eligible levels for this symbol/session by default — it's the
current session's own live-extending range, not a genuinely prior reference,
so a "sweep" of it is close to tautological (confirmed empirically earlier
this session: it fires more than PDH/PDL/swing combined). Normal MGC sweeps
are PDH/PDL or prior swing points.

Execution is on 1m bars (that's what's plotted); levels/location come from
5m bars (not plotted directly — only the specific level price(s) that
actually got traded are drawn, via each trade's own important_level_price).

Run as a module from the repo root:
    python -m strategies.asian_failed_breakout.plot_trades --symbol MGC1! --days 7 --tier scalp
"""
import argparse
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import pandas as pd

from .backtest import ET, _load_bars, run_backtest
from .config import StrategyConfig

OUT_DIR = Path.home() / "data" / "afb-backtests" / "plots"

TIERS = {
    "scalp": {"target_points": 10.0, "max_risk_points": 5.0},
    "swing": {"target_points": 20.0, "max_risk_points": 10.0},
}

LEVEL_COLOR = "#1f77b4"


def build_config(tier: str, exclude_asian_range: bool = True) -> StrategyConfig:
    cfg = StrategyConfig()
    cfg.risk.target_mode = "fixed_price"
    cfg.risk.target_price_points = TIERS[tier]["target_points"]
    cfg.risk.max_risk_points = TIERS[tier]["max_risk_points"]
    if exclude_asian_range:
        cfg.levels.asian_range_high = False
        cfg.levels.asian_range_low = False
    return cfg


def plot_day(ax, day_price: pd.DataFrame, day_times: pd.Series, day_trades: pd.DataFrame, date: str):
    ax.plot(day_times, day_price["close"], color="black", linewidth=0.8, zorder=1)

    x_start = day_times.iloc[0]
    for _, t in day_trades.iterrows():
        if pd.isna(t["important_level_price"]):
            continue
        level_price = float(t["important_level_price"])
        entry_dt = pd.to_datetime(t["ema9_trigger_timestamp"], unit="s", utc=True).tz_convert(ET)
        # line runs from the start of the day through to this trade's entry
        # — the level was only known up to that point, not a claim it still
        # holds afterward.
        ax.plot([x_start, entry_dt], [level_price, level_price], color=LEVEL_COLOR, linewidth=1.0,
                linestyle=":", zorder=2, alpha=0.8)
        ax.annotate(f"{t['important_level_type']} {level_price:.2f}", (entry_dt, level_price),
                    fontsize=7, color=LEVEL_COLOR, xytext=(-4, 4), textcoords="offset points", ha="right")

    for _, t in day_trades.iterrows():
        # ema9_trigger_timestamp is the actual entry bar (matches entry_price)
        entry_dt = pd.to_datetime(t["ema9_trigger_timestamp"], unit="s", utc=True).tz_convert(ET)
        exit_dt = pd.to_datetime(t["exit_timestamp"], unit="s", utc=True).tz_convert(ET)
        win = t["pnl_points"] > 0
        color = "#2CA02C" if win else "#D62728"
        marker_entry = "^" if t["direction"] == "long" else "v"
        ax.scatter([entry_dt], [t["entry_price"]], marker=marker_entry, color=color, s=120, zorder=5,
                   edgecolors="black", linewidths=0.6)
        ax.scatter([exit_dt], [t["exit_price"]], marker="x", color=color, s=100, zorder=5)
        ax.plot([entry_dt, exit_dt], [t["entry_price"], t["exit_price"]], "--", color=color, linewidth=1.1,
                zorder=4, alpha=0.85)
        ax.annotate(f"{t['pnl_points']:+.1f}pt", (exit_dt, t["exit_price"]), fontsize=7, color=color,
                    xytext=(4, 4), textcoords="offset points")

    n_long = (day_trades["direction"] == "long").sum()
    n_short = (day_trades["direction"] == "short").sum()
    n_win = (day_trades["pnl_points"] > 0).sum()
    n_loss = (day_trades["pnl_points"] <= 0).sum()
    day_pnl = day_trades["pnl_dollars"].sum()

    legend_elems = [
        plt.Line2D([0], [0], marker="^", color="w", markerfacecolor="gray", markeredgecolor="black", markersize=9, label="long entry"),
        plt.Line2D([0], [0], marker="v", color="w", markerfacecolor="gray", markeredgecolor="black", markersize=9, label="short entry"),
        plt.Line2D([0], [0], marker="x", color="gray", markersize=8, label="exit", linestyle="None"),
        plt.Line2D([0], [0], color="#2CA02C", linewidth=2, label="win"),
        plt.Line2D([0], [0], color="#D62728", linewidth=2, label="loss"),
        plt.Line2D([0], [0], color=LEVEL_COLOR, linewidth=1.2, linestyle=":", label="swept level"),
    ]
    ax.legend(handles=legend_elems, loc="upper left", fontsize=8)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=ET))
    ax.set_title(f"{date} — {len(day_trades)} trades ({n_long}L/{n_short}S, {n_win}W/{n_loss}L, PNL ${day_pnl:+.0f})")
    ax.set_ylabel("price")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="MGC1!")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--tier", choices=list(TIERS), default="scalp")
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
