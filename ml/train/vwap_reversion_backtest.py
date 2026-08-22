"""
Rule-based backtest (no ML model involved): Asian-hours VWAP mean-reversion.

Rule as specified: during a fixed ET hour window (default 19:00-22:00 —
"Asian hours"), if price is >= 2 session-VWAP standard deviations away from
VWAP, take a reversal trade back toward VWAP. Uses the same session-anchored
VWAP calculation as the rest of this pipeline (ml/features/indicators.py's
add_session_vwap), evaluated directly against raw OHLCV — no trained model.

Exit rule (not specified by the request, so documented explicitly rather than
left implicit): whichever comes first —
  1. "reverted" — price comes back within `--exit-sigma` of VWAP (the stated target)
  2. "stopped" — price extends *further* out to `--stop-sigma` (protects against
     a trend day where 2-sigma keeps extending rather than reverting)
  3. "window_close" — the 19:00-22:00 window ends before either happens

Non-overlapping: only one position open at a time.

Run as a module from the repo root:
    python -m ml.train.vwap_reversion_backtest --symbol MGC1! --days 30
"""
import argparse
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import pandas as pd

from ..data_collection.collect_replay import parquet_path, epoch_to_date_str
from ..features.build_dataset import load_symbol_config
from ..features.indicators import ET, add_session_vwap

TRADE_LOG_DIR = Path.home() / "data" / "ml-backtests"
PLOTS_DIR = Path.home() / "data" / "ml-plots"


def compute_features(symbol: str, days: int) -> pd.DataFrame:
    raw = pd.read_parquet(parquet_path(symbol, "1")).sort_values("time").reset_index(drop=True)
    df = add_session_vwap(raw)
    et = pd.to_datetime(df["time"], unit="s", utc=True).dt.tz_convert(ET)
    df["hour_et"] = et.dt.hour
    df["date_et"] = et.dt.strftime("%Y-%m-%d")
    cutoff = int(df["time"].max()) - days * 86400
    return df[df["time"] >= cutoff].reset_index(drop=True)


def run_backtest(df: pd.DataFrame, start_hour: int, end_hour: int,
                  sigma_trigger: float, exit_sigma: float, stop_sigma: float, point_value: float,
                  fixed_tp_sl: tuple[float, float, int] | None = None) -> pd.DataFrame:
    """fixed_tp_sl, when given, is (tp_points, sl_points, max_hold_bars) — the
    exact same fixed-distance exit the ML models use (ml/config/symbols.json),
    checked against each bar's high/low (not just close, same as
    ml/labels/triple_barrier.py) instead of the sigma-based revert/stop/window
    rule. Only the *entry* trigger (2-sigma-from-VWAP during the Asian window)
    stays the hand-specified rule; this isolates whether the entry idea has
    edge under the same risk/reward the ML models are held to, rather than
    conflating it with a different, untested exit rule."""
    df["in_window"] = (df["hour_et"] >= start_hour) & (df["hour_et"] < end_hour)

    trades = []
    i, n = 0, len(df)
    in_position = False
    entry_idx = entry_price = entry_time = entry_sigma = trade_direction = None

    while i < n:
        row = df.iloc[i]
        if not in_position:
            sigma = row["dist_from_vwap_sigma"]
            if row["in_window"] and pd.notna(sigma):
                if sigma >= sigma_trigger:
                    trade_direction = "short"
                elif sigma <= -sigma_trigger:
                    trade_direction = "long"
                else:
                    trade_direction = None
                if trade_direction:
                    entry_idx, entry_price, entry_time, entry_sigma = i, row["close"], row["time"], sigma
                    in_position = True
            i += 1
            continue

        exit_reason = None
        if fixed_tp_sl:
            tp_points, sl_points, max_hold_bars = fixed_tp_sl
            if trade_direction == "long":
                tp_level, sl_level = entry_price + tp_points, entry_price - sl_points
                hit_tp, hit_sl = row["high"] >= tp_level, row["low"] <= sl_level
            else:
                tp_level, sl_level = entry_price - tp_points, entry_price + sl_points
                hit_tp, hit_sl = row["low"] <= tp_level, row["high"] >= sl_level
            if hit_tp and hit_sl:
                exit_reason = "loss"  # same-bar ambiguity — conservative, matches triple_barrier.py
            elif hit_tp:
                exit_reason = "win"
            elif hit_sl:
                exit_reason = "loss"
            elif i - entry_idx >= max_hold_bars:
                exit_reason = "timeout"
        else:
            sigma = row["dist_from_vwap_sigma"]
            if pd.isna(sigma):
                exit_reason = "data_gap"
            elif trade_direction == "short" and sigma <= exit_sigma:
                exit_reason = "reverted"
            elif trade_direction == "long" and sigma >= -exit_sigma:
                exit_reason = "reverted"
            elif trade_direction == "short" and sigma >= stop_sigma:
                exit_reason = "stopped"
            elif trade_direction == "long" and sigma <= -stop_sigma:
                exit_reason = "stopped"
            elif not row["in_window"]:
                exit_reason = "window_close"

        if exit_reason:
            exit_price = row["close"] if not fixed_tp_sl else (
                entry_price + tp_points if exit_reason == "win" and trade_direction == "long" else
                entry_price - tp_points if exit_reason == "win" else
                entry_price - sl_points if exit_reason == "loss" and trade_direction == "long" else
                entry_price + sl_points if exit_reason == "loss" else
                row["close"]
            )
            points = (entry_price - exit_price) if trade_direction == "short" else (exit_price - entry_price)
            trades.append({
                "entry_time": int(entry_time), "exit_time": int(row["time"]),
                "entry_date": epoch_to_date_str(int(entry_time)),
                "direction": trade_direction, "entry_price": float(entry_price), "exit_price": float(exit_price),
                "entry_sigma": float(entry_sigma), "points": float(points), "dollars": float(points) * point_value,
                "hold_bars": i - entry_idx, "exit_reason": exit_reason,
                "entry_idx": entry_idx, "exit_idx": i,
            })
            in_position = False
        i += 1

    return pd.DataFrame(trades)


def summarize(trades: pd.DataFrame) -> dict:
    if trades.empty:
        return {"n_trades": 0}
    wins = trades[trades["points"] > 0]
    return {
        "n_trades": len(trades),
        "win_rate": float(len(wins) / len(trades)),
        "total_points": float(trades["points"].sum()),
        "total_dollars": float(trades["dollars"].sum()),
        "avg_points_per_trade": float(trades["points"].mean()),
        "avg_hold_bars": float(trades["hold_bars"].mean()),
        "by_exit_reason": trades["exit_reason"].value_counts().to_dict(),
        "by_direction": trades.groupby("direction")["dollars"].agg(["count", "sum", "mean"]).to_dict("index"),
    }


def plot_trade_date(df: pd.DataFrame, trades: pd.DataFrame, date: str, start_hour: int, end_hour: int,
                     sigma_trigger: float, out_path: Path):
    day = df[df["date_et"] == date].reset_index(drop=True)
    if day.empty:
        return
    day_trades = trades[trades["entry_date"] == date]
    times = pd.to_datetime(day["time"], unit="s", utc=True).dt.tz_convert(ET)

    fig, ax = plt.subplots(figsize=(12, 5))
    ax.plot(times, day["close"], color="black", linewidth=0.8, label="price")
    ax.plot(times, day["vwap"], color="#4C78A8", linewidth=1.2, label="session VWAP")
    ax.fill_between(times, day["vwap"] - sigma_trigger * day["vwap_std"], day["vwap"] + sigma_trigger * day["vwap_std"],
                     color="#4C78A8", alpha=0.1, label=f"±{sigma_trigger}σ")

    win_start = times.dt.normalize().iloc[0] + pd.Timedelta(hours=start_hour)
    win_end = times.dt.normalize().iloc[0] + pd.Timedelta(hours=end_hour)
    ax.axvspan(win_start, win_end, color="orange", alpha=0.08, label=f"{start_hour}:00-{end_hour}:00 ET window")

    for _, t in day_trades.iterrows():
        entry_dt = pd.to_datetime(t["entry_time"], unit="s", utc=True).tz_convert(ET)
        exit_dt = pd.to_datetime(t["exit_time"], unit="s", utc=True).tz_convert(ET)
        win = t["points"] > 0
        color = "#2CA02C" if win else "#D62728"
        marker_entry = "v" if t["direction"] == "short" else "^"
        ax.scatter([entry_dt], [t["entry_price"]], marker=marker_entry, color=color, s=100, zorder=5)
        ax.scatter([exit_dt], [t["exit_price"]], marker="x", color=color, s=100, zorder=5)
        ax.plot([entry_dt, exit_dt], [t["entry_price"], t["exit_price"]], "--", color=color, linewidth=1, zorder=4)

    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=ET))
    ax.set_title(f"{date} — VWAP reversion trades ({len(day_trades)} trade(s))")
    ax.legend(loc="upper left", fontsize=8)
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--start-hour", type=int, default=19, help="ET hour, window start (inclusive)")
    parser.add_argument("--end-hour", type=int, default=22, help="ET hour, window end (exclusive)")
    parser.add_argument("--sigma-trigger", type=float, default=2.0)
    parser.add_argument("--exit-sigma", type=float, default=0.2)
    parser.add_argument("--stop-sigma", type=float, default=3.0)
    parser.add_argument("--fixed-tp-sl", action="store_true",
                         help="use the ML model's own tp/sl/horizon from symbols.json instead of the "
                              "sigma-based revert/stop/window-close exit — isolates the entry idea from the exit rule")
    parser.add_argument("--plot-dates", type=int, default=4, help="how many trade dates to plot (most recent first)")
    args = parser.parse_args()

    tf_cfg = load_symbol_config(args.symbol, "1")
    df = compute_features(args.symbol, args.days)
    fixed_tp_sl = (tf_cfg["tp_points"], tf_cfg["sl_points"], tf_cfg["horizon_bars"]) if args.fixed_tp_sl else None
    if fixed_tp_sl:
        print(f"[{args.symbol}] using ML tp/sl/horizon: {tf_cfg['tp_points']}pt / {tf_cfg['sl_points']}pt / "
              f"{tf_cfg['horizon_bars']} bars", file=sys.stderr)
    trades = run_backtest(df, args.start_hour, args.end_hour, args.sigma_trigger,
                           args.exit_sigma, args.stop_sigma, tf_cfg["point_value"], fixed_tp_sl)
    summary = summarize(trades)
    print(json.dumps(summary, indent=2))

    TRADE_LOG_DIR.mkdir(parents=True, exist_ok=True)
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)
    stem = args.symbol.replace(":", "_").replace("!", "")
    suffix = "_fixedtpsl" if args.fixed_tp_sl else ""
    trades.to_csv(TRADE_LOG_DIR / f"{stem}_vwap_reversion{suffix}_trades.csv", index=False)

    if not trades.empty:
        dates = trades["entry_date"].drop_duplicates().sort_values(ascending=False).head(args.plot_dates)
        for date in dates:
            out_path = PLOTS_DIR / f"{stem}_vwap_reversion{suffix}_{date}.png"
            plot_trade_date(df, trades, date, args.start_hour, args.end_hour, args.sigma_trigger, out_path)
            print(out_path, file=sys.stderr)


if __name__ == "__main__":
    main()
