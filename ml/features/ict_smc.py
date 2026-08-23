"""
ICT/SMC-style structural features not covered by liquidity_sweep.py: Fair
Value Gaps (FVG) and Order Blocks (OB). Both are inherently *stateful* — "is
there still an unfilled gap/zone from a few bars ago, and how far away is
it" requires tracking one open zone forward through time, not just detecting
where one formed — so unlike most of this pipeline's features these are
plain sequential loops rather than vectorized pandas ops. Only the single
most recent unfilled zone in each direction is tracked (not every historical
gap simultaneously) — a deliberate scope limit, not an oversight: the
question a live entry cares about is "what's the nearest one," not the full
history.

Fair Value Gap (FVG) — a 3-candle imbalance: candle 3 doesn't overlap with
candle 1 at all, meaning candle 2 displaced price so fast it left a gap in
traded prices. Bullish FVG: low[i] > high[i-2] (gap sits below current price,
often acts as support on a pullback). Bearish FVG: high[i] < low[i-2] (gap
above, often resistance). "Filled"/mitigated once price fully retraces
through the gap zone.

Order Block (OB) — the last opposite-colored candle immediately before a
displacement move that breaks recent structure. Bullish OB: the last
bearish (down-close) candle right before a big bullish bar that closes above
the recent N-bar high. Bearish OB: mirror. Requires atr_14 to already be
computed (ml/features/indicators.py) to define "big" (displacement) — run
this after compute_all(), not before.
"""
import numpy as np
import pandas as pd

FVG_LOOKBACK = 2  # 3-candle pattern: compare bar i against bar i-2
DISPLACEMENT_ATR_MULT = 1.5
STRUCTURE_LOOKBACK = 20


def add_fvg_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values("time").reset_index(drop=True).copy()
    high, low = df["high"].to_numpy(), df["low"].to_numpy()
    close = df["close"].to_numpy()
    n = len(df)

    bull_formed = np.zeros(n, dtype=bool)
    bear_formed = np.zeros(n, dtype=bool)
    bull_top = np.full(n, np.nan)
    bull_bottom = np.full(n, np.nan)
    bear_top = np.full(n, np.nan)
    bear_bottom = np.full(n, np.nan)

    for i in range(FVG_LOOKBACK, n):
        if low[i] > high[i - FVG_LOOKBACK]:
            bull_formed[i] = True
            bull_top[i], bull_bottom[i] = low[i], high[i - FVG_LOOKBACK]
        if high[i] < low[i - FVG_LOOKBACK]:
            bear_formed[i] = True
            bear_top[i], bear_bottom[i] = low[i - FVG_LOOKBACK], high[i]

    df["fvg_bullish_formed"] = bull_formed.astype(int)
    df["fvg_bearish_formed"] = bear_formed.astype(int)

    dist_bull = np.full(n, np.nan)
    bars_bull = np.full(n, np.nan)
    in_bull = np.zeros(n, dtype=int)
    dist_bear = np.full(n, np.nan)
    bars_bear = np.full(n, np.nan)
    in_bear = np.zeros(n, dtype=int)

    active_bull_top = active_bull_bottom = np.nan
    active_bull_idx = -1
    active_bear_top = active_bear_bottom = np.nan
    active_bear_idx = -1

    for i in range(n):
        if bull_formed[i]:
            active_bull_top, active_bull_bottom, active_bull_idx = bull_top[i], bull_bottom[i], i
        if bear_formed[i]:
            active_bear_top, active_bear_bottom, active_bear_idx = bear_top[i], bear_bottom[i], i

        # Fully mitigated once price trades all the way through the gap.
        if active_bull_idx >= 0 and i > active_bull_idx and low[i] <= active_bull_bottom:
            active_bull_idx = -1
        if active_bear_idx >= 0 and i > active_bear_idx and high[i] >= active_bear_top:
            active_bear_idx = -1

        if active_bull_idx >= 0:
            dist_bull[i] = close[i] - active_bull_top  # positive = still above the gap
            bars_bull[i] = i - active_bull_idx
            in_bull[i] = int(active_bull_bottom <= close[i] <= active_bull_top)
        if active_bear_idx >= 0:
            dist_bear[i] = active_bear_bottom - close[i]  # positive = still below the gap
            bars_bear[i] = i - active_bear_idx
            in_bear[i] = int(active_bear_bottom <= close[i] <= active_bear_top)

    df["dist_to_bull_fvg"] = dist_bull
    df["bars_since_bull_fvg"] = bars_bull
    df["in_bull_fvg"] = in_bull
    df["dist_to_bear_fvg"] = dist_bear
    df["bars_since_bear_fvg"] = bars_bear
    df["in_bear_fvg"] = in_bear
    return df


def add_order_block_features(df: pd.DataFrame, atr_col: str = "atr_14",
                              displacement_mult: float = DISPLACEMENT_ATR_MULT,
                              structure_lookback: int = STRUCTURE_LOOKBACK) -> pd.DataFrame:
    if atr_col not in df.columns:
        raise ValueError(f"add_order_block_features needs '{atr_col}' — run indicators.compute_all() first")
    df = df.sort_values("time").reset_index(drop=True).copy()
    high, low = df["high"].to_numpy(), df["low"].to_numpy()
    close, open_ = df["close"].to_numpy(), df["open"].to_numpy()
    atr = df[atr_col].to_numpy()
    n = len(df)

    roll_high = df["high"].rolling(structure_lookback).max().shift(1).to_numpy()
    roll_low = df["low"].rolling(structure_lookback).min().shift(1).to_numpy()

    bull_formed = np.zeros(n, dtype=bool)
    bear_formed = np.zeros(n, dtype=bool)
    bull_top = np.full(n, np.nan)
    bull_bottom = np.full(n, np.nan)
    bear_top = np.full(n, np.nan)
    bear_bottom = np.full(n, np.nan)

    for i in range(1, n):
        if np.isnan(atr[i]) or np.isnan(roll_high[i]):
            continue
        bar_range = high[i] - low[i]
        is_displacement = bar_range >= displacement_mult * atr[i]
        if not is_displacement:
            continue
        prev_bearish = close[i - 1] < open_[i - 1]
        prev_bullish = close[i - 1] > open_[i - 1]

        if close[i] > open_[i] and close[i] > roll_high[i] and prev_bearish:
            bull_formed[i] = True
            bull_top[i], bull_bottom[i] = high[i - 1], low[i - 1]
        if close[i] < open_[i] and close[i] < roll_low[i] and prev_bullish:
            bear_formed[i] = True
            bear_top[i], bear_bottom[i] = high[i - 1], low[i - 1]

    df["bull_ob_formed"] = bull_formed.astype(int)
    df["bear_ob_formed"] = bear_formed.astype(int)

    dist_bull = np.full(n, np.nan)
    bars_bull = np.full(n, np.nan)
    in_bull = np.zeros(n, dtype=int)
    dist_bear = np.full(n, np.nan)
    bars_bear = np.full(n, np.nan)
    in_bear = np.zeros(n, dtype=int)

    active_bull_top = active_bull_bottom = np.nan
    active_bull_idx = -1
    active_bear_top = active_bear_bottom = np.nan
    active_bear_idx = -1

    for i in range(n):
        if bull_formed[i]:
            active_bull_top, active_bull_bottom, active_bull_idx = bull_top[i], bull_bottom[i], i
        if bear_formed[i]:
            active_bear_top, active_bear_bottom, active_bear_idx = bear_top[i], bear_bottom[i], i

        # Mitigated once price closes back through the zone.
        if active_bull_idx >= 0 and i > active_bull_idx and low[i] <= active_bull_bottom:
            active_bull_idx = -1
        if active_bear_idx >= 0 and i > active_bear_idx and high[i] >= active_bear_top:
            active_bear_idx = -1

        if active_bull_idx >= 0:
            dist_bull[i] = close[i] - active_bull_top
            bars_bull[i] = i - active_bull_idx
            in_bull[i] = int(active_bull_bottom <= close[i] <= active_bull_top)
        if active_bear_idx >= 0:
            dist_bear[i] = active_bear_bottom - close[i]
            bars_bear[i] = i - active_bear_idx
            in_bear[i] = int(active_bear_bottom <= close[i] <= active_bear_top)

    df["dist_to_bull_ob"] = dist_bull
    df["bars_since_bull_ob"] = bars_bull
    df["in_bull_ob"] = in_bull
    df["dist_to_bear_ob"] = dist_bear
    df["bars_since_bear_ob"] = bars_bear
    df["in_bear_ob"] = in_bear
    return df


def add_ict_smc_features(df: pd.DataFrame) -> pd.DataFrame:
    """Assumes indicators.compute_all() has already run (needs atr_14)."""
    df = add_fvg_features(df)
    df = add_order_block_features(df)
    return df
