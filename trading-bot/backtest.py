"""Minimal honest backtester: SMA crossover baseline with spread costs.

Usage:
    python backtest.py --csv data/EURUSD_H1.csv --spread 0.00015
    python backtest.py --synthetic            # smoke test on random-walk data

The point of this file is the *framework* (no look-ahead, costs included,
out-of-sample split), not the strategy. Swap `signals()` for your own logic.
"""
import argparse

import numpy as np
import pandas as pd


def signals(df: pd.DataFrame, fast: int, slow: int) -> pd.Series:
    """+1 long, -1 short, computed from data available at bar close."""
    f = df["close"].rolling(fast).mean()
    s = df["close"].rolling(slow).mean()
    sig = pd.Series(np.where(f > s, 1, -1), index=df.index)
    sig[s.isna()] = 0
    return sig


def run(df: pd.DataFrame, fast: int, slow: int, spread: float,
        bars_per_year: int) -> dict:
    sig = signals(df, fast, slow)
    # Signal at bar t close is executed for bar t+1 -> shift(1) prevents look-ahead
    pos = sig.shift(1).fillna(0)

    ret = df["close"].pct_change().fillna(0)
    turnover = pos.diff().abs().fillna(0)
    # Round trip costs one full spread; each unit of position change pays half.
    cost = turnover * (spread / df["close"]) / 2
    strat = pos * ret - cost

    equity = (1 + strat).cumprod()
    drawdown = equity / equity.cummax() - 1
    trades = int((turnover > 0).sum())
    std = strat.std()
    sharpe = (strat.mean() / std * np.sqrt(bars_per_year)) if std > 0 else 0.0

    return {
        "total_return_%": round((equity.iloc[-1] - 1) * 100, 2),
        "max_drawdown_%": round(drawdown.min() * 100, 2),
        "sharpe": round(float(sharpe), 2),
        "position_changes": trades,
        "buy_and_hold_%": round(((1 + ret).prod() - 1) * 100, 2),
    }


def synthetic(n: int = 20000, seed: int = 1) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    close = 1.10 * np.exp(np.cumsum(rng.normal(0, 0.0005, n)))
    return pd.DataFrame({"time": pd.date_range("2023-01-01", periods=n, freq="h"),
                         "close": close})


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--csv")
    p.add_argument("--synthetic", action="store_true")
    p.add_argument("--fast", type=int, default=20)
    p.add_argument("--slow", type=int, default=100)
    p.add_argument("--spread", type=float, default=0.00015,
                   help="spread in PRICE units (EURUSD 1.5 pips = 0.00015)")
    p.add_argument("--bars-per-year", type=int, default=6048, help="H1 forex ~6048")
    p.add_argument("--train-frac", type=float, default=0.7)
    args = p.parse_args()

    if args.synthetic:
        df = synthetic()
    elif args.csv:
        df = pd.read_csv(args.csv, parse_dates=["time"])
    else:
        raise SystemExit("Provide --csv or --synthetic")

    split = int(len(df) * args.train_frac)
    for name, part in (("IN-SAMPLE", df.iloc[:split]),
                       ("OUT-OF-SAMPLE", df.iloc[split:].reset_index(drop=True))):
        print(f"\n{name} ({len(part)} bars)")
        for k, v in run(part, args.fast, args.slow, args.spread,
                        args.bars_per_year).items():
            print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
