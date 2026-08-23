"""
Backtests the Asian failed-breakout strategy against already-collected 1m/5m
raw bars (from ml/data_collection/collect_replay.py's output — reused here
purely as a historical OHLCV source, this module has no other dependency on
the ml/ subsystem).

Walks 1m bars in time order. Feeds 5m bars into the LevelTracker only once
they've fully CLOSED relative to the current 1m timestamp (bar `time` is
open time, matching the convention confirmed in src/core/data.js — a 5m bar
closes at time+300s) — same causal-join discipline as the fix applied to
ml/features/build_dataset.py this session, deliberately re-verified here
rather than assumed.

Run as a module from the repo root:
    python -m strategies.asian_failed_breakout.backtest --symbol MGC1! --days 30
"""
import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from .config import StrategyConfig
from .engine import StrategyEngine
from .levels import LevelTracker, _in_window, _parse_hm

RAW_DIR = Path.home() / "data" / "ml-raw"
OUT_DIR = Path.home() / "data" / "afb-backtests"
SYMBOLS_CONFIG = Path(__file__).resolve().parent.parent.parent / "ml" / "config" / "symbols.json"
ET = "America/New_York"


def _load_point_value(symbol: str) -> float:
    all_cfg = json.loads(SYMBOLS_CONFIG.read_text())
    return all_cfg.get(symbol, {}).get("point_value", 1.0)


def _load_bars(symbol: str, timeframe: str) -> pd.DataFrame:
    stem = symbol.replace(":", "_").replace("!", "")
    path = RAW_DIR / f"{stem}_{timeframe}.parquet"
    if not path.exists():
        raise FileNotFoundError(f"No raw data at {path} — run ml/data_collection/collect_replay.py first.")
    return pd.read_parquet(path).sort_values("time").reset_index(drop=True)


def run_backtest(symbol: str, cfg: StrategyConfig, days: int | None = None) -> pd.DataFrame:
    df1 = _load_bars(symbol, "1")
    df5 = _load_bars(symbol, "5")

    if days is not None:
        cutoff = int(df1["time"].max()) - days * 86400
        df1 = df1[df1["time"] >= cutoff].reset_index(drop=True)

    df1["ema9"] = df1["close"].ewm(span=cfg.ma9.ema_period, adjust=False).mean()
    et1 = pd.to_datetime(df1["time"], unit="s", utc=True).dt.tz_convert(ET)
    et5 = pd.to_datetime(df5["time"], unit="s", utc=True).dt.tz_convert(ET)
    tf5_close_offset = 5 * 60

    tracker = LevelTracker(cfg.session, cfg.swing, cfg.asian_range)
    engine = StrategyEngine(cfg, symbol, _load_point_value(symbol))

    asian_start = _parse_hm(cfg.session.asian_session_start)
    asian_end = _parse_hm(cfg.session.asian_session_end)

    j = 0  # pointer into df5
    n5 = len(df5)
    records = []

    for i in range(len(df1)):
        t = int(df1["time"].iloc[i])
        while j < n5 and int(df5["time"].iloc[j]) + tf5_close_offset <= t:
            bar5 = {"time": int(df5["time"].iloc[j]), "open": df5["open"].iloc[j], "high": df5["high"].iloc[j],
                    "low": df5["low"].iloc[j], "close": df5["close"].iloc[j]}
            tracker.update(bar5, et5.iloc[j])
            j += 1

        levels = tracker.get_levels(cfg.levels)
        tod = et1.iloc[i].hour * 60 + et1.iloc[i].minute
        in_asian = _in_window(tod, asian_start, asian_end)

        bar1 = {"time": t, "open": df1["open"].iloc[i], "high": df1["high"].iloc[i],
                "low": df1["low"].iloc[i], "close": df1["close"].iloc[i]}
        recs = engine.on_bar(bar1, float(df1["ema9"].iloc[i]), levels, in_asian)
        records.extend(recs)

    if len(df1):
        last_bar = {"time": int(df1["time"].iloc[-1]), "close": float(df1["close"].iloc[-1])}
        records.extend(engine.force_close_all(last_bar))

    rows = [r.__dict__ for r in records]
    out = pd.DataFrame(rows)
    if not out.empty:
        for col in ("timestamp", "break_timestamp", "reclaim_timestamp", "ema9_trigger_timestamp", "exit_timestamp"):
            if col in out.columns:
                out[col.replace("timestamp", "et")] = pd.to_datetime(out[col], unit="s", utc=True).dt.tz_convert(ET)
        out = out.sort_values("timestamp").reset_index(drop=True)
    return out


def summarize(df: pd.DataFrame) -> dict:
    if df.empty:
        return {"n_setups": 0}
    status_counts = df["setup_status"].value_counts().to_dict()
    reason_counts = df["invalid_reason"].dropna().value_counts().to_dict()
    filled = df[df["setup_status"].isin(["FILLED", "OPEN_AT_BACKTEST_END"])]
    summary = {
        "n_setups_logged": len(df),
        "status_counts": status_counts,
        "rejection_reasons": reason_counts,
        "n_trades_filled": len(filled),
    }
    if len(filled):
        wins = filled[filled["pnl_points"] > 0]
        gross_profit = filled.loc[filled["pnl_dollars"] > 0, "pnl_dollars"].sum()
        gross_loss = -filled.loc[filled["pnl_dollars"] < 0, "pnl_dollars"].sum()
        summary.update({
            "win_rate": float(len(wins) / len(filled)),
            "total_pnl_dollars": float(filled["pnl_dollars"].sum()),
            "avg_r_multiple": float(filled["r_multiple"].mean()),
            "profit_factor": float(gross_profit / gross_loss) if gross_loss > 0 else None,
            "by_direction": filled.groupby("direction")["pnl_dollars"].agg(["count", "sum", "mean"]).to_dict("index"),
        })
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="MGC1!")
    parser.add_argument("--days", type=int, default=None, help="limit to the most recent N days (default: all available)")
    parser.add_argument("--out", help="output CSV path (default: ~/data/afb-backtests/{symbol}_setups.csv)")
    args = parser.parse_args()

    cfg = StrategyConfig()
    df = run_backtest(args.symbol, cfg, args.days)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stem = args.symbol.replace(":", "_").replace("!", "")
    out_path = Path(args.out) if args.out else OUT_DIR / f"{stem}_setups.csv"
    df.to_csv(out_path, index=False)
    print(f"Wrote {len(df)} setup records to {out_path}", file=sys.stderr)

    print(json.dumps(summarize(df), indent=2, default=str))


if __name__ == "__main__":
    main()
