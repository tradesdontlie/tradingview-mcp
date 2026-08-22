"""
Live inference: pulls the current buffered bars for a symbol (execution
timeframe + context timeframes) via the `tv` CLI (no replay — this reads
whatever TradingView Desktop has live), recomputes the exact same feature
pipeline used in training, and outputs P(TP before SL) for both a long and a
short entry at the latest close.

This is decision support, not an order router — nothing here places a trade.
Combine the probabilities with the sweep/session flags in the feature output
(or the dashboard) to judge which direction the setup actually favors.

Run as a module from the repo root:
    python -m ml.serve.predict --symbol MNQ1! --timeframe 1 --context 5,60
"""
import argparse
import json
import sys
import time

import lightgbm as lgb
import pandas as pd

from ..data_collection.collect_replay import tv, switch_chart, chart_lock, bars_look_contaminated
from ..features.build_dataset import compute_features, load_symbol_config, CONTEXT_FEATURE_COLS
from ..train.train_model import MODELS_DIR

FETCH_RETRIES = 5
FETCH_RETRY_DELAY_S = 1.0


def to_native(v):
    """pandas/numpy scalars (int64, float64, bool_, ...) aren't JSON-serializable
    on their own — unwrap to the plain Python type via numpy's .item(), which
    every numpy scalar exposes."""
    if v is None:
        return None
    if hasattr(v, "item"):
        v = v.item()
    if isinstance(v, float) and pd.isna(v):
        return None
    return v


def fetch_bars_df(count: int = 500) -> pd.DataFrame:
    # Switching symbol/timeframe just before this doesn't guarantee TradingView
    # has finished loading the new chart's data yet — "still loading" is a
    # transient condition that clears within a second or two, not a real failure.
    # Separately, switch_chart()'s own verification only checks the chart's
    # symbol *label*, which can update before the underlying bar buffer has
    # caught up — bars_look_contaminated() catches that straddle at the data
    # level instead of trusting the label (see collect_replay.py for the full
    # story on why this check exists).
    last_err = None
    for attempt in range(FETCH_RETRIES):
        try:
            bars = tv(["ohlcv", "-n", str(count)]).get("bars", [])
            if bars and not bars_look_contaminated(bars):
                return pd.DataFrame(bars)
            last_err = RuntimeError("No bars returned from `tv ohlcv`" if not bars else "bars look contaminated (implausible jump)")
        except RuntimeError as err:
            last_err = err
        time.sleep(FETCH_RETRY_DELAY_S)
    raise RuntimeError(f"Failed to fetch clean OHLCV after {FETCH_RETRIES} attempts: {last_err}")


def build_live_features(symbol: str, timeframe: str, context_tfs: list[str]) -> pd.DataFrame:
    # Held for the whole sequence of switches+reads, not just each individual
    # switch_chart() call — otherwise collect_replay.py (or another predict.py
    # invocation) could still jump in between two of these and read a stale
    # instrument, same failure mode as before, just narrower.
    with chart_lock():
        switch_chart(symbol, timeframe)
        raw = fetch_bars_df()
        df = compute_features(raw)

        for ctx_tf in context_tfs:
            switch_chart(symbol, ctx_tf)
            ctx_raw = fetch_bars_df()
            ctx_df = compute_features(ctx_raw)
            cols = ["time"] + [c for c in CONTEXT_FEATURE_COLS if c in ctx_df.columns]
            ctx_slice = ctx_df[cols].add_prefix(f"ctx_{ctx_tf}m_").rename(columns={f"ctx_{ctx_tf}m_time": "time"})
            df = pd.merge_asof(df.sort_values("time"), ctx_slice.sort_values("time"), on="time", direction="backward")

        switch_chart(symbol, timeframe)  # leave the chart on the execution timeframe
    return df


def load_model(symbol: str, timeframe: str, direction: str):
    stem = f"{symbol.replace(':', '_').replace('!', '')}_{timeframe}_{direction}"
    model_path = MODELS_DIR / f"{stem}.txt"
    meta_path = MODELS_DIR / f"{stem}.meta.json"
    if not model_path.exists():
        return None, None
    return lgb.Booster(model_file=str(model_path)), json.loads(meta_path.read_text())


def predict(symbol: str, timeframe: str, context_tfs: list[str]) -> dict:
    # Check for trained models BEFORE touching the live chart — this call drives
    # the user's actual TradingView Desktop window (switching symbol/timeframe
    # live to read each buffer), so a target with no model yet shouldn't cause
    # any of that chart churn at all, not just skip the inference at the end.
    models = {d: load_model(symbol, timeframe, d) for d in ("long", "short")}
    if all(m is None for m, _ in models.values()):
        return {
            "type": "ML_PROB_TP", "symbol": symbol, "timeframe": timeframe,
            "status": "no_model", "prob_long_tp": None, "prob_short_tp": None,
        }

    df = build_live_features(symbol, timeframe, context_tfs)
    latest = df.iloc[[-1]]

    tf_cfg = load_symbol_config(symbol, timeframe)
    result = {
        "type": "ML_PROB_TP",
        "symbol": symbol,
        "timeframe": timeframe,
        "as_of": int(latest["time"].iloc[0]),
        "entry": float(latest["close"].iloc[0]),
        "tp_ticks": tf_cfg["tp_ticks"],
        "sl_ticks": tf_cfg["sl_ticks"],
        "tp_points": tf_cfg["tp_points"],
        "sl_points": tf_cfg["sl_points"],
        "horizon_bars": tf_cfg["horizon_bars"],
        "prob_long_tp": None,
        "prob_short_tp": None,
        "context_flags": {
            col: to_native(latest[col].iloc[0]) if col in latest.columns else None
            for col in [
                "premarket_swept_high_recently", "premarket_swept_low_recently",
                "prior_day_swept_high_recently", "prior_day_swept_low_recently",
                "structural_swept_high_recently", "structural_swept_low_recently",
                "in_ny_open", "in_asian_futures", "near_macro_slot",
            ] if col in latest.columns
        },
    }

    for direction in ("long", "short"):
        model, meta = models[direction]
        if model is None:
            continue
        feat_cols = meta["feature_columns"]
        missing = [c for c in feat_cols if c not in latest.columns]
        if missing:
            result[f"prob_{direction}_tp_error"] = f"missing features: {missing}"
            continue
        prob = float(model.predict(latest[feat_cols], num_iteration=meta.get("best_iteration"))[0])
        result[f"prob_{direction}_tp"] = prob

    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--timeframe", required=True)
    parser.add_argument("--context", default="", help="comma-separated context timeframes, e.g. 5,60")
    args = parser.parse_args()

    context_tfs = [c.strip() for c in args.context.split(",") if c.strip()]
    result = predict(args.symbol, args.timeframe, context_tfs)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
