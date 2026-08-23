"""
5m-bar market-state classifier: BULLISH_DIRECTIONAL / BEARISH_DIRECTIONAL /
BALANCE, via the scoring model from the brief. Deliberately NOT requiring
textbook HH-HL/LH-LL swing structure — the four components (price vs VWAP,
EMA9 slope, recent return, impulse-count dominance) all work even when
clean swing structure hasn't formed (pre-market, Asian session), which is
exactly the brief's stated reason for avoiding a structure-based classifier.

This is pure vectorized pandas over 5m bars (causal — every component only
looks backward), with a separate join step (fabio_strategy/backtest.py)
responsible for making sure a 1m bar only ever sees a 5m state that had
actually closed by that point, using the same close-time-aligned discipline
established earlier this session for build_dataset.py's lookahead fix.
"""
import numpy as np
import pandas as pd


def compute_market_state(df5: pd.DataFrame, cfg) -> pd.DataFrame:
    """df5 must already have 'vwap' and 'ema9' columns."""
    df5 = df5.copy()
    ms = cfg.market_state

    price_above_vwap = df5["close"] > df5["vwap"]
    price_below_vwap = df5["close"] < df5["vwap"]

    ema9_slope = df5["ema9"].diff(ms.ema9_slope_lookback_bars)
    ema9_slope_positive = ema9_slope > 0
    ema9_slope_negative = ema9_slope < 0

    recent_return = df5["close"].diff(ms.return_lookback_bars)
    recent_return_positive = recent_return > 0
    recent_return_negative = recent_return < 0

    bar_dir = np.sign(df5["close"] - df5["open"])
    up_impulses = (bar_dir > 0).rolling(ms.impulse_lookback_bars).sum()
    down_impulses = (bar_dir < 0).rolling(ms.impulse_lookback_bars).sum()
    bullish_impulse_dominance = up_impulses > down_impulses
    bearish_impulse_dominance = down_impulses > up_impulses

    bull_score = (price_above_vwap.astype(int) + ema9_slope_positive.astype(int)
                  + recent_return_positive.astype(int) + bullish_impulse_dominance.astype(int))
    bear_score = (price_below_vwap.astype(int) + ema9_slope_negative.astype(int)
                  + recent_return_negative.astype(int) + bearish_impulse_dominance.astype(int))

    state = pd.Series("BALANCE", index=df5.index, dtype=object)
    is_bull = bull_score >= ms.directional_score_threshold
    is_bear = bear_score >= ms.directional_score_threshold
    state[is_bull & ~is_bear] = "BULLISH_DIRECTIONAL"
    state[is_bear & ~is_bull] = "BEARISH_DIRECTIONAL"
    both = is_bull & is_bear  # shouldn't happen given the mutually-exclusive components, but guard anyway
    state[both & (bull_score >= bear_score)] = "BULLISH_DIRECTIONAL"
    state[both & (bear_score > bull_score)] = "BEARISH_DIRECTIONAL"

    df5["bull_score"] = bull_score
    df5["bear_score"] = bear_score
    df5["raw_market_state"] = state
    return df5
