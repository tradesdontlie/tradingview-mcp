"""
Scores the unified (all-session) long/short models on their own held-out test
set, sliced by session (asian/london/ny), to see where the unified model's
edge actually concentrates — without the confound of session-specific models
each training on a different (smaller) subset with its own time-based split.
Complements train_model.py --session, which trains a separate model per
session instead of just slicing eval.

Run as a module from the repo root:
    python -m ml.train.eval_by_session --symbol MNQ1! --timeframe 1
"""
import argparse
import json
import sys

from sklearn.metrics import roc_auc_score, log_loss

from .backtest import held_out_start, load_model
from .train_model import SESSION_COLUMNS, load_dataset


def eval_by_session(symbol: str, timeframe: str) -> dict:
    df = load_dataset(symbol, timeframe)
    model_long, meta_long = load_model(symbol, timeframe, "long")
    model_short, meta_short = load_model(symbol, timeframe, "short")

    cutoff = held_out_start(df, meta_long, meta_short)
    test = df[df["time"] >= cutoff].reset_index(drop=True)
    print(f"[{symbol} {timeframe}] held-out test set: {len(test)} rows, from cutoff onward", file=sys.stderr)

    results = {}
    for label, mask in [("all", test.index == test.index)] + [
        (name, test[col] == 1) for name, col in SESSION_COLUMNS.items()
    ]:
        sub = test[mask]
        row = {"n_rows": len(sub)}
        for direction, model, meta in (("long", model_long, meta_long), ("short", model_short, meta_short)):
            label_col = f"label_{direction}"
            sub_labeled = sub.dropna(subset=[label_col])
            if len(sub_labeled) < 10 or sub_labeled[label_col].nunique() < 2:
                row[direction] = {"n": len(sub_labeled), "auc": None, "note": "too few / single-class rows"}
                continue
            feat = meta["feature_columns"]
            pred = model.predict(sub_labeled[feat], num_iteration=meta.get("best_iteration"))
            row[direction] = {
                "n": len(sub_labeled),
                "auc": round(float(roc_auc_score(sub_labeled[label_col], pred)), 4),
                "log_loss": round(float(log_loss(sub_labeled[label_col], pred, labels=[0, 1])), 4),
                "positive_rate": round(float(sub_labeled[label_col].mean()), 4),
            }
        results[label] = row
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--timeframe", required=True)
    args = parser.parse_args()
    print(json.dumps(eval_by_session(args.symbol, args.timeframe), indent=2))


if __name__ == "__main__":
    main()
