"""Candidate strategies. Each returns a Series of target positions in {-1, 0, +1}
computed ONLY from data available at that bar's close (the engine shifts by one
bar before trading, so there is no look-ahead).
"""
import itertools

import numpy as np
import pandas as pd


def sma_cross(df: pd.DataFrame, fast: int, slow: int) -> pd.Series:
    f = df["close"].rolling(fast).mean()
    s = df["close"].rolling(slow).mean()
    sig = pd.Series(np.where(f > s, 1.0, -1.0), index=df.index)
    sig[s.isna()] = 0.0
    return sig


def donchian(df: pd.DataFrame, n: int) -> pd.Series:
    """Breakout: long above the prior n-bar high, short below the prior n-bar low,
    otherwise hold the last position."""
    hh = df["high"].rolling(n).max().shift(1)
    ll = df["low"].rolling(n).min().shift(1)
    raw = np.where(df["close"] > hh, 1.0, np.where(df["close"] < ll, -1.0, np.nan))
    return pd.Series(raw, index=df.index).ffill().fillna(0.0)


def momentum(df: pd.DataFrame, n: int) -> pd.Series:
    """Time-series momentum: follow the sign of the last n-bar return."""
    r = df["close"] / df["close"].shift(n) - 1
    return np.sign(r).fillna(0.0)


def mean_reversion(df: pd.DataFrame, n: int, k: float) -> pd.Series:
    """Fade stretches: enter at |z| > k, exit when z crosses back through 0."""
    ma = df["close"].rolling(n).mean()
    sd = df["close"].rolling(n).std()
    z = ((df["close"] - ma) / sd).to_numpy()
    pos = np.zeros(len(z))
    cur = 0.0
    for i, zi in enumerate(z):
        if np.isnan(zi):
            cur = 0.0
        elif cur == 0.0:
            if zi < -k:
                cur = 1.0
            elif zi > k:
                cur = -1.0
        elif cur == 1.0 and zi >= 0:
            cur = 0.0
        elif cur == -1.0 and zi <= 0:
            cur = 0.0
        pos[i] = cur
    return pd.Series(pos, index=df.index)


def _grid(**axes):
    keys = list(axes)
    return [dict(zip(keys, vals)) for vals in itertools.product(*axes.values())]


STRATEGIES = {
    "sma_cross": (sma_cross, [g for g in _grid(fast=[10, 20, 50], slow=[100, 200, 400])
                              if g["fast"] < g["slow"]]),
    "donchian": (donchian, _grid(n=[20, 50, 100, 200])),
    "momentum": (momentum, _grid(n=[24, 72, 168, 336])),
    "mean_rev": (mean_reversion, _grid(n=[20, 50, 100], k=[1.5, 2.0, 2.5])),
}
