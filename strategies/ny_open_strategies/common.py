"""
Shared data loading, indicators, and trade-management machinery for the
NY-session strategy family. The partial/runner/breakeven trade management
here mirrors strategies/asian_failed_breakout/engine.py's OpenTrade handling
(same blended-PnL logic) but is kept standalone rather than imported, since
these strategies aren't otherwise coupled to that module's Asian-specific
SetupLogRecord.
"""
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

RAW_DIR = Path.home() / "data" / "ml-raw"
SYMBOLS_CONFIG = Path(__file__).resolve().parent.parent.parent / "ml" / "config" / "symbols.json"
OUT_DIR = Path.home() / "data" / "ny-strategy-backtests"
ET = "America/New_York"

NY_SESSION_START_MIN = 9 * 60 + 30
NY_SESSION_END_MIN = 16 * 60
ASIAN_SESSION_START_MIN = 18 * 60  # wraps past midnight — matches sessions.json / asian_failed_breakout's convention
ASIAN_SESSION_END_MIN = 2 * 60

SESSION_WINDOWS = {
    "ny": (NY_SESSION_START_MIN, NY_SESSION_END_MIN),
    "asian": (ASIAN_SESSION_START_MIN, ASIAN_SESSION_END_MIN),
}


def _in_window(tod_min, start_min: int, end_min: int):
    if start_min <= end_min:
        return (tod_min >= start_min) & (tod_min < end_min)
    return (tod_min >= start_min) | (tod_min < end_min)  # wraps past midnight


def _session_group_id(et: pd.Series, session: str) -> pd.Series:
    """Grouping key for "which occurrence of this session does this bar
    belong to" — plain calendar date works for NY (never crosses midnight),
    but Asian (18:00-02:00 ET) needs the same 18:00 Globex-day rollover used
    throughout strategies/asian_failed_breakout, or a session that starts at
    23:50 and one that starts at 00:10 the same real trading session would
    get split into two different groups."""
    if session == "asian":
        return (et - pd.Timedelta(hours=18)).dt.floor("D")
    return et.dt.date


def load_point_value(symbol: str) -> float:
    all_cfg = json.loads(SYMBOLS_CONFIG.read_text())
    return all_cfg.get(symbol, {}).get("point_value", 1.0)


def load_1m_bars(symbol: str, days: Optional[int] = None, no_trade_minutes: int = 15,
                  orb_minutes: int = 15, session: str = "ny") -> pd.DataFrame:
    stem = symbol.replace(":", "_").replace("!", "")
    path = RAW_DIR / f"{stem}_1.parquet"
    if not path.exists():
        raise FileNotFoundError(f"No raw 1m data at {path} — run ml/data_collection/collect_replay.py first.")
    df = pd.read_parquet(path).sort_values("time").reset_index(drop=True)
    if days is not None:
        cutoff = int(df["time"].max()) - days * 86400
        df = df[df["time"] >= cutoff].reset_index(drop=True)

    df["et"] = pd.to_datetime(df["time"], unit="s", utc=True).dt.tz_convert(ET)
    df["tod_min"] = df["et"].dt.hour * 60 + df["et"].dt.minute
    df["calendar_date"] = df["et"].dt.date
    df["ema9"] = df["close"].ewm(span=9, adjust=False).mean()

    add_session_vwap(df)
    add_session_window(df, session, no_trade_minutes)
    add_opening_range(df, session, orb_minutes)
    return df


def add_session_vwap(df: pd.DataFrame, session_start_hour: int = 18) -> pd.DataFrame:
    """Session-anchored cumulative VWAP + volume-weighted std, same formula
    as ml/features/indicators.py's add_session_vwap — reimplemented locally
    (not imported) so this strategies/ package has no dependency on ml/."""
    session_id = (df["et"] - pd.Timedelta(hours=session_start_hour)).dt.floor("D")
    typical = (df["high"] + df["low"] + df["close"]) / 3
    tp_vol = typical * df["volume"]
    cum_vol = df.groupby(session_id.values)["volume"].cumsum()
    cum_tp_vol = tp_vol.groupby(session_id.values).cumsum()
    vwap = cum_tp_vol / cum_vol.replace(0, np.nan)
    sq_dev = ((typical - vwap) ** 2) * df["volume"]
    cum_sq_dev = sq_dev.groupby(session_id.values).cumsum()
    variance = cum_sq_dev / cum_vol.replace(0, np.nan)
    std = np.sqrt(variance)
    df["vwap"] = vwap
    df["vwap_std"] = std
    df["dist_from_vwap_sigma"] = (df["close"] - vwap) / std.replace(0, np.nan)
    return df


def add_session_window(df: pd.DataFrame, session: str, no_trade_minutes: int) -> pd.DataFrame:
    """Generic replacement for the old NY-only add_ny_windows — same
    semantics, parametrized by session ("ny" or "asian") so the same
    strategy code can be evaluated in either session. `tradeable`/
    `in_session` are the generic column names; `ny_tradeable`/`in_ny_session`
    are also written for backward compatibility with any code still reading
    the old NY-specific names, but only carry real values when session="ny"
    (they're just aliases, not computed independently)."""
    start_min, end_min = SESSION_WINDOWS[session]
    tod = df["tod_min"]
    in_session = _in_window(tod, start_min, end_min)
    minutes_since_open = (tod - start_min) % 1440
    in_no_trade_window = in_session & (minutes_since_open < no_trade_minutes)
    # The one flag every strategy in this family gates entries on: inside
    # the session but past the first `no_trade_minutes` — too volatile to
    # trade right at the open, per the explicit instruction this whole
    # family was built under (applied to both sessions for consistency).
    tradeable = in_session & (~in_no_trade_window)
    df["in_session"] = in_session
    df["in_no_trade_window"] = in_no_trade_window
    df["tradeable"] = tradeable
    if session == "ny":
        df["in_ny_session"] = in_session
        df["in_ny_no_trade_window"] = in_no_trade_window
        df["ny_tradeable"] = tradeable
    return df


def add_opening_range(df: pd.DataFrame, session: str, orb_minutes: int) -> pd.DataFrame:
    """High/low of the first `orb_minutes` after the session opens, per
    occurrence of that session (see _session_group_id): NaN before the range
    starts, tracking (cummax/cummin) during it, then explicitly forward-
    filled to stay frozen at the final value for the rest of the session —
    groupby().cummax() does NOT carry a value forward through NaN rows on
    its own (verified directly: it leaves them NaN), despite plain
    Series.cummax()'s skipna behavior suggesting otherwise, so the ffill()
    here isn't redundant."""
    start_min, _ = SESSION_WINDOWS[session]
    minutes_since_open = (df["tod_min"] - start_min) % 1440
    in_range_window = minutes_since_open < orb_minutes
    grp = _session_group_id(df["et"], session)
    df["orb_high"] = df["high"].where(in_range_window).groupby(grp).cummax().groupby(grp).ffill()
    df["orb_low"] = df["low"].where(in_range_window).groupby(grp).cummin().groupby(grp).ffill()
    df["orb_formed"] = minutes_since_open >= orb_minutes
    return df


@dataclass
class RiskParams:
    stop_buffer_points: float = 0.2
    max_risk_points: float = 6.0
    target_r_multiple: float = 2.0
    partial_r_multiple: float = 1.0
    partial_fraction: float = 0.5
    move_stop_to_breakeven_after_partial: bool = True


@dataclass
class TradeLogRecord:
    strategy: str
    symbol: str
    direction: str
    signal_time: int
    entry_price: Optional[float] = None
    entry_time: Optional[int] = None
    stop_price: Optional[float] = None
    target_price: Optional[float] = None
    exit_price: Optional[float] = None
    exit_time: Optional[int] = None
    risk_distance: Optional[float] = None
    pnl_points: Optional[float] = None
    pnl_dollars: Optional[float] = None
    r_multiple: Optional[float] = None
    status: str = "PENDING"
    reject_reason: Optional[str] = None
    note: Optional[str] = None


@dataclass
class OpenTrade:
    direction: str
    entry_price: float
    entry_time: int
    stop_price: float
    initial_risk: float
    partial_target_price: float
    final_target_price: float
    record: TradeLogRecord
    partial_taken: bool = False
    remaining_fraction: float = 1.0
    realized_pnl_points: float = 0.0


def blended_pnl(trade: OpenTrade, final_price: float) -> float:
    is_long = trade.direction == "long"
    full_leg = (final_price - trade.entry_price) if is_long else (trade.entry_price - final_price)
    if not trade.partial_taken:
        return full_leg
    return trade.realized_pnl_points + trade.remaining_fraction * full_leg


def _finalize(trade: OpenTrade, price: float, ts: int, point_value: float, status: str) -> TradeLogRecord:
    total = blended_pnl(trade, price)
    rec = trade.record
    rec.exit_price = price
    rec.exit_time = ts
    rec.pnl_points = total
    rec.pnl_dollars = total * point_value
    rec.r_multiple = total / trade.initial_risk if trade.initial_risk else None
    rec.status = status
    return rec


def update_open_trade(trade: OpenTrade, bar: dict, risk: RiskParams, point_value: float) -> Optional[TradeLogRecord]:
    """Same-bar stop+target ambiguity resolves to stop-first (conservative),
    matching ml/labels/triple_barrier.py's convention."""
    is_long = trade.direction == "long"
    if not trade.partial_taken:
        stop_hit = bar["low"] <= trade.stop_price if is_long else bar["high"] >= trade.stop_price
        target_hit = bar["high"] >= trade.partial_target_price if is_long else bar["low"] <= trade.partial_target_price
        if stop_hit:
            return _finalize(trade, trade.stop_price, bar["time"], point_value, "FILLED")
        if target_hit:
            trade.partial_taken = True
            trade.remaining_fraction = 1.0 - risk.partial_fraction
            trade.realized_pnl_points = risk.partial_fraction * abs(trade.partial_target_price - trade.entry_price)
            if risk.move_stop_to_breakeven_after_partial:
                trade.stop_price = trade.entry_price
            return None
    else:
        stop_hit = bar["low"] <= trade.stop_price if is_long else bar["high"] >= trade.stop_price
        target_hit = bar["high"] >= trade.final_target_price if is_long else bar["low"] <= trade.final_target_price
        if stop_hit:
            return _finalize(trade, trade.stop_price, bar["time"], point_value, "FILLED")
        if target_hit:
            return _finalize(trade, trade.final_target_price, bar["time"], point_value, "FILLED")
    return None


def force_close(trade: OpenTrade, last_bar: dict, point_value: float) -> TradeLogRecord:
    return _finalize(trade, last_bar["close"], last_bar["time"], point_value, "OPEN_AT_BACKTEST_END")


def summarize(records: list[TradeLogRecord]) -> dict:
    if not records:
        return {"n_signals": 0}
    df = pd.DataFrame([r.__dict__ for r in records])
    status_counts = df["status"].value_counts().to_dict()
    reason_counts = df["reject_reason"].dropna().value_counts().to_dict()
    filled = df[df["status"].isin(["FILLED", "OPEN_AT_BACKTEST_END"])]
    out = {"n_signals": len(df), "status_counts": status_counts, "reject_reasons": reason_counts,
           "n_trades_filled": len(filled)}
    if len(filled):
        wins = filled[filled["pnl_points"] > 0]
        gross_profit = filled.loc[filled["pnl_dollars"] > 0, "pnl_dollars"].sum()
        gross_loss = -filled.loc[filled["pnl_dollars"] < 0, "pnl_dollars"].sum()
        out.update({
            "win_rate": float(len(wins) / len(filled)),
            "total_pnl_dollars": float(filled["pnl_dollars"].sum()),
            "avg_r_multiple": float(filled["r_multiple"].mean()),
            "profit_factor": float(gross_profit / gross_loss) if gross_loss > 0 else None,
            "by_direction": filled.groupby("direction")["pnl_dollars"].agg(["count", "sum", "mean"]).to_dict("index"),
        })
    return out


def write_csv(records: list[TradeLogRecord], symbol: str, strategy_name: str) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stem = symbol.replace(":", "_").replace("!", "")
    path = OUT_DIR / f"{stem}_{strategy_name}.csv"
    rows = [r.__dict__ for r in records]
    df = pd.DataFrame(rows)
    if not df.empty:
        for col in ("signal_time", "entry_time", "exit_time"):
            if col in df.columns:
                df[col.replace("time", "et")] = pd.to_datetime(df[col], unit="s", utc=True).dt.tz_convert(ET)
        df = df.sort_values("signal_time").reset_index(drop=True)
    df.to_csv(path, index=False)
    return path
