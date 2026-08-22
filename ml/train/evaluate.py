"""
Evaluates a saved model on its held-out time-based test split: reliability
(calibration) table plus standard classification metrics.

Since the model's whole point is a usable probability (not just a yes/no
signal), a calibration table matters more than raw accuracy — a model that
says "65%" should actually resolve TP-first close to 65% of the time.

Run as a module from the repo root:
    python -m ml.train.evaluate --symbol MNQ1! --timeframe 1 --direction long
"""
import argparse
import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.calibration import calibration_curve
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

from .train_model import PROCESSED_DIR, MODELS_DIR, load_dataset, time_split


def evaluate(symbol: str, timeframe: str, direction: str, n_bins: int = 10):
    model_path = MODELS_DIR / f"{symbol.replace(':', '_').replace('!', '')}_{timeframe}_{direction}.txt"
    meta_path = model_path.with_suffix(".meta.json")
    if not model_path.exists():
        raise FileNotFoundError(f"No model at {model_path} — run train_model.py first.")

    meta = json.loads(meta_path.read_text())
    model = lgb.Booster(model_file=str(model_path))

    label_col = f"label_{direction}"
    df = load_dataset(symbol, timeframe)
    df = df.dropna(subset=[label_col]).reset_index(drop=True)

    train_val, test = time_split(df, meta["test_frac"])
    feat_cols = meta["feature_columns"]
    pred = model.predict(test[feat_cols], num_iteration=meta.get("best_iteration"))
    y_true = test[label_col].to_numpy()

    metrics = {
        "auc": roc_auc_score(y_true, pred) if len(np.unique(y_true)) > 1 else None,
        "log_loss": log_loss(y_true, pred, labels=[0, 1]),
        "brier_score": brier_score_loss(y_true, pred),
        "positive_rate": float(y_true.mean()),
        "pred_mean": float(pred.mean()),
    }
    print(json.dumps(metrics, indent=2))

    frac_pos, mean_pred = calibration_curve(y_true, pred, n_bins=n_bins, strategy="quantile")
    print("\nCalibration (predicted vs actual TP-first rate, by decile):")
    print(f"{'predicted':>10}  {'actual':>10}")
    for p, a in zip(mean_pred, frac_pos):
        print(f"{p:>10.3f}  {a:>10.3f}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--timeframe", required=True)
    parser.add_argument("--direction", choices=["long", "short"], required=True)
    parser.add_argument("--bins", type=int, default=10)
    args = parser.parse_args()
    evaluate(args.symbol, args.timeframe, args.direction, n_bins=args.bins)


if __name__ == "__main__":
    main()
