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

from .ict_smc import add_ict_smc_features
from .indicators import compute_all
from .liquidity_sweep import add_liquidity_sweep_features
from .session_context import add_session_context
from .session_levels import add_session_levels
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
    "in_bull_fvg", "in_bear_fvg", "dist_to_bull_fvg", "dist_to_bear_fvg",
    "in_bull_ob", "in_bear_ob", "dist_to_bull_ob", "dist_to_bear_ob",
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
    df = compute_all(raw)  # must run first — ict_smc's order blocks need atr_14
    df = add_liquidity_sweep_features(df)
    df = add_ict_smc_features(df)
    df = add_session_levels(df)
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
        # ctx_slice["time"] is each higher-timeframe bar's OPEN time (standard
        # OHLCV convention, confirmed against src/core/data.js's raw bar array —
        # time: v[0]). Its feature columns (vwap, rsi, ...) are computed from
        # that bar's FULL range, which isn't settled until the bar closes. A
        # plain merge_asof on open time would let e.g. a 1m row at 10:05 match
        # the 60m bar opened at 10:00 — whose values reflect the entire
        # 10:00-11:00 hour, i.e. up to 55 minutes of future information relative
        # to that 1m row. Shift the merge key to each context bar's CLOSE time
        # so a 1m row only ever sees higher-timeframe bars that had fully
        # closed by that point — this was a real lookahead leak, not just an
        # off-by-one, and it's the reason ctx_60m features (esp.
        # dist_from_vwap_sigma) previously dominated feature importance.
        ctx_tf_seconds = int(ctx_tf) * 60
        ctx_slice = ctx_slice.copy()
        ctx_slice["close_time"] = ctx_slice["time"] + ctx_tf_seconds
        ctx_slice = ctx_slice.drop(columns=["time"])
        df = pd.merge_asof(df.sort_values("time"), ctx_slice.sort_values("close_time"),
                            left_on="time", right_on="close_time", direction="backward")
        df = df.drop(columns=["close_time"])
        print(f"[{symbol} {timeframe}] joined context tf={ctx_tf} (close-time aligned, {len(ctx_df)} bars)", file=sys.stderr)

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
