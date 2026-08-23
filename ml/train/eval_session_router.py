"""
Scores each session-specific model (asian/london/ny x long/short, trained via
train_model.py --session) on its own held-out test slice, then pools all
three sessions' held-out predictions into one number: "if every request were
routed to the specialist model for whatever session it falls in, what's the
overall out-of-sample performance" — directly comparable to the unified
model's overall test AUC (eval_by_session.py's "all" row), since asian/
london/ny sessions don't overlap so every routed row is scored exactly once.

Requires the six session models to already exist (train_model.py --session
asian/london/ny, --direction long/short).

Run as a module from the repo root:
    python -m ml.train.eval_session_router --symbol MNQ1! --timeframe 1
"""
import argparse
import json
import sys

import lightgbm as lgb
import numpy as np
from sklearn.metrics import log_loss, roc_auc_score

from .train_model import MODELS_DIR, SESSION_COLUMNS, load_dataset, time_split


def load_session_model(symbol: str, timeframe: str, direction: str, session: str):
    stem = f"{symbol.replace(':', '_').replace('!', '')}_{timeframe}_{direction}_{session}"
    model_path = MODELS_DIR / f"{stem}.txt"
    meta_path = MODELS_DIR / f"{stem}.meta.json"
    if not model_path.exists():
        raise FileNotFoundError(f"No model at {model_path} — run train_model.py --session {session} first.")
    return lgb.Booster(model_file=str(model_path)), json.loads(meta_path.read_text())


def eval_session_router(symbol: str, timeframe: str) -> dict:
    df = load_dataset(symbol, timeframe)
    per_session = {}
    pooled = {"long": {"y": [], "p": []}, "short": {"y": [], "p": []}}

    for session, session_col in SESSION_COLUMNS.items():
        session_df = df[df[session_col] == 1].reset_index(drop=True)
        row = {}
        for direction in ("long", "short"):
            label_col = f"label_{direction}"
            model, meta = load_session_model(symbol, timeframe, direction, session)
            labeled = session_df.dropna(subset=[label_col]).reset_index(drop=True)
            _, test = time_split(labeled, meta["test_frac"])
            feat = meta["feature_columns"]
            pred = model.predict(test[feat], num_iteration=meta.get("best_iteration"))
            y = test[label_col].to_numpy()
            row[direction] = {
                "n": len(test),
                "auc": round(float(roc_auc_score(y, pred)), 4) if len(set(y)) > 1 else None,
                "log_loss": round(float(log_loss(y, pred, labels=[0, 1])), 4) if len(test) else None,
                "positive_rate": round(float(y.mean()), 4) if len(test) else None,
            }
            pooled[direction]["y"].extend(y.tolist())
            pooled[direction]["p"].extend(pred.tolist())
        per_session[session] = row

    overall_routed = {}
    for direction in ("long", "short"):
        y = np.array(pooled[direction]["y"])
        p = np.array(pooled[direction]["p"])
        overall_routed[direction] = {
            "n": len(y),
            "auc": round(float(roc_auc_score(y, p)), 4) if len(set(y)) > 1 else None,
            "log_loss": round(float(log_loss(y, p, labels=[0, 1])), 4) if len(y) else None,
            "positive_rate": round(float(y.mean()), 4) if len(y) else None,
        }

    return {"per_session": per_session, "overall_routed": overall_routed}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--timeframe", required=True)
    args = parser.parse_args()
    print(json.dumps(eval_session_router(args.symbol, args.timeframe), indent=2))


if __name__ == "__main__":
    main()
