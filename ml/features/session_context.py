"""
Trading-session and macro-event-timing features, driven by ml/config/sessions.json.

Covers: which named session (Asian futures/cash, London, NY pre-market/open) each
bar falls in, minutes since that session's open (cyclical + linear), day-of-week,
and proximity to recurring macro-release timing (08:30 ET most US data releases,
NFP's first-Friday rule) plus a manually-maintained FOMC date list.

See ml/config/sessions.json's _fomc_note: fomc_dates ships empty since meeting
dates are irregular and must come from the official Fed calendar, not a guess —
until it's populated, fomc_proximity features stay at their neutral/no-signal value.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

from .indicators import ET, _et_index

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "sessions.json"


def load_sessions_config() -> dict:
    return json.loads(CONFIG_PATH.read_text())


def _parse_hm(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def _in_window(tod_min: pd.Series, start_min: int, end_min: int) -> pd.Series:
    if start_min <= end_min:
        return (tod_min >= start_min) & (tod_min <= end_min)
    return (tod_min >= start_min) | (tod_min <= end_min)  # wraps past midnight


def _minutes_since(tod_min: pd.Series, start_min: int) -> pd.Series:
    return (tod_min - start_min) % 1440


def _cyclical(series: pd.Series, period: int, name: str, df: pd.DataFrame):
    df[f"{name}_sin"] = np.sin(2 * np.pi * series / period)
    df[f"{name}_cos"] = np.cos(2 * np.pi * series / period)


def add_session_context(df: pd.DataFrame, config: dict | None = None) -> pd.DataFrame:
    config = config or load_sessions_config()
    df = df.sort_values("time").reset_index(drop=True).copy()

    et = _et_index(df)
    tod_min = (et.dt.hour * 60 + et.dt.minute).astype(int)
    dow = et.dt.dayofweek  # Monday=0 .. Sunday=6

    df["tod_minutes_et"] = tod_min
    df["day_of_week"] = dow
    _cyclical(tod_min, 1440, "tod", df)
    _cyclical(dow, 7, "dow", df)

    for name, window in config["sessions"].items():
        start_min = _parse_hm(window["start"])
        end_min = _parse_hm(window["end"])
        df[f"in_{name}"] = _in_window(tod_min, start_min, end_min).astype(int)
        df[f"minutes_since_{name}_open"] = _minutes_since(tod_min, start_min)

    macro_min = _parse_hm(config["macro_slot_et"])
    dist_to_macro = (tod_min - macro_min).abs()
    dist_to_macro = np.minimum(dist_to_macro, 1440 - dist_to_macro)  # shortest distance around the clock
    df["minutes_from_macro_slot"] = dist_to_macro
    df["near_macro_slot"] = (dist_to_macro <= 15).astype(int)

    et_date = et.dt.date
    is_friday = dow == 4
    day_of_month = et.dt.day
    is_first_friday = is_friday & (day_of_month <= 7)
    df["is_nfp_day"] = (is_first_friday & (dist_to_macro <= 15)).astype(int)

    fomc_dates = set(pd.to_datetime(d).date() for d in config.get("fomc_dates", []))
    if fomc_dates:
        df["is_fomc_day"] = et_date.isin(fomc_dates).astype(int)
        days_to_next = et_date.map(lambda d: min((f - d).days for f in fomc_dates if f >= d), na_action="ignore")
        df["days_to_next_fomc"] = days_to_next.fillna(999)
    else:
        df["is_fomc_day"] = 0
        df["days_to_next_fomc"] = 999  # no dates configured — neutral sentinel, see sessions.json _fomc_note

    return df
