"""
Feature-importance and partial-dependence plots for a trained model.

Partial dependence here is the standard definition: hold a sample of real
rows fixed, sweep *one* feature across its observed range (1st-99th
percentile, to avoid a couple of outliers stretching the whole axis), re-predict
at each grid point, and average — the resulting curve shows how the model's
output moves with that one feature, marginalized over the realistic joint
distribution of everything else (not "all other features held at their mean,"
which would put fake feature combinations into the model that never occur
together in real data).

Run as a module from the repo root:
    python -m ml.train.explain --symbol MNQ1! --timeframe 1 --direction long
    python -m ml.train.explain --all   # every model currently in ml/models/
"""
import argparse
import json
from pathlib import Path

import lightgbm as lgb
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from .train_model import MODELS_DIR, load_dataset

PLOTS_DIR = Path.home() / "data" / "ml-plots"
TOP_N_IMPORTANCE = 15
TOP_N_PDP = 6
PDP_GRID_SIZE = 30
PDP_SAMPLE_SIZE = 500


def discover_models() -> list[tuple[str, str, str]]:
    """(symbol, timeframe, direction) for every *.meta.json directly in
    MODELS_DIR (not the archive/ subdirectory)."""
    out = []
    for meta_path in sorted(MODELS_DIR.glob("*.meta.json")):
        meta = json.loads(meta_path.read_text())
        out.append((meta["symbol"], meta["timeframe"], meta["direction"]))
    return out


def load_model(symbol: str, timeframe: str, direction: str):
    stem = f"{symbol.replace(':', '_').replace('!', '')}_{timeframe}_{direction}"
    model = lgb.Booster(model_file=str(MODELS_DIR / f"{stem}.txt"))
    meta = json.loads((MODELS_DIR / f"{stem}.meta.json").read_text())
    return model, meta


def plot_importance(model, meta, out_path: Path):
    feat_cols = meta["feature_columns"]
    gain = model.feature_importance(importance_type="gain")
    order = np.argsort(gain)[::-1][:TOP_N_IMPORTANCE]
    names = [feat_cols[i] for i in order][::-1]
    values = [100 * gain[i] / gain.sum() for i in order][::-1]

    fig, ax = plt.subplots(figsize=(8, 0.4 * len(names) + 1.5))
    ax.barh(names, values, color="#4C78A8")
    ax.set_xlabel("% of total gain")
    ax.set_title(f"{meta['symbol']} {meta['timeframe']} {meta['direction']} — feature importance "
                 f"(test AUC={meta['metrics']['auc']:.3f})")
    for i, v in enumerate(values):
        ax.text(v, i, f" {v:.1f}%", va="center", fontsize=8)
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def compute_pdp(model, df: pd.DataFrame, feat_cols: list[str], target: str, best_iteration):
    sample = df[feat_cols].sample(min(PDP_SAMPLE_SIZE, len(df)), random_state=42).copy()
    values = df[target].dropna()
    if values.empty or values.min() == values.max():
        return None, None
    grid = np.linspace(values.quantile(0.01), values.quantile(0.99), PDP_GRID_SIZE)
    pdp = []
    for v in grid:
        sample[target] = v
        pdp.append(model.predict(sample, num_iteration=best_iteration).mean())
    return grid, np.array(pdp)


def plot_pdp_grid(model, meta, df: pd.DataFrame, out_path: Path):
    feat_cols = meta["feature_columns"]
    gain = model.feature_importance(importance_type="gain")
    order = np.argsort(gain)[::-1][:TOP_N_PDP]
    top_feats = [feat_cols[i] for i in order]

    ncols = 3
    nrows = (len(top_feats) + ncols - 1) // ncols
    fig, axes = plt.subplots(nrows, ncols, figsize=(5 * ncols, 3.5 * nrows))
    axes = np.atleast_1d(axes).flatten()

    for ax, feat in zip(axes, top_feats):
        grid, pdp = compute_pdp(model, df, feat_cols, feat, meta.get("best_iteration"))
        if grid is None:
            ax.set_visible(False)
            continue
        ax.plot(grid, pdp, color="#4C78A8", linewidth=2)
        ax.set_title(feat, fontsize=10)
        ax.set_ylabel("P(TP first)")
        # rug of the real observed distribution along the bottom, for context
        obs = df[feat].dropna()
        obs = obs[(obs >= grid.min()) & (obs <= grid.max())]
        ax.plot(obs.sample(min(200, len(obs)), random_state=1), [pdp.min()] * min(200, len(obs)),
                "|", color="gray", alpha=0.3, markersize=8)
    for ax in axes[len(top_feats):]:
        ax.set_visible(False)

    fig.suptitle(f"{meta['symbol']} {meta['timeframe']} {meta['direction']} — partial dependence, top {len(top_feats)} features")
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def explain_one(symbol: str, timeframe: str, direction: str) -> list[Path]:
    model, meta = load_model(symbol, timeframe, direction)
    df = load_dataset(symbol, timeframe)
    df = df.dropna(subset=[f"label_{direction}"]).reset_index(drop=True)

    PLOTS_DIR.mkdir(parents=True, exist_ok=True)
    stem = f"{symbol.replace(':', '_').replace('!', '')}_{timeframe}_{direction}"
    importance_path = PLOTS_DIR / f"{stem}_importance.png"
    pdp_path = PLOTS_DIR / f"{stem}_pdp.png"

    plot_importance(model, meta, importance_path)
    plot_pdp_grid(model, meta, df, pdp_path)
    return [importance_path, pdp_path]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol")
    parser.add_argument("--timeframe")
    parser.add_argument("--direction", choices=["long", "short"])
    parser.add_argument("--all", action="store_true", help="every model currently in ml/models/")
    args = parser.parse_args()

    targets = discover_models() if args.all else [(args.symbol, args.timeframe, args.direction)]
    for symbol, timeframe, direction in targets:
        paths = explain_one(symbol, timeframe, direction)
        for p in paths:
            print(p)


if __name__ == "__main__":
    main()
