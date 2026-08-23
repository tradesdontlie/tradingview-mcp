"""
Exports 1m OHLCV bars + a chosen strategy's trade/level events to JSON, for
the strategy-visualization page served by ml/serve/server.js
(ml/serve/public/strategy.html).

Data source right now is the already-collected REPLAY data
(~/data/ml-raw/{symbol}_1.parquet, from ml/data_collection/collect_replay.py)
— per the explicit instruction this was built under, this is a stand-in
until the market is open and a live polling source replaces it. That swap
point is isolated to _load_bars() below; nothing else needs to change when
it happens (the frontend just consumes whatever bars.json currently holds).

Run as a module from the repo root:
    python -m ml.serve.export_strategy_viz --symbol MGC1! --strategy trend_breakout
    python -m ml.serve.export_strategy_viz --symbol MGC1! --strategy liquidity_sweep_asian
    python -m ml.serve.export_strategy_viz --symbol MNQ1! --strategy liquidity_sweep_ny
"""
import argparse
import json
import sys
from pathlib import Path

import pandas as pd

PUBLIC_DATA_DIR = Path(__file__).resolve().parent / "public" / "data"
RAW_DIR = Path.home() / "data" / "ml-raw"


def _load_bars(symbol: str, days: int | None) -> pd.DataFrame:
    """Swap point for a live data source later: replace this function's body
    with a poll of `tv ohlcv` (see ml/serve/predict.py's fetch_bars_df for
    the existing pattern) once the market is open — the rest of this script
    and the frontend don't need to know the difference."""
    stem = symbol.replace(":", "_").replace("!", "")
    path = RAW_DIR / f"{stem}_1.parquet"
    if not path.exists():
        raise FileNotFoundError(f"No raw 1m data at {path} — run ml/data_collection/collect_replay.py first.")
    df = pd.read_parquet(path).sort_values("time").reset_index(drop=True)
    if days is not None:
        cutoff = int(df["time"].max()) - days * 86400
        df = df[df["time"] >= cutoff].reset_index(drop=True)
    return df


def _bars_to_json(df: pd.DataFrame) -> list[dict]:
    return [
        {"time": int(t), "open": float(o), "high": float(h), "low": float(l), "close": float(c)}
        for t, o, h, l, c in zip(df["time"], df["open"], df["high"], df["low"], df["close"])
    ]


def _trend_breakout_events(symbol: str, days: int | None) -> dict:
    # Absolute import: strategies/ is a sibling top-level (namespace) package
    # to ml/, not a subpackage of it — relative imports can't reach across
    # that boundary, and this script is always run as `python -m
    # ml.serve.export_strategy_viz` from the repo root, so the repo root is
    # already on sys.path and the absolute form just works.
    from strategies.trend_breakout import backtest as tb
    cfg = tb.TrendBreakoutConfig()
    cfg.session_toggles.premarket_handoff_enabled = (symbol != "MGC1!")  # the one window that doesn't work for MGC
    df = tb.run_backtest(symbol, cfg, days=days)
    filled = df[df["setup_status"].isin(["FILLED", "OPEN_AT_BACKTEST_END"])].copy()

    trades = []
    levels = []
    for _, t in filled.iterrows():
        trades.append({
            "direction": t["direction"],
            "entry_time": int(t["entry_timestamp"]) if pd.notna(t["entry_timestamp"]) else None,
            "entry_price": float(t["entry_price"]) if pd.notna(t["entry_price"]) else None,
            "exit_time": int(t["exit_timestamp"]) if pd.notna(t["exit_timestamp"]) else None,
            "exit_price": float(t["exit_price"]) if pd.notna(t["exit_price"]) else None,
            "pnl_points": float(t["pnl_points"]) if pd.notna(t["pnl_points"]) else None,
            "r_multiple": float(t["r_multiple"]) if pd.notna(t["r_multiple"]) else None,
            "status": t["setup_status"],
        })
        if pd.notna(t.get("level_price")) and pd.notna(t.get("timestamp")) and pd.notna(t.get("entry_timestamp")):
            levels.append({
                "type": t["level_type"], "price": float(t["level_price"]),
                "start_time": int(t["timestamp"]), "end_time": int(t["entry_timestamp"]),
            })
    return {"strategy": "trend_breakout", "trades": trades, "levels": levels}


def _liquidity_sweep_events(symbol: str, days: int | None, session: str) -> dict:
    from strategies.asian_failed_breakout import backtest as afb
    from strategies.asian_failed_breakout import config as asian_config
    from strategies.ny_open_strategies import liquidity_sweep_reversal as ny

    cfg = asian_config.StrategyConfig()
    if session == "asian":
        df = afb.run_backtest(symbol, cfg, days=days)
    else:
        df = ny.run_backtest(symbol, cfg, days=days)
    filled = df[df["setup_status"].isin(["FILLED", "OPEN_AT_BACKTEST_END"])].copy()

    trades = []
    levels = []
    for _, t in filled.iterrows():
        trades.append({
            "direction": t["direction"],
            "entry_time": int(t["ema9_trigger_timestamp"]) if pd.notna(t["ema9_trigger_timestamp"]) else None,
            "entry_price": float(t["entry_price"]) if pd.notna(t["entry_price"]) else None,
            "exit_time": int(t["exit_timestamp"]) if pd.notna(t["exit_timestamp"]) else None,
            "exit_price": float(t["exit_price"]) if pd.notna(t["exit_price"]) else None,
            "pnl_points": float(t["pnl_points"]) if pd.notna(t["pnl_points"]) else None,
            "r_multiple": float(t["r_multiple"]) if pd.notna(t["r_multiple"]) else None,
            "status": t["setup_status"],
        })
        if pd.notna(t.get("important_level_price")) and pd.notna(t.get("timestamp")) and pd.notna(t.get("ema9_trigger_timestamp")):
            levels.append({
                "type": t["important_level_type"], "price": float(t["important_level_price"]),
                "start_time": int(t["timestamp"]), "end_time": int(t["ema9_trigger_timestamp"]),
            })
    return {"strategy": f"liquidity_sweep_{session}", "trades": trades, "levels": levels}


STRATEGIES = {
    "trend_breakout": lambda symbol, days: _trend_breakout_events(symbol, days),
    "liquidity_sweep_asian": lambda symbol, days: _liquidity_sweep_events(symbol, days, "asian"),
    "liquidity_sweep_ny": lambda symbol, days: _liquidity_sweep_events(symbol, days, "ny"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="MGC1!")
    parser.add_argument("--strategy", choices=list(STRATEGIES), default="trend_breakout")
    parser.add_argument("--days", type=int, default=None)
    args = parser.parse_args()

    PUBLIC_DATA_DIR.mkdir(parents=True, exist_ok=True)
    stem = args.symbol.replace(":", "_").replace("!", "")

    bars_df = _load_bars(args.symbol, args.days)
    bars_path = PUBLIC_DATA_DIR / f"{stem}_bars.json"
    bars_path.write_text(json.dumps(_bars_to_json(bars_df)))
    print(f"Wrote {len(bars_df)} bars to {bars_path}", file=sys.stderr)

    events = STRATEGIES[args.strategy](args.symbol, args.days)
    events_path = PUBLIC_DATA_DIR / f"{stem}_{args.strategy}_events.json"
    events_path.write_text(json.dumps(events))
    print(f"Wrote {len(events['trades'])} trades / {len(events['levels'])} levels to {events_path}", file=sys.stderr)

    manifest_path = PUBLIC_DATA_DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    strategies_for_symbol = manifest.setdefault(stem, [])
    if args.strategy not in strategies_for_symbol:
        strategies_for_symbol.append(args.strategy)
    manifest_path.write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
