"""
Builds a labeled training dataset for one symbol + execution timeframe:
raw bars -> indicators + liquidity-sweep + session-context features on the
execution timeframe, joined with the same feature set computed on one or more
higher "context" timeframes (as-of merged, so a 1m row only ever sees a 5m/1h/4h
bar that had *already closed* at that point in time — no lookahead), then
triple-barrier labeled using ml/config/symbols.json's fixed TP/SL ticks.

Run as a module from the repo root (relative imports need the package context):
    python -m ml.features.build_dataset --symbol MNQ1! --timeframe 1 --context 5,60
"""
import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from .indicators import compute_all
from .liquidity_sweep import add_liquidity_sweep_features
from .session_context import add_session_context
from ..data_collection.collect_replay import parquet_path
from ..labels.triple_barrier import label_triple_barrier

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "symbols.json"
OUT_DIR = Path.home() / "data" / "ml-processed"

# Curated columns pulled from context timeframes — not the full feature set, to
# keep the joined frame from ballooning with mostly-redundant OHLC columns.
CONTEXT_FEATURE_COLS = [
    "rsi_14", "macd_hist", "bb_pctb_20", "bb_width_20",
    "dist_from_vwap_sigma", "atr_14",
    "premarket_swept_high_recently", "premarket_swept_low_recently",
    "prior_day_swept_high_recently", "prior_day_swept_low_recently",
    "structural_swept_high_recently", "structural_swept_low_recently",
]


def load_symbol_config(symbol: str, timeframe: str) -> dict:
    """tp_ticks/sl_ticks in symbols.json are exchange ticks (matching the field
    name) — this is the one place that converts them to price points via the
    symbol's tick_size, so every caller works in points and never has to guess
    which unit a raw number is in. (This distinction is exactly what caused a
    real bug once: MGC1!'s tp_ticks=100 was briefly read as 100 *points* instead
    of 100 ticks = $10, making the configured TP look unreachable relative to
    gold's actual volatility.)"""
    all_config = json.loads(CONFIG_PATH.read_text())
    sym_cfg = all_config.get(symbol)
    if not sym_cfg:
        raise ValueError(f"No config for symbol {symbol} in {CONFIG_PATH}")
    tf_cfg = sym_cfg["timeframes"].get(timeframe)
    if not tf_cfg:
        raise ValueError(f"No timeframe {timeframe} config for {symbol} in {CONFIG_PATH}")
    tick_size = sym_cfg["tick_size"]
    return {
        **tf_cfg,
        "tick_size": tick_size,
        "point_value": sym_cfg["point_value"],
        "tp_points": tf_cfg["tp_ticks"] * tick_size,
        "sl_points": tf_cfg["sl_ticks"] * tick_size,
    }


def compute_features(raw: pd.DataFrame) -> pd.DataFrame:
    df = compute_all(raw)
    df = add_liquidity_sweep_features(df)
    df = add_session_context(df)
    return df


def load_raw(symbol: str, timeframe: str) -> pd.DataFrame:
    path = parquet_path(symbol, timeframe)
    if not path.exists():
        raise FileNotFoundError(
            f"No raw data at {path} — run collect_replay.py for {symbol} {timeframe} first."
        )
    return pd.read_parquet(path)


def build(symbol: str, timeframe: str, context_timeframes: list[str]) -> pd.DataFrame:
    raw = load_raw(symbol, timeframe)
    print(f"[{symbol} {timeframe}] {len(raw)} raw bars", file=sys.stderr)
    df = compute_features(raw)

    for ctx_tf in context_timeframes:
        ctx_raw = load_raw(symbol, ctx_tf)
        ctx_df = compute_features(ctx_raw)
        cols = ["time"] + [c for c in CONTEXT_FEATURE_COLS if c in ctx_df.columns]
        ctx_slice = ctx_df[cols].add_prefix(f"ctx_{ctx_tf}m_").rename(columns={f"ctx_{ctx_tf}m_time": "time"})
        df = pd.merge_asof(df.sort_values("time"), ctx_slice.sort_values("time"), on="time", direction="backward")
        print(f"[{symbol} {timeframe}] joined context tf={ctx_tf} ({len(ctx_df)} bars)", file=sys.stderr)

    tf_cfg = load_symbol_config(symbol, timeframe)
    df = label_triple_barrier(df, tp_points=tf_cfg["tp_points"], sl_points=tf_cfg["sl_points"],
                               horizon_bars=tf_cfg["horizon_bars"])

    n_labeled_long = df["label_long"].notna().sum()
    n_labeled_short = df["label_short"].notna().sum()
    print(f"[{symbol} {timeframe}] labeled rows: long={n_labeled_long} short={n_labeled_short} "
          f"(of {len(df)} total, rest are horizon timeouts)", file=sys.stderr)
    return df


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--timeframe", required=True, help="execution timeframe, e.g. 1, 5")
    parser.add_argument("--context", default="", help="comma-separated higher timeframes to join as context, e.g. 5,60")
    parser.add_argument("--out", help="output parquet path, default data/ml-processed/{symbol}_{tf}.parquet")
    args = parser.parse_args()

    context_tfs = [c.strip() for c in args.context.split(",") if c.strip()]
    df = build(args.symbol, args.timeframe, context_tfs)

    out_path = Path(args.out) if args.out else OUT_DIR / f"{args.symbol.replace(':', '_').replace('!', '')}_{args.timeframe}.parquet"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out_path, index=False)
    print(f"Wrote {len(df)} rows to {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
