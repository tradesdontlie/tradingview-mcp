"""
Session range levels (Asian/London high-low, midnight open) and whether NY
session bars sweep them — a session-level generalization of the premarket/
prior-day sweep logic in liquidity_sweep.py, since Asian and London ranges
are reference levels ICT-style NY session trading watches for specifically.

Asian range: 18:00-00:00 ET (the evening portion of the Globex session
defined in sessions.json's asian_futures window — the part that's within a
single calendar day, so no midnight-wraparound handling needed for the range
itself). London range: 03:00-08:00 ET, matching sessions.json's london_open
(the London morning session through the NY pre-market handoff, not the full
London trading day).
Both frozen once their window closes, same pattern as premarket_high/low.

Midnight open: the open price of the bar at 00:00 ET — a distinct ICT
reference level from either range, anchored to the calendar day rather than
the 18:00 Globex session boundary everything else here uses.
"""
import pandas as pd

from .indicators import _et_index
from .liquidity_sweep import _session_id, detect_sweep

ASIAN_RANGE_START_MIN = 18 * 60       # 18:00 ET
LONDON_RANGE_START_MIN = 3 * 60       # 03:00 ET
LONDON_RANGE_END_MIN = 8 * 60         # 08:00 ET
NY_SESSION_START_MIN = 9 * 60 + 30    # 09:30 ET
NY_SESSION_END_MIN = 16 * 60          # 16:00 ET


def _add_range_levels(df: pd.DataFrame, session_id: pd.Series, mask: pd.Series, prefix: str) -> pd.DataFrame:
    high = df["high"].where(mask)
    low = df["low"].where(mask)
    df[f"{prefix}_high"] = high.groupby(session_id).cummax()
    df[f"{prefix}_low"] = low.groupby(session_id).cummin()
    df[f"{prefix}_high"] = df.groupby(session_id)[f"{prefix}_high"].ffill()
    df[f"{prefix}_low"] = df.groupby(session_id)[f"{prefix}_low"].ffill()
    return df


def add_midnight_open(df: pd.DataFrame) -> pd.DataFrame:
    et = _et_index(df)
    tod = et.dt.hour * 60 + et.dt.minute
    calendar_date = et.dt.floor("D")
    midnight_open = df["open"].where(tod == 0)
    # Only one bar per date has tod==0 (1m data) — propagate it to every row
    # in that calendar date, both directions, since ffill alone would leave
    # the pre-midnight rows of the *first* date in the dataset unset anyway
    # (nothing wrong with that — NaN there just means "unknown," correctly).
    df["midnight_open"] = midnight_open.groupby(calendar_date).transform(lambda s: s.ffill().bfill())
    df["dist_from_midnight_open"] = df["close"] - df["midnight_open"]
    return df


def add_session_levels(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values("time").reset_index(drop=True).copy()
    session_id = _session_id(df)  # 18:00 ET boundary, matching indicators/liquidity_sweep
    et = _et_index(df)
    tod = et.dt.hour * 60 + et.dt.minute

    asian_mask = tod >= ASIAN_RANGE_START_MIN
    london_mask = (tod >= LONDON_RANGE_START_MIN) & (tod < LONDON_RANGE_END_MIN)

    _add_range_levels(df, session_id, asian_mask, "asian_range")
    _add_range_levels(df, session_id, london_mask, "london_range")
    add_midnight_open(df)

    detect_sweep(df, "asian_range_high", "asian_range_low", "asian_range", session_id)
    detect_sweep(df, "london_range_high", "london_range_low", "london_range", session_id)

    in_ny_session = (tod >= NY_SESSION_START_MIN) & (tod < NY_SESSION_END_MIN)
    df["in_ny_session_window"] = in_ny_session.astype(int)
    for prefix in ("asian_range", "london_range"):
        for side in ("high", "low"):
            df[f"{prefix}_{side}_swept_in_ny"] = (df[f"{prefix}_swept_{side}"].astype(bool) & in_ny_session).astype(int)

    return df
