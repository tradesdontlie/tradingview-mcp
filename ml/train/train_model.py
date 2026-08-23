"""
Trains a LightGBM binary classifier predicting P(TP hit before SL) for one
symbol + execution timeframe + direction (long/short), on the dataset produced
by ml/features/build_dataset.py.

Split is strictly time-ordered (last `--test-frac` of the data, by time, held
out) rather than shuffled k-fold — shuffling would leak future bars' feature
values (via rolling windows / session aggregates) into training folds that
precede them in time.

Run as a module from the repo root:
    python -m ml.train.train_model --symbol MNQ1! --timeframe 1 --direction long
"""
import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import pandas as pd
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

PROCESSED_DIR = Path.home() / "data" / "ml-processed"
MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
MODELS_ARCHIVE_DIR = MODELS_DIR / "archive"

# Asian/London/NY genuinely trade differently (different volatility, different
# dominant participants) — session_context.py already tags every row with
# which session(s) it falls in (in_asian_futures / in_london_open /
# in_ny_session), so training on a session-filtered subset instead of the
# whole day is just a row filter, not new feature engineering.
SESSION_COLUMNS = {
    "asian": "in_asian_futures",
    "london": "in_london_open",
    "ny": "in_ny_session",
}

NON_FEATURE_COLS = {
    "time", "open", "high", "low", "close", "volume", "session_id",
    "label_long", "label_short", "bars_to_resolve_long", "bars_to_resolve_short",
}


def load_dataset(symbol: str, timeframe: str) -> pd.DataFrame:
    path = PROCESSED_DIR / f"{symbol.replace(':', '_').replace('!', '')}_{timeframe}.parquet"
    if not path.exists():
        raise FileNotFoundError(f"No processed dataset at {path} — run build_dataset.py first.")
    return pd.read_parquet(path).sort_values("time").reset_index(drop=True)


def feature_columns(df: pd.DataFrame) -> list[str]:
    return [c for c in df.columns if c not in NON_FEATURE_COLS and pd.api.types.is_numeric_dtype(df[c])]


def time_split(df: pd.DataFrame, test_frac: float):
    split_idx = int(len(df) * (1 - test_frac))
    return df.iloc[:split_idx], df.iloc[split_idx:]


def train(symbol: str, timeframe: str, direction: str, test_frac: float, val_frac: float,
          session: str | None = None):
    label_col = f"label_{direction}"
    df = load_dataset(symbol, timeframe)
    df = df.dropna(subset=[label_col]).reset_index(drop=True)

    if session:
        session_col = SESSION_COLUMNS[session]
        before = len(df)
        df = df[df[session_col] == 1].reset_index(drop=True)
        print(f"[{symbol} {timeframe} {direction}] session={session}: {before} -> {len(df)} rows", file=sys.stderr)

    feat_cols = feature_columns(df)
    print(f"[{symbol} {timeframe} {direction}] {len(df)} labeled rows, {len(feat_cols)} features", file=sys.stderr)

    train_val, test = time_split(df, test_frac)
    train_df, val_df = time_split(train_val, val_frac)

    train_set = lgb.Dataset(train_df[feat_cols], label=train_df[label_col])
    val_set = lgb.Dataset(val_df[feat_cols], label=val_df[label_col], reference=train_set)

    params = {
        "objective": "binary",
        "metric": ["auc", "binary_logloss"],
        "learning_rate": 0.05,
        "num_leaves": 31,
        "min_data_in_leaf": 50,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 5,
        "verbose": -1,
    }
    model = lgb.train(
        params, train_set, num_boost_round=1000, valid_sets=[val_set],
        callbacks=[lgb.early_stopping(stopping_rounds=50, verbose=False), lgb.log_evaluation(period=0)],
    )

    test_pred = model.predict(test[feat_cols], num_iteration=model.best_iteration)
    metrics = {
        "auc": roc_auc_score(test[label_col], test_pred) if test[label_col].nunique() > 1 else None,
        "log_loss": log_loss(test[label_col], test_pred, labels=[0, 1]),
        "brier_score": brier_score_loss(test[label_col], test_pred),
        "test_rows": len(test),
        "test_positive_rate": float(test[label_col].mean()),
        "best_iteration": model.best_iteration,
    }
    print(f"[{symbol} {timeframe} {direction}] test metrics: {json.dumps(metrics, indent=2)}", file=sys.stderr)

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    session_suffix = f"_{session}" if session else ""
    model_path = MODELS_DIR / f"{symbol.replace(':', '_').replace('!', '')}_{timeframe}_{direction}{session_suffix}.txt"
    meta_path = model_path.with_suffix(".meta.json")

    # train_model.py used to overwrite the previous model with no history at
    # all — confirmed the cost of that directly: every earlier MGC1! model
    # this session (including the pre-fix, ~0.5-AUC one worth comparing
    # against) is gone. Archive whatever's about to be replaced, timestamped,
    # before writing the new one.
    if model_path.exists():
        MODELS_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        shutil.copy2(model_path, MODELS_ARCHIVE_DIR / f"{model_path.stem}_{stamp}.txt")
        if meta_path.exists():
            shutil.copy2(meta_path, MODELS_ARCHIVE_DIR / f"{meta_path.stem.replace('.meta', '')}_{stamp}.meta.json")

    model.save_model(str(model_path))
    meta_path.write_text(json.dumps({
        "symbol": symbol, "timeframe": timeframe, "direction": direction, "session": session,
        "feature_columns": feat_cols, "metrics": metrics,
        "train_rows": len(train_df), "val_rows": len(val_df), "test_rows": len(test),
        "time_range": [int(df["time"].min()), int(df["time"].max())],
        "test_frac": test_frac, "val_frac": val_frac,
    }, indent=2))
    print(f"Saved model to {model_path}", file=sys.stderr)
    return model, metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--timeframe", required=True)
    parser.add_argument("--direction", choices=["long", "short"], required=True)
    parser.add_argument("--test-frac", type=float, default=0.2)
    parser.add_argument("--val-frac", type=float, default=0.15)
    parser.add_argument("--session", choices=list(SESSION_COLUMNS), help="train only on this session's bars (asian/london/ny) instead of all day")
    args = parser.parse_args()
    train(args.symbol, args.timeframe, args.direction, args.test_frac, args.val_frac, args.session)


if __name__ == "__main__":
    main()
