"""
Standard technical indicators computed locally from raw OHLCV, in pandas.

There's no historical indicator-series API over CDP (data_get_study_values only
exposes the *current* value), so every indicator here is recomputed from the raw
bars collected by data_collection/collect_replay.py rather than read off the chart.

VWAP follows the session-anchored approach already used in
strategies/mgc_vwap_reversion.py / strategies/mgc_vwap_asian.py: cumulative
volume-weighted typical price, reset at each session boundary, with
volume-weighted standard-deviation bands.

All functions take/return a DataFrame with at least
['time','open','high','low','close','volume'], time = unix seconds (UTC),
and add columns in place (also returned for chaining).
"""
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

ET = ZoneInfo("America/New_York")


def _et_index(df: pd.DataFrame) -> pd.DatetimeIndex:
    return pd.to_datetime(df["time"], unit="s", utc=True).dt.tz_convert(ET)


def add_rsi(df: pd.DataFrame, period: int = 14, col: str = "close") -> pd.DataFrame:
    delta = df[col].diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    df[f"rsi_{period}"] = 100 - (100 / (1 + rs))
    return df


def add_macd(df: pd.DataFrame, fast: int = 12, slow: int = 26, signal: int = 9, col: str = "close") -> pd.DataFrame:
    ema_fast = df[col].ewm(span=fast, adjust=False).mean()
    ema_slow = df[col].ewm(span=slow, adjust=False).mean()
    macd = ema_fast - ema_slow
    macd_signal = macd.ewm(span=signal, adjust=False).mean()
    df["macd"] = macd
    df["macd_signal"] = macd_signal
    df["macd_hist"] = macd - macd_signal
    return df


def add_bollinger(df: pd.DataFrame, period: int = 20, num_std: float = 2.0, col: str = "close") -> pd.DataFrame:
    mid = df[col].rolling(period).mean()
    std = df[col].rolling(period).std()
    df[f"bb_mid_{period}"] = mid
    df[f"bb_upper_{period}"] = mid + num_std * std
    df[f"bb_lower_{period}"] = mid - num_std * std
    df[f"bb_width_{period}"] = (df[f"bb_upper_{period}"] - df[f"bb_lower_{period}"]) / mid
    df[f"bb_pctb_{period}"] = (df[col] - df[f"bb_lower_{period}"]) / (df[f"bb_upper_{period}"] - df[f"bb_lower_{period}"])
    return df


def add_atr(df: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    prev_close = df["close"].shift(1)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev_close).abs(),
        (df["low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    df[f"atr_{period}"] = tr.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    return df


def add_session_vwap(df: pd.DataFrame, session_start_hour: int = 18) -> pd.DataFrame:
    """Session-anchored VWAP + volume-weighted std bands.

    Session id increments at `session_start_hour` ET (default 18:00, matching the
    CME Globex day rollover used in mgc_vwap_reversion.py's session_date()).
    """
    et = _et_index(df)
    session_id = (et - pd.Timedelta(hours=session_start_hour)).dt.floor("D")

    typical = (df["high"] + df["low"] + df["close"]) / 3
    tp_vol = typical * df["volume"]

    grp = df.groupby(session_id.values)
    cum_vol = grp["volume"].cumsum()
    cum_tp_vol = tp_vol.groupby(session_id.values).cumsum()
    vwap = cum_tp_vol / cum_vol.replace(0, np.nan)

    sq_dev = ((typical - vwap) ** 2) * df["volume"]
    cum_sq_dev = sq_dev.groupby(session_id.values).cumsum()
    variance = cum_sq_dev / cum_vol.replace(0, np.nan)
    std = np.sqrt(variance)

    df["session_id"] = session_id.values
    df["vwap"] = vwap
    df["vwap_std"] = std
    df["vwap_upper1"] = vwap + std
    df["vwap_lower1"] = vwap - std
    df["vwap_upper2"] = vwap + 2 * std
    df["vwap_lower2"] = vwap - 2 * std
    df["dist_from_vwap"] = df["close"] - vwap
    df["dist_from_vwap_sigma"] = df["dist_from_vwap"] / std.replace(0, np.nan)
    return df


def compute_all(df: pd.DataFrame, rsi_period: int = 14, macd=(12, 26, 9), bb_period: int = 20,
                 atr_period: int = 14, vwap_session_start_hour: int = 18) -> pd.DataFrame:
    df = df.sort_values("time").reset_index(drop=True).copy()
    add_rsi(df, period=rsi_period)
    add_macd(df, *macd)
    add_bollinger(df, period=bb_period)
    add_atr(df, period=atr_period)
    add_session_vwap(df, session_start_hour=vwap_session_start_hour)
    return df
