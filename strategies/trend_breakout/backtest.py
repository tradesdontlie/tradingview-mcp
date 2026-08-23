"""
Backtest runner: loads 1m bars, computes EMA9 and ATR(14) locally, tracks
PDH/PDL plus each target window's own opening range, and walks 1m bars
through TrendBreakoutEngine. New candidates may only start inside one of the
three configured session windows (Asian open, London/NY pre-market handoff,
NY open) — an already-open trade keeps trailing regardless of the window.

Run as a module from the repo root:
    python -m strategies.trend_breakout.backtest --symbol MGC1! --days 30
    python -m strategies.trend_breakout.backtest --symbol MNQ1! --days 30 --window ny_open
"""
import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from ..asian_failed_breakout.levels import _in_window, _parse_hm
from ..ny_open_strategies.common import ET, RAW_DIR, load_point_value
from .config import TrendBreakoutConfig
from .engine import TrendBreakoutEngine
from .levels import PDHPDLTracker, WindowOpeningRangeTracker

OUT_DIR = Path.home() / "data" / "trend-breakout-backtests"

WINDOW_NAMES = ("asian_open", "premarket_handoff", "ny_open")


def _load_bars(symbol: str) -> pd.DataFrame:
    stem = symbol.replace(":", "_").replace("!", "")
    path = RAW_DIR / f"{stem}_1.parquet"
    if not path.exists():
        raise FileNotFoundError(f"No raw 1m data at {path} — run ml/data_collection/collect_replay.py first.")
    return pd.read_parquet(path).sort_values("time").reset_index(drop=True)


def _add_ema_atr(df: pd.DataFrame, atr_period: int) -> pd.DataFrame:
    df["ema9"] = df["close"].ewm(span=9, adjust=False).mean()
    prev_close = df["close"].shift(1)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev_close).abs(),
        (df["low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    df[f"atr_{atr_period}"] = tr.ewm(alpha=1 / atr_period, min_periods=atr_period, adjust=False).mean()
    return df


def _window_specs(cfg: TrendBreakoutConfig):
    s = cfg.sessions
    return {
        "asian_open": (s.asian_open_start, s.asian_open_end, cfg.session_toggles.asian_open_enabled),
        "premarket_handoff": (s.premarket_handoff_start, s.premarket_handoff_end, cfg.session_toggles.premarket_handoff_enabled),
        "ny_open": (s.ny_open_start, s.ny_open_end, cfg.session_toggles.ny_open_enabled),
    }


def run_backtest(symbol: str, cfg: TrendBreakoutConfig, days: int | None = None,
                  window_filter: str | None = None) -> pd.DataFrame:
    df = _load_bars(symbol)
    if days is not None:
        cutoff = int(df["time"].max()) - days * 86400
        df = df[df["time"] >= cutoff].reset_index(drop=True)

    df["et"] = pd.to_datetime(df["time"], unit="s", utc=True).dt.tz_convert(ET)
    df["tod_min"] = df["et"].dt.hour * 60 + df["et"].dt.minute
    _add_ema_atr(df, cfg.trailing.atr_period)

    rollover = cfg.sessions.globex_day_rollover_hour
    pdh_pdl = PDHPDLTracker(rollover)
    window_trackers = {
        name: WindowOpeningRangeTracker(start, end, cfg.sessions.opening_range_minutes, rollover)
        for name, (start, end, enabled) in _window_specs(cfg).items() if enabled
    }
    window_bounds = {name: (_parse_hm(start), _parse_hm(end)) for name, (start, end, enabled) in _window_specs(cfg).items()}

    engine = TrendBreakoutEngine(cfg, symbol, load_point_value(symbol))

    records = []
    n = len(df)
    for i in range(n):
        bar = {"time": int(df["time"].iloc[i]), "open": df["open"].iloc[i], "high": df["high"].iloc[i],
               "low": df["low"].iloc[i], "close": df["close"].iloc[i]}
        et_ts = df["et"].iloc[i]
        pdh_pdl.update(bar, et_ts)
        for tracker in window_trackers.values():
            tracker.update(bar, et_ts)

        tod = int(df["tod_min"].iloc[i])
        active_window = None
        for name in WINDOW_NAMES:
            if name not in window_trackers:
                continue
            start_min, end_min = window_bounds[name]
            if _in_window(tod, start_min, end_min):
                active_window = name
                break
        session_label = active_window or "none"
        tradeable = active_window is not None and (window_filter is None or active_window == window_filter)

        levels = {"pdh": pdh_pdl.pdh, "pdl": pdh_pdl.pdl}
        if active_window is not None:
            wt = window_trackers[active_window]
            if wt.high is not None:
                levels["opening_range_high"] = wt.high
                levels["opening_range_low"] = wt.low
        levels = {k: v for k, v in levels.items() if v is not None and not (isinstance(v, float) and pd.isna(v))}

        atr_val = df[f"atr_{cfg.trailing.atr_period}"].iloc[i]
        atr_val = float(atr_val) if pd.notna(atr_val) else None

        recs = engine.on_bar(bar, float(df["ema9"].iloc[i]), atr_val, levels, session_label, tradeable)
        records.extend(recs)

    if n:
        last_bar = {"time": int(df["time"].iloc[-1]), "close": float(df["close"].iloc[-1])}
        records.extend(engine.force_close_all(last_bar))

    out = pd.DataFrame([r.__dict__ for r in records])
    if not out.empty:
        for col in ("timestamp", "break_timestamp", "entry_timestamp", "exit_timestamp"):
            if col in out.columns:
                out[col.replace("timestamp", "et")] = pd.to_datetime(out[col], unit="s", utc=True).dt.tz_convert(ET)
        out = out.sort_values("timestamp", na_position="first").reset_index(drop=True)
    return out


def summarize(df: pd.DataFrame) -> dict:
    if df.empty:
        return {"n_setups": 0}
    status_counts = df["setup_status"].value_counts().to_dict()
    reason_counts = df["rejection_reason"].dropna().value_counts().to_dict()
    filled = df[df["setup_status"].isin(["FILLED", "OPEN_AT_BACKTEST_END"])]
    summary = {"n_setups_logged": len(df), "status_counts": status_counts, "rejection_reasons": reason_counts,
               "n_trades_filled": len(filled)}
    if len(filled):
        wins = filled[filled["pnl_points"] > 0]
        gross_profit = filled.loc[filled["pnl_dollars"] > 0, "pnl_dollars"].sum()
        gross_loss = -filled.loc[filled["pnl_dollars"] < 0, "pnl_dollars"].sum()
        summary.update({
            "win_rate": float(len(wins) / len(filled)),
            "total_pnl_dollars": float(filled["pnl_dollars"].sum()),
            "avg_r_multiple": float(filled["r_multiple"].mean()) if filled["r_multiple"].notna().any() else None,
            "median_r_multiple": float(filled["r_multiple"].median()) if filled["r_multiple"].notna().any() else None,
            "profit_factor": float(gross_profit / gross_loss) if gross_loss > 0 else None,
            "avg_bars_held": float(filled["bars_held"].mean()) if filled["bars_held"].notna().any() else None,
            "by_direction": filled.groupby("direction")["pnl_dollars"].agg(["count", "sum", "mean"]).to_dict("index"),
            "by_session": filled.groupby("session")["pnl_dollars"].agg(["count", "sum", "mean"]).to_dict("index"),
        })
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="MGC1!")
    parser.add_argument("--days", type=int, default=None)
    parser.add_argument("--window", choices=list(WINDOW_NAMES), default=None, help="restrict to one window only")
    parser.add_argument("--max-risk", type=float, default=None)
    args = parser.parse_args()

    cfg = TrendBreakoutConfig()
    if args.max_risk is not None:
        cfg.risk.max_risk_points = args.max_risk

    df = run_backtest(args.symbol, cfg, args.days, args.window)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stem = args.symbol.replace(":", "_").replace("!", "")
    out_path = OUT_DIR / f"{stem}_trend_breakout.csv"
    df.to_csv(out_path, index=False)
    print(f"Wrote {len(df)} records to {out_path}", file=sys.stderr)
    print(json.dumps(summarize(df), indent=2, default=str))


if __name__ == "__main__":
    main()
