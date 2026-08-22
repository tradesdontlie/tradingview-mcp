"""
ICT-style liquidity-sweep features: "did price just wick through a prior
high/low and close back inside it" (a stop-run / liquidity grab, often followed
by reversal), plus "how long ago did that happen."

Ported from the discretionary logic in strategies/mnq_1m_liq_sweep.pine (which
watches the 04:00-09:29 ET pre-market range and fades a wick-through-and-close-back
during the 09:30-10:29 ET window), generalized to run on every bar across any
timeframe/session rather than only that one narrow strategy window, and extended
with prior-day and rolling-structural reference levels so the model has more than
one notion of "prior high/low" to work with.

Reference levels computed:
  - pm_high / pm_low        — pre-market (04:00-09:29 ET) range, frozen for the
                               rest of the session once the window closes.
  - prior_day_high / _low   — full-session high/low of the *previous* completed
                               session (session boundary = 18:00 ET, matching
                               indicators.add_session_vwap's session_id).
  - roll_high_N / roll_low_N — rolling N-bar structural high/low (excludes the
                               current bar, so it's a genuinely "prior" level).

For each reference level, a sweep is: high wicks above the level and closes back
below it (swept_high — a liquidity grab of highs, often bearish), or the mirror
for lows (swept_low — often bullish). "Swept recently" flags + bars-since-sweep
give the model a sense of how fresh the event is.
"""
import numpy as np
import pandas as pd

from .indicators import ET, _et_index

DEFAULT_SESSION_START_HOUR = 18
PREMARKET_START = 4 * 60       # 04:00 ET, minutes from midnight
PREMARKET_END = 9 * 60 + 29    # 09:29 ET


def _session_id(df: pd.DataFrame, session_start_hour: int = DEFAULT_SESSION_START_HOUR) -> pd.Series:
    et = _et_index(df)
    return (et - pd.Timedelta(hours=session_start_hour)).dt.floor("D")


def add_premarket_levels(df: pd.DataFrame, session_id: pd.Series) -> pd.DataFrame:
    et = _et_index(df)
    tod = et.dt.hour * 60 + et.dt.minute
    premarket_mask = (tod >= PREMARKET_START) & (tod <= PREMARKET_END)

    pm_high = df["high"].where(premarket_mask)
    pm_low = df["low"].where(premarket_mask)

    df["pm_high"] = pm_high.groupby(session_id).cummax()
    df["pm_low"] = pm_low.groupby(session_id).cummin()
    df["pm_high"] = df.groupby(session_id)["pm_high"].ffill()
    df["pm_low"] = df.groupby(session_id)["pm_low"].ffill()
    return df


def add_prior_day_levels(df: pd.DataFrame, session_id: pd.Series) -> pd.DataFrame:
    tmp = df.assign(_sid=session_id)
    extremes = tmp.groupby("_sid").agg(day_high=("high", "max"), day_low=("low", "min")).reset_index()
    extremes = extremes.sort_values("_sid")
    extremes["prior_day_high"] = extremes["day_high"].shift(1)
    extremes["prior_day_low"] = extremes["day_low"].shift(1)
    merged = tmp.merge(extremes[["_sid", "prior_day_high", "prior_day_low"]], on="_sid", how="left")
    df["prior_day_high"] = merged["prior_day_high"].values
    df["prior_day_low"] = merged["prior_day_low"].values
    return df


def add_rolling_levels(df: pd.DataFrame, period: int = 20) -> pd.DataFrame:
    df[f"roll_high_{period}"] = df["high"].rolling(period).max().shift(1)
    df[f"roll_low_{period}"] = df["low"].rolling(period).min().shift(1)
    return df


def _bars_since_true(event: pd.Series, session_id: pd.Series) -> pd.Series:
    idx = pd.Series(np.arange(len(event)), index=event.index)
    last_true_idx = idx.where(event).groupby(session_id).ffill()
    bars_since = idx - last_true_idx
    return bars_since  # NaN until first occurrence within the session


def detect_sweep(df: pd.DataFrame, level_high_col: str, level_low_col: str,
                  prefix: str, session_id: pd.Series) -> pd.DataFrame:
    swept_high = (df["high"] > df[level_high_col]) & (df["close"] < df[level_high_col])
    swept_low = (df["low"] < df[level_low_col]) & (df["close"] > df[level_low_col])

    df[f"{prefix}_swept_high"] = swept_high.astype(int)
    df[f"{prefix}_swept_low"] = swept_low.astype(int)

    bars_since_high = _bars_since_true(swept_high, session_id)
    bars_since_low = _bars_since_true(swept_low, session_id)
    df[f"{prefix}_bars_since_swept_high"] = bars_since_high
    df[f"{prefix}_bars_since_swept_low"] = bars_since_low
    df[f"{prefix}_swept_high_recently"] = (bars_since_high.fillna(9999) <= 5).astype(int)
    df[f"{prefix}_swept_low_recently"] = (bars_since_low.fillna(9999) <= 5).astype(int)
    return df


def add_liquidity_sweep_features(df: pd.DataFrame, session_start_hour: int = DEFAULT_SESSION_START_HOUR,
                                  rolling_period: int = 20) -> pd.DataFrame:
    df = df.sort_values("time").reset_index(drop=True).copy()
    session_id = _session_id(df, session_start_hour)

    add_premarket_levels(df, session_id)
    add_prior_day_levels(df, session_id)
    add_rolling_levels(df, period=rolling_period)

    detect_sweep(df, "pm_high", "pm_low", "premarket", session_id)
    detect_sweep(df, "prior_day_high", "prior_day_low", "prior_day", session_id)
    detect_sweep(df, f"roll_high_{rolling_period}", f"roll_low_{rolling_period}", "structural", session_id)
    return df
