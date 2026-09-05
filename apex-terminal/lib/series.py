#!/usr/bin/env python3
"""Series math shared by the panels. Pure functions over lists of closes."""
import math

TRADING_DAYS = 252
# Calendar windows expressed in trading days, the resolution the series has.
WINDOW = {"1D": 1, "1W": 5, "1M": 21, "3M": 63}


def pct_change(closes, lookback):
    """Percent change over `lookback` bars, or None without the history."""
    if not closes or len(closes) <= lookback:
        return None
    prev = closes[-1 - lookback]
    if not prev:
        return None
    return (closes[-1] / prev - 1.0) * 100.0


def sma(closes, window):
    if len(closes) < window:
        return None
    return sum(closes[-window:]) / window


def above_sma(closes, window):
    m = sma(closes, window)
    if m is None or not closes:
        return None
    return closes[-1] > m


def sparkline(closes, points=32):
    """Evenly-spaced sample of the last ~3 months, for the card sparklines."""
    tail = closes[-63:] if len(closes) > 63 else closes[:]
    if len(tail) <= points:
        return [round(c, 4) for c in tail]
    step = (len(tail) - 1) / (points - 1)
    return [round(tail[int(round(i * step))], 4) for i in range(points)]


def ratio_series(a_closes, b_closes):
    """Element-wise ratio over the overlapping tail of two series."""
    n = min(len(a_closes), len(b_closes))
    if n == 0:
        return []
    return [a_closes[-n + i] / b_closes[-n + i] for i in range(n) if b_closes[-n + i]]


def daily_returns(closes):
    out = []
    for i in range(1, len(closes)):
        prev = closes[i - 1]
        out.append(closes[i] / prev - 1.0 if prev else 0.0)
    return out


def max_drawdown_pct(equity):
    """Most negative peak-to-trough move, as a negative percent."""
    if not equity:
        return None
    peak, worst = equity[0], 0.0
    for v in equity:
        peak = max(peak, v)
        if peak:
            worst = min(worst, v / peak - 1.0)
    return worst * 100.0


def cagr_pct(equity, n_days):
    if not equity or n_days <= 0 or equity[0] <= 0:
        return None
    years = n_days / TRADING_DAYS
    if years <= 0:
        return None
    return ((equity[-1] / equity[0]) ** (1.0 / years) - 1.0) * 100.0


def sharpe(returns, rf_annual=0.0):
    """Annualised Sharpe from daily returns, excess of a flat annual rate."""
    if len(returns) < 2:
        return None
    rf_daily = rf_annual / TRADING_DAYS
    excess = [r - rf_daily for r in returns]
    mean = sum(excess) / len(excess)
    var = sum((r - mean) ** 2 for r in excess) / (len(excess) - 1)
    sd = math.sqrt(var)
    if sd == 0:
        return None
    return (mean / sd) * math.sqrt(TRADING_DAYS)


def correlation(a, b):
    n = min(len(a), len(b))
    if n < 2:
        return None
    a, b = a[-n:], b[-n:]
    ma, mb = sum(a) / n, sum(b) / n
    cov = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((x - mb) ** 2 for x in b)
    if va <= 0 or vb <= 0:
        return None
    return cov / math.sqrt(va * vb)


def percentile_rank(values, value):
    """Where `value` sits within `values`, 0-100."""
    if not values or value is None:
        return None
    below = sum(1 for v in values if v <= value)
    return below / len(values) * 100.0
