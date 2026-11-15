"""Walk-forward research harness.

For every strategy / timeframe / pair it:
  1. computes the strategy's returns for every parameter set (spread cost included),
  2. repeatedly picks the best parameters on a 2-year TRAIN window and applies them
     to the next 6-month TEST window it has never seen,
  3. stitches all test windows into one out-of-sample record,
  4. repeats with 2x costs to check the edge survives worse execution.

Usage (run from the project folder, venv active):
    python research.py                              # real data in data/
    python research.py --synthetic random           # negative control: should find NO edge
    python research.py --synthetic trend            # positive control: should find an edge
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

import strategies as S

# Assumed full round-trip spread in PRICE units (conservative; edit to your broker).
COSTS = {"EURUSD": 0.00010, "GBPUSD": 0.00015, "USDJPY": 0.012}
BARS_PER_YEAR = {"1h": 6240, "4h": 1560, "1D": 260}
TRAIN_YEARS, TEST_YEARS = 2.0, 0.5
PASS_SHARPE, STRESS = 0.5, 2.0


# ---------- data ----------
def load_pair(pair: str) -> pd.DataFrame:
    path = Path("data") / f"{pair}_H1.csv"
    df = pd.read_csv(path, parse_dates=["time"]).set_index("time")
    return df[["open", "high", "low", "close"]]


def resample(df: pd.DataFrame, tf: str) -> pd.DataFrame:
    if tf == "1h":
        return df
    agg = {"open": "first", "high": "max", "low": "min", "close": "last"}
    return df.resample(tf).agg(agg).dropna()


def synthetic_pairs(kind: str, years: int = 10, seed: int = 7) -> dict:
    """random = pure random walk (no edge). trend = random walk + slow drifts (edge)."""
    n = int(years * 6240)
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2016-01-01", periods=n, freq="h")
    out = {}
    for pair, base in {"EURUSD": 1.10, "GBPUSD": 1.30, "USDJPY": 110.0}.items():
        r = rng.normal(0, 0.0005, n)
        if kind == "trend":
            drift = np.zeros(n)
            shocks = rng.normal(0, 0.000004, n)
            for i in range(1, n):
                drift[i] = 0.998 * drift[i - 1] + shocks[i]
            r = r + drift
        close = base * np.exp(np.cumsum(r))
        open_ = np.roll(close, 1)
        open_[0] = close[0]
        wick = np.abs(rng.normal(0, 0.0002, n))
        out[pair] = pd.DataFrame({
            "open": open_, "close": close,
            "high": np.maximum(open_, close) * (1 + wick),
            "low": np.minimum(open_, close) * (1 - wick),
        }, index=idx)
    return out


# ---------- engine ----------
def build_returns(df: pd.DataFrame, strat: str, cost: float):
    """Per-parameter gross returns and turnover, plus per-unit-turnover cost."""
    func, grid = S.STRATEGIES[strat]
    close = df["close"]
    ret = close.pct_change().fillna(0.0)
    G, T = {}, {}
    for i, params in enumerate(grid):
        pos = func(df, **params).shift(1).fillna(0.0)   # trade next bar: no look-ahead
        T[i] = pos.diff().abs().fillna(0.0)
        G[i] = pos * ret
    cf = (cost / close) / 2     # a round trip (2 units of turnover) pays one full spread
    return pd.DataFrame(G), pd.DataFrame(T), cf, ret


def walk_forward(G, T, cf, ret, mult: float, bpy: int):
    R = G - T.mul(cf, axis=0) * mult
    n, train, test = len(R), int(TRAIN_YEARS * bpy), int(TEST_YEARS * bpy)
    out, bh, trades, nwin, start = [], [], 0, 0, 0
    while start + train + test <= n:
        a, b, c = start, start + train, start + train + test
        tr = R.iloc[a:b]
        score = (tr.mean() / tr.std().replace(0, np.nan)).fillna(-np.inf)
        best = score.idxmax()
        out.append(R.iloc[b:c][best])
        bh.append(ret.iloc[b:c])
        trades += int((T.iloc[b:c][best] > 0).sum())
        nwin += 1
        start += test
    if nwin == 0:
        return None
    r = pd.concat(out)
    eq = (1 + r).cumprod()
    sd = r.std()
    return {
        "sharpe": float(r.mean() / sd * np.sqrt(bpy)) if sd > 0 else 0.0,
        "ret": float(eq.iloc[-1] - 1) * 100,
        "maxdd": float((eq / eq.cummax() - 1).min()) * 100,
        "trades": trades,
        "windows": nwin,
        "bh": float((1 + pd.concat(bh)).prod() - 1) * 100,
    }


# ---------- main ----------
def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", nargs="+", default=list(COSTS))
    p.add_argument("--timeframes", nargs="+", default=["1D", "4h", "1h"])
    p.add_argument("--synthetic", choices=["random", "trend"])
    args = p.parse_args()

    if args.synthetic:
        raw = synthetic_pairs(args.synthetic)
    else:
        raw = {}
        for pair in args.pairs:
            try:
                raw[pair] = load_pair(pair)
            except FileNotFoundError:
                print(f"[skip] data/{pair}_H1.csv not found")
    if not raw:
        raise SystemExit("No data loaded")

    rows = []
    for strat in S.STRATEGIES:
        for tf in args.timeframes:
            for pair, h1 in raw.items():
                df = resample(h1, tf)
                bpy = BARS_PER_YEAR[tf]
                G, T, cf, ret = build_returns(df, strat, COSTS[pair])
                base = walk_forward(G, T, cf, ret, 1.0, bpy)
                stress = walk_forward(G, T, cf, ret, STRESS, bpy)
                if base is None:
                    continue
                rows.append({"strategy": strat, "tf": tf, "pair": pair,
                             **{k: round(v, 2) for k, v in base.items()},
                             "ret_2x_cost": round(stress["ret"], 2)})

    res = pd.DataFrame(rows)
    Path("results").mkdir(exist_ok=True)
    res.to_csv("results/summary.csv", index=False)

    print(f"\nOUT-OF-SAMPLE walk-forward (train {TRAIN_YEARS}y / test {TEST_YEARS}y)")
    print(f"PASS = every pair: Sharpe >= {PASS_SHARPE} AND profitable at {STRESS}x costs\n")
    pairs = list(raw)
    head = f"{'strategy':<10}{'tf':<4}" + "".join(f"| {pr:^24}" for pr in pairs) + "| verdict"
    print(head)
    print(f"{'':<14}" + "".join(f"| {'Sharpe  ret%  ret%@2x':^24}" for _ in pairs))
    print("-" * len(head))
    for (strat, tf), g in res.groupby(["strategy", "tf"], sort=False):
        line, ok = f"{strat:<10}{tf:<4}", len(g) == len(pairs)
        for pr in pairs:
            m = g[g.pair == pr]
            if m.empty:
                line += f"| {'n/a':^24}"
                continue
            m = m.iloc[0]
            line += f"| {m.sharpe:6.2f} {m.ret:6.1f} {m.ret_2x_cost:7.1f}   "
            ok &= (m.sharpe >= PASS_SHARPE) and (m.ret_2x_cost > 0)
        print(line + ("| PASS" if ok else "| fail"))

    print("\nDetails (drawdown, trades, buy&hold, windows): results/summary.csv")
    print("Caution: this tests several strategies x timeframes x pairs. Some will look")
    print("good by luck alone. Only trust a PASS that is consistent across all pairs.")


if __name__ == "__main__":
    main()
