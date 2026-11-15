"""Statistics for judging whether a backtest result is real or luck.

psr  - Probabilistic Sharpe Ratio: chance the true Sharpe beats a benchmark, given sample
       length, skew and fat tails (Bailey & Lopez de Prado, 2012).
dsr  - Deflated Sharpe Ratio: PSR against the Sharpe you would expect from the LUCKIEST of
       N tried variants (Bailey & Lopez de Prado, 2014). The more you try, the higher the bar.
"""
import math
from statistics import NormalDist

import numpy as np

_N = NormalDist()
_EULER = 0.5772156649015329


def sharpe(r, periods: int = 252) -> float:
    r = np.asarray(r, dtype=float)
    sd = r.std(ddof=1)
    return float(r.mean() / sd * math.sqrt(periods)) if sd > 0 else 0.0


def max_drawdown(r) -> float:
    eq = np.cumprod(1 + np.asarray(r, dtype=float))
    return float((eq / np.maximum.accumulate(eq) - 1).min())


def _psr_period(r: np.ndarray, sr_bench_period: float) -> float:
    t = len(r)
    sd = r.std(ddof=1)
    if t < 30 or sd == 0:
        return float("nan")
    sr = r.mean() / sd
    z = (r - r.mean()) / r.std()
    skew, kurt = float((z ** 3).mean()), float((z ** 4).mean())     # kurt is non-excess
    denom = math.sqrt(max(1e-12, 1 - skew * sr + (kurt - 1) / 4 * sr ** 2))
    return _N.cdf((sr - sr_bench_period) * math.sqrt(t - 1) / denom)


def psr(r, sr_benchmark_annual: float = 0.0, periods: int = 252) -> float:
    return _psr_period(np.asarray(r, dtype=float), sr_benchmark_annual / math.sqrt(periods))


def expected_max_sharpe(n_trials: int, var_sr_period: float) -> float:
    """Expected best per-period Sharpe among n_trials skill-less variants."""
    if n_trials <= 1:
        return 0.0
    return math.sqrt(var_sr_period) * ((1 - _EULER) * _N.inv_cdf(1 - 1 / n_trials)
                                       + _EULER * _N.inv_cdf(1 - 1 / (n_trials * math.e)))


def dsr(r, n_trials: int, var_sr_period=None) -> float:
    """P(true Sharpe > what luck alone would produce after n_trials tries)."""
    r = np.asarray(r, dtype=float)
    floor = 1 / max(len(r) - 1, 1)                  # sampling variance of a per-period Sharpe
    var = max(var_sr_period or 0.0, floor)          # conservative: never below the floor
    return _psr_period(r, expected_max_sharpe(n_trials, var))
