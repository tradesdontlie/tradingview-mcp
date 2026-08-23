"""
Offline backtest: scores the trained long/short models bar-by-bar over the
most recent N days and simulates taking a trade whenever a model's
probability clears a threshold, using the same triple-barrier resolution
(label_long/label_short, already computed by build_dataset.py) to score each
simulated trade's outcome — no need to drive TradingView Desktop at all,
since the raw bars + labels already capture "did TP or SL actually resolve
first" for every row.

This is *not* a live-execution backtest against a broker or even TradingView's
own paper-trading replay — it's a direct read of "if the model's signal had
fired here, would the pre-computed triple-barrier outcome have been a win or
a loss." Deliberately simple and fast, and immune to all the chart-driving
fragility (contamination, stalls, pane focus) that historical-data collection
has been fighting all session.

Position handling: non-overlapping — once a trade is "open" (per
bars_to_resolve_{long,short}, or the full horizon on a timeout), no new
signal is taken until it resolves. This is a real strategy constraint, not
just a simplification: taking a fresh signal every bar while a position is
still open isn't a coherent trading rule.

Run as a module from the repo root:
    python -m ml.train.backtest --symbol MNQ1! --timeframe 1 --days 7
    python -m ml.train.backtest --symbol MGC1! --timeframe 1 --days 7 --threshold 0.6
"""
import argparse
import json
import sys
from pathlib import Path

import lightgbm as lgb
import matplotlib
matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from ..data_collection.collect_replay import epoch_to_date_str
from ..features.build_dataset import load_symbol_config
from ..features.indicators import ET
from .train_model import MODELS_DIR, PROCESSED_DIR, load_dataset, time_split

TRADE_LOG_DIR = Path.home() / "data" / "ml-backtests"
PLOTS_DIR = Path.home() / "data" / "ml-plots"


def load_model(symbol: str, timeframe: str, direction: str):
    stem = f"{symbol.replace(':', '_').replace('!', '')}_{timeframe}_{direction}"
    model_path = MODELS_DIR / f"{stem}.txt"
    meta_path = MODELS_DIR / f"{stem}.meta.json"
    if not model_path.exists():
        raise FileNotFoundError(f"No model at {model_path} — run train_model.py first.")
    return lgb.Booster(model_file=str(model_path)), json.loads(meta_path.read_text())


def held_out_start(df: pd.DataFrame, meta_long: dict, meta_short: dict) -> int:
    """The earliest timestamp neither model's train/val split ever saw.
    Confirmed the hard way that skipping this check makes "backtest" numbers
    meaningless: with only a few days of data on hand, "the last N days"
    overlapped almost entirely with what the model was *trained* on, so a
    raised probability threshold just showed better and better fit to data
    it already memorized (win rate climbing to 88%+) rather than any real
    out-of-sample edge. Uses each model's own stored test_frac against the
    same dropna+time_split it was actually trained with, and takes the later
    (more conservative) of the two directions' boundaries."""
    boundaries = []
    for direction, meta in (("long", meta_long), ("short", meta_short)):
        labeled = df.dropna(subset=[f"label_{direction}"]).reset_index(drop=True)
        _, test = time_split(labeled, meta["test_frac"])
        if len(test):
            boundaries.append(int(test["time"].min()))
    return max(boundaries) if boundaries else int(df["time"].max())


def run_backtest(symbol: str, timeframe: str, days: int, threshold: float, min_edge: float) -> pd.DataFrame:
    full_df = load_dataset(symbol, timeframe)
    model_long, meta_long = load_model(symbol, timeframe, "long")
    model_short, meta_short = load_model(symbol, timeframe, "short")
    feat_long, feat_short = meta_long["feature_columns"], meta_short["feature_columns"]

    safe_start = held_out_start(full_df, meta_long, meta_short)
    requested_cutoff = int(full_df["time"].max()) - days * 86400
    cutoff = max(requested_cutoff, safe_start)
    if cutoff > requested_cutoff:
        print(f"[{symbol} {timeframe}] requested {days}-day window starts before the model's held-out "
              f"test period ({epoch_to_date_str(safe_start)}) — clipping to that boundary so this measures "
              f"out-of-sample performance, not training-set fit.", file=sys.stderr)

    df = full_df[full_df["time"] >= cutoff].reset_index(drop=True)
    print(f"[{symbol} {timeframe}] backtest window: {len(df)} bars, {epoch_to_date_str(cutoff)} onward", file=sys.stderr)

    missing_long = [c for c in feat_long if c not in df.columns]
    missing_short = [c for c in feat_short if c not in df.columns]
    if missing_long or missing_short:
        raise ValueError(f"Backtest window missing feature columns (context timeframe data too short for "
                          f"this window?): long={missing_long} short={missing_short}")

    prob_long = model_long.predict(df[feat_long], num_iteration=meta_long.get("best_iteration"))
    prob_short = model_short.predict(df[feat_short], num_iteration=meta_short.get("best_iteration"))

    tf_cfg = load_symbol_config(symbol, timeframe)
    tp_points, sl_points, point_value = tf_cfg["tp_points"], tf_cfg["sl_points"], tf_cfg["point_value"]

    trades = []
    i = 0
    n = len(df)
    while i < n:
        pl, ps = prob_long[i], prob_short[i]
        take_long = pl >= threshold and pl - ps >= min_edge
        take_short = ps >= threshold and ps - pl >= min_edge
        if not (take_long or take_short):
            i += 1
            continue

        direction = "long" if take_long else "short"
        label_col = f"label_{direction}"
        bars_col = f"bars_to_resolve_{direction}"
        label = df[label_col].iloc[i]
        bars_to_resolve = df[bars_col].iloc[i]
        prob_used = pl if take_long else ps

        entry_price = float(df["close"].iloc[i])
        if pd.isna(label):
            outcome = "timeout"
            points = 0.0
            hold_bars = tf_cfg["horizon_bars"]
        elif label == 1.0:
            outcome = "win"
            points = tp_points
            hold_bars = int(bars_to_resolve)
        else:
            outcome = "loss"
            points = -sl_points
            hold_bars = int(bars_to_resolve)

        exit_idx = min(i + hold_bars, n - 1)
        if outcome == "win":
            exit_price = entry_price + tp_points if direction == "long" else entry_price - tp_points
        elif outcome == "loss":
            exit_price = entry_price - sl_points if direction == "long" else entry_price + sl_points
        else:
            exit_price = float(df["close"].iloc[exit_idx])

        trades.append({
            "entry_time": int(df["time"].iloc[i]),
            "exit_time": int(df["time"].iloc[exit_idx]),
            "direction": direction,
            "prob": float(prob_used),
            "entry_price": entry_price,
            "exit_price": exit_price,
            "outcome": outcome,
            "points": points,
            "dollars": points * point_value,
            "hold_bars": hold_bars,
        })
        i += max(hold_bars, 1)  # non-overlapping: skip past this trade's resolution

    return pd.DataFrame(trades)


def summarize(trades: pd.DataFrame) -> dict:
    if trades.empty:
        return {"n_trades": 0}
    resolved = trades[trades["outcome"] != "timeout"]
    wins = resolved[resolved["outcome"] == "win"]
    gross_profit = trades.loc[trades["dollars"] > 0, "dollars"].sum()
    gross_loss = -trades.loc[trades["dollars"] < 0, "dollars"].sum()  # positive number
    return {
        "n_trades": len(trades),
        "n_resolved": len(resolved),
        "n_timeout": len(trades) - len(resolved),
        "win_rate": float(len(wins) / len(resolved)) if len(resolved) else None,
        "total_points": float(trades["points"].sum()),
        "total_dollars": float(trades["dollars"].sum()),
        "avg_points_per_trade": float(trades["points"].mean()),
        # gross profit / gross loss — how many dollars of winners for every dollar
        # of losers, independent of trade count or win rate. >1 means profitable;
        # infinite (no losses at all) reported as null rather than a fake number.
        "profit_factor": float(gross_profit / gross_loss) if gross_loss > 0 else None,
        "gross_profit": float(gross_profit),
        "gross_loss": float(gross_loss),
        "by_direction": trades.groupby("direction")["points"].agg(["count", "sum", "mean"]).to_dict("index"),
    }


def plot_trade_date(price_df: pd.DataFrame, trades: pd.DataFrame, date: str, symbol: str, timeframe: str, out_path: Path):
    """Both long and short entries/exits for one calendar day (ET) on a single
    price chart — green markers for wins, red for losses, triangle-up for long
    entries, triangle-down for short entries, X for exits."""
    et = pd.to_datetime(price_df["time"], unit="s", utc=True).dt.tz_convert(ET)
    day_mask = et.dt.strftime("%Y-%m-%d") == date
    day = price_df[day_mask]
    day_times = et[day_mask]
    if day.empty:
        raise ValueError(f"No price data for {date}")

    day_trades = trades[trades["entry_time"].apply(lambda t: epoch_to_date_str(int(t))) == date]

    fig, ax = plt.subplots(figsize=(13, 5.5))
    ax.plot(day_times, day["close"], color="black", linewidth=0.7, label="price", zorder=1)

    for _, t in day_trades.iterrows():
        entry_dt = pd.to_datetime(t["entry_time"], unit="s", utc=True).tz_convert(ET)
        exit_dt = pd.to_datetime(t["exit_time"], unit="s", utc=True).tz_convert(ET)
        win = t["outcome"] == "win"
        color = "#2CA02C" if win else ("#D62728" if t["outcome"] == "loss" else "#999999")
        marker_entry = "^" if t["direction"] == "long" else "v"
        ax.scatter([entry_dt], [t["entry_price"]], marker=marker_entry, color=color, s=90, zorder=5,
                   edgecolors="black", linewidths=0.5)
        ax.scatter([exit_dt], [t["exit_price"]], marker="x", color=color, s=80, zorder=5)
        ax.plot([entry_dt, exit_dt], [t["entry_price"], t["exit_price"]], "--", color=color, linewidth=0.9, zorder=4, alpha=0.8)

    n_long = (day_trades["direction"] == "long").sum()
    n_short = (day_trades["direction"] == "short").sum()
    n_win = (day_trades["outcome"] == "win").sum()
    n_loss = (day_trades["outcome"] == "loss").sum()
    day_pnl = day_trades["dollars"].sum()

    legend_elems = [
        plt.Line2D([0], [0], marker="^", color="w", markerfacecolor="gray", markeredgecolor="black", markersize=9, label="long entry"),
        plt.Line2D([0], [0], marker="v", color="w", markerfacecolor="gray", markeredgecolor="black", markersize=9, label="short entry"),
        plt.Line2D([0], [0], marker="x", color="gray", markersize=8, label="exit", linestyle="None"),
        plt.Line2D([0], [0], color="#2CA02C", linewidth=2, label="win"),
        plt.Line2D([0], [0], color="#D62728", linewidth=2, label="loss"),
    ]
    ax.legend(handles=legend_elems, loc="upper left", fontsize=8)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=ET))
    ax.set_title(f"{symbol} {timeframe} — {date} — {len(day_trades)} trades ({n_long} long / {n_short} short, "
                 f"{n_win}W/{n_loss}L, PNL ${day_pnl:+.0f})")
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--timeframe", required=True)
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--threshold", type=float, default=0.55, help="minimum probability to take a trade")
    parser.add_argument("--min-edge", type=float, default=0.05, help="minimum prob_long - prob_short gap (or vice versa) to pick a direction")
    parser.add_argument("--plot-date", help="YYYY-MM-DD (ET) — plot that day's long+short entries/exits on one chart")
    args = parser.parse_args()

    trades = run_backtest(args.symbol, args.timeframe, args.days, args.threshold, args.min_edge)
    summary = summarize(trades)
    print(json.dumps(summary, indent=2))

    TRADE_LOG_DIR.mkdir(parents=True, exist_ok=True)
    stem = f"{args.symbol.replace(':', '_').replace('!', '')}_{args.timeframe}"
    out_path = TRADE_LOG_DIR / f"{stem}_backtest_trades.csv"
    trades.to_csv(out_path, index=False)
    print(f"\nTrade log: {out_path}", file=sys.stderr)

    if args.plot_date and not trades.empty:
        full_df = load_dataset(args.symbol, args.timeframe)
        PLOTS_DIR.mkdir(parents=True, exist_ok=True)
        plot_path = PLOTS_DIR / f"{stem}_backtest_{args.plot_date}.png"
        plot_trade_date(full_df, trades, args.plot_date, args.symbol, args.timeframe, plot_path)
        print(f"Plot: {plot_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
