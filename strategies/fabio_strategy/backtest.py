"""
Backtest runner: loads 1m+5m raw bars, computes VWAP/EMA9/EMA20 (1m) and
VWAP/EMA9/market-state/balance-range (5m), joins the 5m-derived columns
onto 1m bars using the same close-time-aligned causal join fixed earlier
this session in ml/features/build_dataset.py (a 1m bar only ever sees a 5m
bar that had actually closed by that point — never the in-progress one),
feeds the important-location tracker 5m bars incrementally, and walks 1m
bars through FabioEngine.

Segments results by symbol / session / time-of-day / market-state /
direction / setup-type rather than a single combined number, per the
brief's explicit "do not combine all trades into one performance number."

Run as a module from the repo root:
    python -m strategies.fabio_strategy.backtest --symbol MNQ1! --session ny --tier swing
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from ..ny_open_strategies.common import (ET, RAW_DIR, _in_window, load_point_value)
from .config import FabioConfig
from .engine import FabioEngine
from .levels import LocationTracker
from .market_state import compute_market_state

OUT_DIR = Path.home() / "data" / "fabio-backtests"

SESSION_NAMES = ("asia", "london", "ny_premarket", "ny_open", "ny_pm")


def _load_bars(symbol: str, timeframe: str) -> pd.DataFrame:
    stem = symbol.replace(":", "_").replace("!", "")
    path = RAW_DIR / f"{stem}_{timeframe}.parquet"
    if not path.exists():
        raise FileNotFoundError(f"No raw data at {path} — run ml/data_collection/collect_replay.py first.")
    return pd.read_parquet(path).sort_values("time").reset_index(drop=True)


def _add_vwap_ema(df: pd.DataFrame, session_start_hour: int = 18) -> pd.DataFrame:
    session_id = (df["et"] - pd.Timedelta(hours=session_start_hour)).dt.floor("D")
    typical = (df["high"] + df["low"] + df["close"]) / 3
    tp_vol = typical * df["volume"]
    cum_vol = df.groupby(session_id.values)["volume"].cumsum()
    cum_tp_vol = tp_vol.groupby(session_id.values).cumsum()
    vwap = cum_tp_vol / cum_vol.replace(0, np.nan)
    df["vwap"] = vwap
    df["ema9"] = df["close"].ewm(span=9, adjust=False).mean()
    df["ema20"] = df["close"].ewm(span=20, adjust=False).mean()
    return df


def _session_windows(cfg: FabioConfig):
    from .levels import _parse_hm
    s = cfg.sessions
    return {
        "asia": (_parse_hm(s.asia_start), _parse_hm(s.asia_end), 0),
        "london": (_parse_hm(s.london_start), _parse_hm(s.london_end), 0),
        "ny_premarket": (_parse_hm(s.ny_premarket_start), _parse_hm(s.ny_premarket_end), 0),
        "ny_open": (_parse_hm(s.ny_open_start), _parse_hm(s.ny_open_end), s.ny_open_min_delay_minutes),
        "ny_pm": (_parse_hm(s.ny_pm_start), _parse_hm(s.ny_pm_end), 0),
    }


def _session_and_tradeable(tod_min: int, cfg: FabioConfig):
    windows = _session_windows(cfg)
    toggles = cfg.session_toggles
    enabled = {
        "asia": toggles.asia_enabled, "london": toggles.london_enabled,
        "ny_premarket": toggles.ny_premarket_enabled, "ny_open": toggles.ny_open_enabled,
        "ny_pm": toggles.ny_pm_enabled,
    }
    for name, (start, end, delay) in windows.items():
        if not enabled[name]:
            continue
        if _in_window(tod_min, start, end):
            minutes_since_open = (tod_min - start) % 1440
            return name, minutes_since_open >= delay
    return "none", False


SESSION_GROUPS = {
    "asia": {"asia"},
    "ny": {"ny_premarket", "ny_open", "ny_pm"},
}


def run_backtest(symbol: str, cfg: FabioConfig, days: int | None = None,
                  session_filter: set[str] | None = None) -> pd.DataFrame:
    df1 = _load_bars(symbol, "1")
    df5 = _load_bars(symbol, "5")
    if days is not None:
        cutoff = int(df1["time"].max()) - days * 86400
        df1 = df1[df1["time"] >= cutoff].reset_index(drop=True)

    df1["et"] = pd.to_datetime(df1["time"], unit="s", utc=True).dt.tz_convert(ET)
    df1["tod_min"] = df1["et"].dt.hour * 60 + df1["et"].dt.minute
    _add_vwap_ema(df1, cfg.sessions.globex_day_rollover_hour)

    df5["et"] = pd.to_datetime(df5["time"], unit="s", utc=True).dt.tz_convert(ET)
    _add_vwap_ema(df5, cfg.sessions.globex_day_rollover_hour)
    df5 = compute_market_state(df5, cfg)
    n5w = cfg.balance.range_lookback_bars_5m
    df5["balance_range_high"] = df5["high"].rolling(n5w).max()
    df5["balance_range_low"] = df5["low"].rolling(n5w).min()

    tracker = LocationTracker(cfg)
    engine = FabioEngine(cfg, symbol, load_point_value(symbol))

    j, n5 = 0, len(df5)
    tf5_close_offset = 300
    cur_state, cur_bh, cur_bl = "BALANCE", None, None
    records = []

    for i in range(len(df1)):
        t = int(df1["time"].iloc[i])
        while j < n5 and int(df5["time"].iloc[j]) + tf5_close_offset <= t:
            bar5 = {"time": int(df5["time"].iloc[j]), "open": df5["open"].iloc[j], "high": df5["high"].iloc[j],
                    "low": df5["low"].iloc[j], "close": df5["close"].iloc[j]}
            tracker.update(bar5, pd.Timestamp(df5["et"].iloc[j]))
            cur_state = df5["raw_market_state"].iloc[j]
            cur_bh = df5["balance_range_high"].iloc[j]
            cur_bl = df5["balance_range_low"].iloc[j]
            j += 1

        tod = int(df1["tod_min"].iloc[i])
        session, tradeable = _session_and_tradeable(tod, cfg)
        if session_filter and session not in session_filter:
            # still run trade management / in-flight setups even outside the
            # filtered session so open trades resolve correctly — just block
            # new entries via tradeable=False
            tradeable = False

        levels = tracker.get_levels(cfg.important_levels)
        balance_range = {"high": cur_bh, "low": cur_bl} if (cur_bh is not None and not pd.isna(cur_bh)) else None

        bar1 = {"time": t, "open": df1["open"].iloc[i], "high": df1["high"].iloc[i],
                "low": df1["low"].iloc[i], "close": df1["close"].iloc[i]}
        recs = engine.on_bar(bar1, cur_state, float(df1["vwap"].iloc[i]), float(df1["ema9"].iloc[i]),
                              float(df1["ema20"].iloc[i]), levels, balance_range, session, tradeable)
        for r in recs:
            r.session = r.session or session
        records.extend(recs)

    if len(df1):
        last_bar = {"time": int(df1["time"].iloc[-1]), "close": float(df1["close"].iloc[-1])}
        records.extend(engine.force_close_all(last_bar))

    out = pd.DataFrame([r.__dict__ for r in records])
    if not out.empty:
        for col in ("timestamp", "level_broken", "level_reclaimed", "ema9_trigger", "exit_timestamp", "pullback_start"):
            if col in out.columns:
                out[col.replace("timestamp", "et").replace("_broken", "_broken_et")
                    .replace("_reclaimed", "_reclaimed_et").replace("_trigger", "_trigger_et")
                    .replace("_start", "_start_et")] = pd.to_datetime(out[col], unit="s", utc=True).dt.tz_convert(ET)
        out = out.sort_values("timestamp", na_position="first").reset_index(drop=True)
        et_ts = pd.to_datetime(out["timestamp"], unit="s", utc=True).dt.tz_convert(ET)
        out["hour_et"] = et_ts.dt.hour
    return out


def segmented_metrics(df: pd.DataFrame) -> dict:
    """Per the brief: never one combined number. Computes the same metric
    set for every segment along symbol / session / time-of-day (hour) /
    market_state / direction / setup_type independently."""
    if df.empty:
        return {"n_setups": 0}
    filled = df[df["setup_status"].isin(["FILLED", "OPEN_AT_BACKTEST_END"])].copy()

    def metrics_for(sub: pd.DataFrame) -> dict:
        if sub.empty:
            return {"n": 0}
        wins = sub[sub["pnl_points"] > 0]
        losses = sub[sub["pnl_points"] <= 0]
        gross_profit = sub.loc[sub["pnl_dollars"] > 0, "pnl_dollars"].sum()
        gross_loss = -sub.loc[sub["pnl_dollars"] < 0, "pnl_dollars"].sum()
        equity = sub["pnl_dollars"].cumsum()
        running_max = equity.cummax()
        drawdown = (equity - running_max).min() if len(equity) else 0.0
        # max consecutive losses
        is_loss = (sub["pnl_points"] <= 0).astype(int).tolist()
        max_consec, cur = 0, 0
        for v in is_loss:
            cur = cur + 1 if v else 0
            max_consec = max(max_consec, cur)
        return {
            "n": len(sub),
            "win_rate": float(len(wins) / len(sub)),
            "avg_win": float(wins["pnl_dollars"].mean()) if len(wins) else None,
            "avg_loss": float(losses["pnl_dollars"].mean()) if len(losses) else None,
            "profit_factor": float(gross_profit / gross_loss) if gross_loss > 0 else None,
            "expectancy_dollars": float(sub["pnl_dollars"].mean()),
            "avg_r": float(sub["r_multiple"].mean()) if sub["r_multiple"].notna().any() else None,
            "median_r": float(sub["r_multiple"].median()) if sub["r_multiple"].notna().any() else None,
            "max_drawdown_dollars": float(drawdown),
            "max_consecutive_losses": max_consec,
            "avg_mae_points": float(sub["mae_points"].mean()) if "mae_points" in sub and sub["mae_points"].notna().any() else None,
            "avg_mfe_points": float(sub["mfe_points"].mean()) if "mfe_points" in sub and sub["mfe_points"].notna().any() else None,
        }

    result = {"overall": metrics_for(filled)}
    for dim in ("session", "market_state", "direction", "setup_type"):
        if dim in filled.columns:
            result[f"by_{dim}"] = {str(k): metrics_for(g) for k, g in filled.groupby(dim)}
    if "hour_et" in filled.columns:
        result["by_hour_et"] = {str(k): metrics_for(g) for k, g in filled.groupby("hour_et")}

    status_counts = df["setup_status"].value_counts().to_dict()
    reason_counts = df["rejection_reason"].dropna().value_counts().to_dict()
    result["status_counts"] = status_counts
    result["rejection_reasons"] = reason_counts
    return result


# scalp/swing risk caps at RR=2.0, sized to reproduce the point magnitudes
# already established earlier in this conversation's other sweeps (MNQ
# swing ~100pt target, MGC swing ~20pt target) via risk*rr = target.
TIER_MAX_RISK = {
    "MNQ1!": {"scalp": 10.0, "swing": 50.0},
    "MGC1!": {"scalp": 5.0, "swing": 10.0},
}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="MNQ1!")
    parser.add_argument("--days", type=int, default=None)
    parser.add_argument("--session", choices=list(SESSION_NAMES) + list(SESSION_GROUPS) + ["all"], default="all")
    parser.add_argument("--tier", choices=["scalp", "swing"], default=None,
                         help="convenience: sets --max-risk from TIER_MAX_RISK for this symbol")
    parser.add_argument("--max-risk", type=float, default=None)
    parser.add_argument("--rr", type=float, default=2.0)
    args = parser.parse_args()

    cfg = FabioConfig()
    cfg.risk.rr_ratio = args.rr
    if args.tier is not None:
        cfg.risk.max_risk_points = TIER_MAX_RISK.get(args.symbol, TIER_MAX_RISK["MNQ1!"])[args.tier]
    if args.max_risk is not None:
        cfg.risk.max_risk_points = args.max_risk

    if args.session == "all":
        session_filter = None
    elif args.session in SESSION_GROUPS:
        session_filter = SESSION_GROUPS[args.session]
    else:
        session_filter = {args.session}
    df = run_backtest(args.symbol, cfg, args.days, session_filter)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stem = args.symbol.replace(":", "_").replace("!", "")
    out_path = OUT_DIR / f"{stem}_fabio.csv"
    df.to_csv(out_path, index=False)
    print(f"Wrote {len(df)} records to {out_path}", file=sys.stderr)
    print(json.dumps(segmented_metrics(df), indent=2, default=str))


if __name__ == "__main__":
    main()
