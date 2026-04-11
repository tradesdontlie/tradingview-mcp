#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

import pandas as pd

from kite_api import (
    DEFAULT_ENV_FILES,
    get_historical_candles,
    get_order_charges,
    get_quotes,
    load_env_files,
    require_env,
    write_json,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STRATEGY_CONFIG = REPO_ROOT / "config" / "live_paper_strategy.json"
DEFAULT_RAW_DIR = REPO_ROOT / "market" / "raw" / "kite"
DEFAULT_REFERENCE = DEFAULT_RAW_DIR / "reference" / "index_reference.csv"
DEFAULT_INSTRUMENTS = DEFAULT_RAW_DIR / "reference" / "instruments_latest.csv"
DEFAULT_OPTION_CACHE = DEFAULT_RAW_DIR / "options"
DEFAULT_JOURNAL_DIR = REPO_ROOT / "market" / "paper_trades_kite"
DEFAULT_PROXY_15M = DEFAULT_RAW_DIR / "NIFTYBEES_15minute.parquet"

SYMBOLS = {
    "NIFTY": {
        "quote_symbol": "NSE:NIFTY 50",
        "nse_symbol": "NIFTY",
        "fallback_lot_size": 65,
        "default_threshold": 0.0040,
        "default_gap_align": False,
    },
    "BANKNIFTY": {
        "quote_symbol": "NSE:NIFTY BANK",
        "nse_symbol": "BANKNIFTY",
        "fallback_lot_size": 30,
        "default_threshold": 0.0035,
        "default_gap_align": False,
    },
}


@dataclass(frozen=True)
class SessionSpec:
    symbol: str
    threshold: float
    gap_align: bool
    signal_bar_index: int
    instrument_mode: str
    expiry_offset: int
    latest_entry_time: str
    hard_exit_time: str | None
    use_proxy_vwap: bool
    companion_spread_width_points: int | None


def archive_caution_flags(session_day: pd.Timestamp, signal_ret: float) -> list[str]:
    cautions: list[str] = []
    if abs(float(signal_ret)) >= 0.01:
        cautions.append("extreme_signal_day_archive_eod_weakness")
    if pd.Timestamp(session_day).day_name() == "Tuesday":
        cautions.append("tuesday_archive_slice_weakness")
    return cautions


def load_strategy_config(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, dict) else {}
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON in strategy config: {path}") from exc


def resolve_symbol_defaults(symbol: str, strategy_config: dict) -> dict:
    shared = strategy_config.get("shared", {}) if isinstance(strategy_config, dict) else {}
    symbols = strategy_config.get("symbols", {}) if isinstance(strategy_config, dict) else {}
    symbol_defaults = symbols.get(symbol, {}) if isinstance(symbols, dict) else {}
    merged = dict(SYMBOLS[symbol])
    if isinstance(symbol_defaults, dict):
        merged.update({k: v for k, v in symbol_defaults.items() if v is not None})
    merged["signal_bar_index"] = int(symbol_defaults.get("signal_bar_index", shared.get("signal_bar_index", 15)))
    merged["instrument_mode"] = str(symbol_defaults.get("instrument_mode", shared.get("instrument_mode", "atm_option")))
    merged["expiry_offset"] = int(symbol_defaults.get("expiry_offset", shared.get("expiry_offset", 0)))
    latest_entry_time = symbol_defaults.get("latest_entry_time", shared.get("latest_entry_time", "14:45:00"))
    merged["latest_entry_time"] = str(latest_entry_time)
    hard_exit_time = symbol_defaults.get("hard_exit_time", shared.get("hard_exit_time"))
    merged["hard_exit_time"] = None if hard_exit_time in {None, "", "null"} else str(hard_exit_time)
    merged["use_proxy_vwap"] = bool(symbol_defaults.get("use_proxy_vwap", shared.get("use_proxy_vwap", False)))
    spread_width = symbol_defaults.get("companion_spread_width_points")
    merged["companion_spread_width_points"] = None if spread_width in {None, "", 0} else int(spread_width)
    return merged


def load_daily_cache(symbol_name: str) -> pd.DataFrame:
    path = DEFAULT_RAW_DIR / f"{symbol_name}_daily.parquet"
    if not path.exists():
        raise RuntimeError(f"Missing Kite daily cache for {symbol_name}: {path}")
    frame = pd.read_parquet(path)
    frame["date"] = pd.to_datetime(frame["date"]).dt.normalize()
    return frame.sort_values("date").reset_index(drop=True)


def load_intraday_cache(symbol_name: str) -> pd.DataFrame:
    path = DEFAULT_RAW_DIR / f"{symbol_name}_15minute.parquet"
    if not path.exists():
        raise RuntimeError(f"Missing Kite 15minute cache for {symbol_name}: {path}")
    frame = pd.read_parquet(path)
    frame["timestamp"] = pd.to_datetime(frame["timestamp"])
    frame = frame.sort_values("timestamp").reset_index(drop=True)
    frame["session"] = frame["timestamp"].dt.normalize()
    return frame


def load_proxy_intraday_cache() -> pd.DataFrame:
    if not DEFAULT_PROXY_15M.exists():
        raise RuntimeError(f"Missing Kite proxy 15minute cache: {DEFAULT_PROXY_15M}")
    frame = pd.read_parquet(DEFAULT_PROXY_15M)
    frame["timestamp"] = pd.to_datetime(frame["timestamp"])
    frame = frame.sort_values("timestamp").reset_index(drop=True)
    frame["session"] = frame["timestamp"].dt.normalize()
    return frame


def load_reference() -> pd.DataFrame:
    if not DEFAULT_REFERENCE.exists():
        raise RuntimeError(f"Missing Kite index reference file: {DEFAULT_REFERENCE}")
    frame = pd.read_csv(DEFAULT_REFERENCE)
    frame["instrument_token"] = pd.to_numeric(frame["instrument_token"], errors="coerce").astype("Int64")
    return frame


def index_reference_row(symbol_name: str) -> pd.Series:
    frame = load_reference()
    matched = frame[frame["symbol"].astype(str).str.upper() == symbol_name.upper()]
    if matched.empty:
        raise RuntimeError(f"Could not resolve Kite index reference row for {symbol_name}")
    return matched.iloc[0]


def load_instruments() -> pd.DataFrame:
    if not DEFAULT_INSTRUMENTS.exists():
        raise RuntimeError(f"Missing Kite instruments dump: {DEFAULT_INSTRUMENTS}")
    frame = pd.read_csv(DEFAULT_INSTRUMENTS, low_memory=False)
    for col in ("instrument_token", "lot_size", "strike"):
        if col in frame.columns:
            frame[col] = pd.to_numeric(frame[col], errors="coerce")
    if "expiry" in frame.columns:
        frame["expiry"] = pd.to_datetime(frame["expiry"], errors="coerce")
    return frame


def refresh_session_bars(
    api_key: str,
    access_token: str,
    symbol_name: str,
    session_day: pd.Timestamp,
    cache_frame: pd.DataFrame,
) -> pd.DataFrame:
    row = index_reference_row(symbol_name)
    instrument_token = int(row["instrument_token"])
    payload = get_historical_candles(
        api_key,
        access_token,
        instrument_token,
        "15minute",
        from_ts=f"{session_day.strftime('%Y-%m-%d')} 09:15:00",
        to_ts=f"{session_day.strftime('%Y-%m-%d')} 15:30:00",
        oi=1,
    )
    candles = payload.get("data", {}).get("candles", []) if isinstance(payload, dict) else []
    rows = []
    for candle in candles:
        if not isinstance(candle, list) or len(candle) < 6:
            continue
        rows.append(
            {
                "timestamp": pd.Timestamp(candle[0]).tz_localize(None),
                "open": float(candle[1]),
                "high": float(candle[2]),
                "low": float(candle[3]),
                "close": float(candle[4]),
                "volume": None if candle[5] is None else float(candle[5]),
                "oi": None if len(candle) < 7 or candle[6] is None else float(candle[6]),
                "symbol": symbol_name,
                "tradingsymbol": str(row["tradingsymbol"]),
                "instrument_token": instrument_token,
                "source": "kite",
                "interval": "15minute",
                "session": session_day.normalize(),
            }
        )
    refreshed = pd.DataFrame(rows)
    if refreshed.empty:
        return cache_frame
    without_session = cache_frame[cache_frame["session"] != session_day.normalize()].copy()
    merged = pd.concat([without_session, refreshed], ignore_index=True)
    merged = merged.sort_values("timestamp").drop_duplicates(subset=["timestamp"]).reset_index(drop=True)
    path = DEFAULT_RAW_DIR / f"{symbol_name}_15minute.parquet"
    merged.drop(columns=["session"]).to_parquet(path, index=False)
    csv_path = DEFAULT_RAW_DIR / f"{symbol_name}_15minute.csv"
    merged.drop(columns=["session"]).to_csv(csv_path, index=False)
    merged["session"] = pd.to_datetime(merged["timestamp"]).dt.normalize()
    return merged


def choose_option_contract(symbol_name: str, direction: str, spot_price: float, session_day: pd.Timestamp, expiry_offset: int) -> pd.Series | None:
    instruments = load_instruments()
    option_type = "CE" if direction == "LONG" else "PE"
    subset = instruments[
        (instruments["exchange"].astype(str).str.upper() == "NFO")
        & (instruments["name"].fillna("").astype(str).str.upper() == symbol_name.upper())
        & (instruments["instrument_type"].astype(str).str.upper() == option_type)
        & instruments["expiry"].notna()
        & (instruments["expiry"] >= session_day.normalize())
    ].copy()
    if subset.empty:
        return None
    expiries = sorted(subset["expiry"].dropna().unique())
    if expiry_offset >= len(expiries):
        return None
    expiry = expiries[expiry_offset]
    subset = subset[subset["expiry"] == expiry].copy()
    subset["strike_gap"] = (subset["strike"].astype(float) - float(spot_price)).abs()
    subset = subset.sort_values(["strike_gap", "strike", "tradingsymbol"]).reset_index(drop=True)
    return subset.iloc[0] if not subset.empty else None


def choose_spread_short_contract(
    symbol_name: str,
    long_contract_row: pd.Series,
    *,
    direction: str,
    width_points: int,
) -> pd.Series | None:
    instruments = load_instruments()
    expiry = pd.Timestamp(long_contract_row["expiry"])
    option_type = str(long_contract_row["instrument_type"]).upper()
    long_strike = float(long_contract_row["strike"])
    subset = instruments[
        (instruments["exchange"].astype(str).str.upper() == "NFO")
        & (instruments["name"].fillna("").astype(str).str.upper() == symbol_name.upper())
        & (instruments["instrument_type"].astype(str).str.upper() == option_type)
        & instruments["expiry"].notna()
        & (instruments["expiry"] == expiry)
    ].copy()
    if subset.empty:
        return None
    if direction == "LONG":
        subset = subset[subset["strike"].astype(float) > long_strike].copy()
        target_strike = long_strike + float(width_points)
    else:
        subset = subset[subset["strike"].astype(float) < long_strike].copy()
        target_strike = long_strike - float(width_points)
    if subset.empty:
        return None
    subset["target_gap"] = (subset["strike"].astype(float) - target_strike).abs()
    subset = subset.sort_values(["target_gap", "strike", "tradingsymbol"]).reset_index(drop=True)
    return subset.iloc[0] if not subset.empty else None


def option_candle_cache_path(symbol_name: str, tradingsymbol: str, session_day: pd.Timestamp) -> Path:
    safe_symbol = tradingsymbol.replace("/", "_")
    return DEFAULT_OPTION_CACHE / symbol_name / "candles" / f"{safe_symbol}_{session_day.strftime('%Y%m%d')}.json"


def fetch_option_day_candles(
    api_key: str,
    access_token: str,
    symbol_name: str,
    contract_row: pd.Series,
    session_day: pd.Timestamp,
    *,
    refresh: bool = False,
) -> pd.DataFrame:
    path = option_candle_cache_path(symbol_name, str(contract_row["tradingsymbol"]), session_day)
    if path.exists() and not refresh:
        payload = json.loads(path.read_text(encoding="utf-8"))
    else:
        payload = get_historical_candles(
            api_key,
            access_token,
            int(contract_row["instrument_token"]),
            "15minute",
            from_ts=f"{session_day.strftime('%Y-%m-%d')} 09:15:00",
            to_ts=f"{session_day.strftime('%Y-%m-%d')} 15:30:00",
            oi=1,
        )
        write_json(path, payload)
    candles = payload.get("data", {}).get("candles", []) if isinstance(payload, dict) else []
    rows = []
    for candle in candles:
        if not isinstance(candle, list) or len(candle) < 6:
            continue
        rows.append(
            {
                "timestamp": pd.Timestamp(candle[0]).tz_localize(None),
                "open": float(candle[1]),
                "high": float(candle[2]),
                "low": float(candle[3]),
                "close": float(candle[4]),
                "volume": None if candle[5] is None else float(candle[5]),
                "oi": None if len(candle) < 7 or candle[6] is None else float(candle[6]),
            }
        )
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame
    return frame.sort_values("timestamp").reset_index(drop=True)


def nearest_bar_open(frame: pd.DataFrame, at_or_after: pd.Timestamp) -> tuple[pd.Timestamp | None, float | None]:
    if frame.empty:
        return None, None
    subset = frame[frame["timestamp"] >= at_or_after]
    if subset.empty:
        return None, None
    row = subset.iloc[0]
    return pd.Timestamp(row["timestamp"]), float(row["open"])


def last_close(frame: pd.DataFrame) -> tuple[pd.Timestamp | None, float | None]:
    if frame.empty:
        return None, None
    row = frame.iloc[-1]
    return pd.Timestamp(row["timestamp"]), float(row["close"])


def first_bar_at_or_after(frame: pd.DataFrame, at_or_after: pd.Timestamp) -> pd.Series | None:
    if frame.empty:
        return None
    subset = frame[frame["timestamp"] >= at_or_after]
    if subset.empty:
        return None
    return subset.iloc[0]


def session_time(session_day: pd.Timestamp, hhmmss: str) -> pd.Timestamp:
    return pd.Timestamp(f"{session_day.strftime('%Y-%m-%d')} {hhmmss}")


def indicator_vwap(frame: pd.DataFrame, end_index: int) -> float | None:
    subset = frame.iloc[: end_index + 1].copy()
    volume = subset["volume"].astype(float).fillna(0.0)
    typical = (subset["high"].astype(float) + subset["low"].astype(float) + subset["close"].astype(float)) / 3.0
    total_volume = float(volume.sum())
    if total_volume <= 0.0:
        return None
    return float((typical * volume).sum() / total_volume)


def build_charge_total(
    api_key: str,
    access_token: str,
    orders: list[dict],
) -> float | None:
    try:
        payload = get_order_charges(api_key, access_token, orders)
    except Exception:
        return None
    rows = payload.get("data", []) if isinstance(payload, dict) else []
    totals = [float(row["charges"]["total"]) for row in rows if isinstance(row, dict) and row.get("charges")]
    if len(totals) != len(orders):
        return None
    return float(sum(totals))


def compute_option_roundtrip_charges(
    api_key: str,
    access_token: str,
    *,
    tradingsymbol: str,
    lot_size: int,
    entry_price: float,
    exit_price: float,
) -> float | None:
    orders = [
        {
            "order_id": f"{tradingsymbol}_entry",
            "exchange": "NFO",
            "tradingsymbol": tradingsymbol,
            "transaction_type": "BUY",
            "variety": "regular",
            "product": "MIS",
            "order_type": "MARKET",
            "quantity": lot_size,
            "average_price": round(float(entry_price), 2),
        },
        {
            "order_id": f"{tradingsymbol}_exit",
            "exchange": "NFO",
            "tradingsymbol": tradingsymbol,
            "transaction_type": "SELL",
            "variety": "regular",
            "product": "MIS",
            "order_type": "MARKET",
            "quantity": lot_size,
            "average_price": round(float(exit_price), 2),
        },
    ]
    return build_charge_total(api_key, access_token, orders)


def compute_debit_spread_roundtrip_charges(
    api_key: str,
    access_token: str,
    *,
    long_contract: str,
    short_contract: str,
    lot_size: int,
    long_entry: float,
    long_exit: float,
    short_entry: float,
    short_exit: float,
) -> float | None:
    orders = [
        {
            "order_id": f"{long_contract}_buy_entry",
            "exchange": "NFO",
            "tradingsymbol": long_contract,
            "transaction_type": "BUY",
            "variety": "regular",
            "product": "MIS",
            "order_type": "MARKET",
            "quantity": lot_size,
            "average_price": round(float(long_entry), 2),
        },
        {
            "order_id": f"{short_contract}_sell_entry",
            "exchange": "NFO",
            "tradingsymbol": short_contract,
            "transaction_type": "SELL",
            "variety": "regular",
            "product": "MIS",
            "order_type": "MARKET",
            "quantity": lot_size,
            "average_price": round(float(short_entry), 2),
        },
        {
            "order_id": f"{long_contract}_sell_exit",
            "exchange": "NFO",
            "tradingsymbol": long_contract,
            "transaction_type": "SELL",
            "variety": "regular",
            "product": "MIS",
            "order_type": "MARKET",
            "quantity": lot_size,
            "average_price": round(float(long_exit), 2),
        },
        {
            "order_id": f"{short_contract}_buy_exit",
            "exchange": "NFO",
            "tradingsymbol": short_contract,
            "transaction_type": "BUY",
            "variety": "regular",
            "product": "MIS",
            "order_type": "MARKET",
            "quantity": lot_size,
            "average_price": round(float(short_exit), 2),
        },
    ]
    return build_charge_total(api_key, access_token, orders)


def session_trade_report(
    api_key: str,
    access_token: str,
    spec: SessionSpec,
    session_day: pd.Timestamp,
    *,
    refresh: bool = False,
) -> dict:
    symbol_config = SYMBOLS[spec.symbol]
    daily = load_daily_cache(spec.symbol)
    intraday = load_intraday_cache(spec.symbol)
    proxy_intraday = None
    if spec.use_proxy_vwap:
        proxy_intraday = load_proxy_intraday_cache()
    if refresh or session_day.normalize() > pd.Timestamp(intraday["session"].max()):
        intraday = refresh_session_bars(api_key, access_token, spec.symbol, session_day, intraday)

    prev_daily = daily[daily["date"] < session_day.normalize()].tail(1)
    session_bars = intraday[intraday["session"] == session_day.normalize()].copy()
    entry_bar_index = spec.signal_bar_index + 1
    minimum_session_bars = entry_bar_index + 1
    if prev_daily.empty:
        return {"symbol": spec.symbol, "session": session_day.strftime("%Y-%m-%d"), "status": "missing_prev_daily"}
    if session_bars.empty:
        return {"symbol": spec.symbol, "session": session_day.strftime("%Y-%m-%d"), "status": "missing_session_bars"}
    session_bars = session_bars.sort_values("timestamp").reset_index(drop=True)
    if len(session_bars) < minimum_session_bars:
        return {
            "symbol": spec.symbol,
            "session": session_day.strftime("%Y-%m-%d"),
            "status": "incomplete_session",
            "bar_count": int(len(session_bars)),
        }

    day_open = float(session_bars.loc[0, "open"])
    signal_close = float(session_bars.loc[spec.signal_bar_index, "close"])
    signal_ret = (signal_close - day_open) / day_open
    direction_value = 1 if signal_ret > 0 else -1
    gap_ret = (day_open - float(prev_daily["close"].iloc[0])) / float(prev_daily["close"].iloc[0])
    passes_threshold = abs(signal_ret) >= spec.threshold
    passes_gap = (not spec.gap_align) or ((1 if gap_ret > 0 else -1 if gap_ret < 0 else 0) == direction_value)
    passes_proxy_vwap = True
    proxy_vwap_dir = None
    if spec.use_proxy_vwap:
        proxy_day = proxy_intraday[proxy_intraday["session"] == session_day.normalize()].sort_values("timestamp").reset_index(drop=True) if proxy_intraday is not None else pd.DataFrame()
        if len(proxy_day) <= spec.signal_bar_index:
            return {"symbol": spec.symbol, "session": session_day.strftime("%Y-%m-%d"), "status": "missing_proxy_session_bars"}
        proxy_vwap = indicator_vwap(proxy_day, spec.signal_bar_index)
        proxy_close = float(proxy_day.loc[spec.signal_bar_index, "close"])
        proxy_vwap_dir = 0 if proxy_vwap is None else (1 if proxy_close > proxy_vwap else -1 if proxy_close < proxy_vwap else 0)
        passes_proxy_vwap = proxy_vwap_dir == direction_value
    direction = "LONG" if direction_value > 0 else "SHORT"

    base = {
        "symbol": spec.symbol,
        "session": session_day.strftime("%Y-%m-%d"),
        "weekday": pd.Timestamp(session_day).day_name(),
        "instrument_mode": "underlying",
        "threshold_pct": round(spec.threshold * 100.0, 3),
        "gap_align": spec.gap_align,
        "signal_bar_index": spec.signal_bar_index,
        "signal_ret_pct": round(signal_ret * 100.0, 3),
        "day_open": round(day_open, 2),
        "signal_close_price": round(signal_close, 2),
        "direction": direction,
        "lot_size": symbol_config["fallback_lot_size"],
        "use_proxy_vwap": spec.use_proxy_vwap,
        "execution_style": "intraday_first",
        "primary_vehicle": "atm_option",
        "secondary_vehicle": "companion_debit_spread",
        "archive_caution_flags": archive_caution_flags(session_day, signal_ret),
    }
    if proxy_vwap_dir is not None:
        base["proxy_vwap_dir"] = proxy_vwap_dir
    if not passes_threshold or not passes_gap or not passes_proxy_vwap:
        return {
            **base,
            "status": "no_signal",
            "passes_threshold": passes_threshold,
            "passes_gap": passes_gap,
            "passes_proxy_vwap": passes_proxy_vwap,
        }

    entry_row = session_bars.loc[entry_bar_index]
    latest_entry_cutoff = session_time(session_day, spec.latest_entry_time)
    if pd.Timestamp(entry_row["timestamp"]) > latest_entry_cutoff:
        return {**base, "status": "entry_after_cutoff", "latest_entry_time": spec.latest_entry_time}
    entry_price = float(entry_row["open"])
    session_end = session_time(session_day, "15:30:00")
    exit_cutoff = session_time(session_day, spec.hard_exit_time) if spec.hard_exit_time else None
    if exit_cutoff is None:
        exit_row = session_bars.iloc[-1]
        exit_price = float(exit_row["close"])
    else:
        exit_row = first_bar_at_or_after(session_bars, exit_cutoff)
        if exit_row is None:
            return {**base, "status": "missing_exit_bar", "hard_exit_time": spec.hard_exit_time}
        exit_price = float(exit_row["open"])
    pnl_points = (exit_price - entry_price) * direction_value

    now = pd.Timestamp.now(tz="Asia/Kolkata").tz_localize(None)
    active_cutoff = exit_cutoff if exit_cutoff is not None else session_end
    if session_day.normalize() == now.normalize() and now < active_cutoff:
        payload = get_quotes(api_key, access_token, [symbol_config["quote_symbol"]], mode="quote")
        quote = payload.get("data", {}).get(symbol_config["quote_symbol"], {})
        mark_price = float(quote["last_price"])
        mark_points = (mark_price - entry_price) * direction_value
        return {
            **base,
            "status": "open_position",
            "entry_timestamp": pd.Timestamp(entry_row["timestamp"]).strftime("%Y-%m-%d %H:%M:%S"),
            "entry_price": round(entry_price, 2),
            "mark_price": round(mark_price, 2),
            "mtm_points": round(mark_points, 2),
            "mtm_inr_one_lot": round(mark_points * symbol_config["fallback_lot_size"], 2),
        }

    return {
        **base,
        "status": "closed",
        "entry_timestamp": pd.Timestamp(entry_row["timestamp"]).strftime("%Y-%m-%d %H:%M:%S"),
        "entry_price": round(entry_price, 2),
        "exit_timestamp": pd.Timestamp(exit_row["timestamp"]).strftime("%Y-%m-%d %H:%M:%S"),
        "exit_price": round(exit_price, 2),
        "pnl_points": round(pnl_points, 2),
        "pnl_inr_one_lot": round(pnl_points * symbol_config["fallback_lot_size"], 2),
    }


def option_trade_report(
    api_key: str,
    access_token: str,
    spec: SessionSpec,
    session_day: pd.Timestamp,
    *,
    refresh: bool = False,
) -> dict:
    underlying_spec = SessionSpec(
        symbol=spec.symbol,
        threshold=spec.threshold,
        gap_align=spec.gap_align,
        signal_bar_index=spec.signal_bar_index,
        instrument_mode="underlying",
        expiry_offset=spec.expiry_offset,
        latest_entry_time=spec.latest_entry_time,
        hard_exit_time=spec.hard_exit_time,
        use_proxy_vwap=spec.use_proxy_vwap,
        companion_spread_width_points=spec.companion_spread_width_points,
    )
    underlying_report = session_trade_report(api_key, access_token, underlying_spec, session_day, refresh=refresh)
    option_base = {**underlying_report, "instrument_mode": "atm_option", "expiry_offset": spec.expiry_offset}
    if underlying_report.get("status") not in {"open_position", "closed"}:
        return option_base

    entry_timestamp_raw = underlying_report.get("entry_timestamp")
    entry_timestamp = pd.Timestamp(entry_timestamp_raw) if entry_timestamp_raw else None
    if entry_timestamp is None:
        return {**option_base, "status": "missing_entry_timestamp"}

    contract_row = choose_option_contract(
        spec.symbol,
        str(underlying_report["direction"]),
        float(underlying_report["entry_price"]),
        session_day,
        spec.expiry_offset,
    )
    if contract_row is None:
        return {**option_base, "status": "missing_contract"}

    option_candles = fetch_option_day_candles(api_key, access_token, spec.symbol, contract_row, session_day, refresh=refresh)
    if option_candles.empty:
        return {
            **option_base,
            "status": "missing_option_candles",
            "option_contract": str(contract_row["tradingsymbol"]),
        }

    option_entry_ts, option_entry_price = nearest_bar_open(option_candles, entry_timestamp)
    option_close_ts, option_close_price = last_close(option_candles)
    if option_entry_price is None or option_close_price is None:
        return {
            **option_base,
            "status": "missing_option_entry_or_exit",
            "option_contract": str(contract_row["tradingsymbol"]),
        }

    lot_size = int(contract_row["lot_size"]) if not pd.isna(contract_row["lot_size"]) else int(underlying_report["lot_size"])
    option_base_fields = {
        **option_base,
        "option_contract": str(contract_row["tradingsymbol"]),
        "option_expiry_date": pd.Timestamp(contract_row["expiry"]).strftime("%Y-%m-%d") if pd.notna(contract_row["expiry"]) else None,
        "option_type": str(contract_row["instrument_type"]),
        "option_strike_price": round(float(contract_row["strike"]), 2) if not pd.isna(contract_row["strike"]) else None,
        "underlying_entry_price": round(float(underlying_report["entry_price"]), 2),
        "lot_size": lot_size,
        "entry_timestamp": option_entry_ts.strftime("%Y-%m-%d %H:%M:%S") if option_entry_ts is not None else None,
        "entry_price": round(float(option_entry_price), 2),
    }

    now = pd.Timestamp.now(tz="Asia/Kolkata").tz_localize(None)
    quote_symbol = f"NFO:{contract_row['tradingsymbol']}"
    session_end = session_time(session_day, "15:30:00")
    exit_cutoff = session_time(session_day, spec.hard_exit_time) if spec.hard_exit_time else None
    if exit_cutoff is None:
        option_exit_ts, option_exit_price = option_close_ts, option_close_price
    else:
        option_exit_row = first_bar_at_or_after(option_candles, exit_cutoff)
        if option_exit_row is None:
            return {
                **option_base_fields,
                "status": "missing_option_exit_bar",
            }
        option_exit_ts = pd.Timestamp(option_exit_row["timestamp"])
        option_exit_price = float(option_exit_row["open"])
    active_cutoff = exit_cutoff if exit_cutoff is not None else session_end
    if session_day.normalize() == now.normalize() and now < active_cutoff:
        payload = get_quotes(api_key, access_token, [quote_symbol], mode="quote")
        quote = payload.get("data", {}).get(quote_symbol)
        if quote and quote.get("last_price") is not None:
            mark_price = float(quote["last_price"])
            mark_ts = pd.Timestamp(quote.get("timestamp") or now)
        else:
            mark_ts, mark_price = option_close_ts, option_close_price
        points = float(mark_price - option_entry_price)
        return {
            **option_base_fields,
            "status": "open_position",
            "mark_timestamp": mark_ts.strftime("%Y-%m-%d %H:%M:%S") if mark_ts is not None else None,
            "mark_price": round(float(mark_price), 2),
            "mtm_points": round(points, 2),
            "mtm_inr_one_lot": round(points * lot_size, 2),
        }

    points = float(option_exit_price - option_entry_price)
    charges_total = compute_option_roundtrip_charges(
        api_key,
        access_token,
        tradingsymbol=str(contract_row["tradingsymbol"]),
        lot_size=lot_size,
        entry_price=float(option_entry_price),
        exit_price=float(option_exit_price),
    )
    result = {
        **option_base_fields,
        "status": "closed",
        "exit_timestamp": option_exit_ts.strftime("%Y-%m-%d %H:%M:%S") if option_exit_ts is not None else None,
        "exit_price": round(float(option_exit_price), 2),
        "pnl_points": round(points, 2),
        "pnl_inr_one_lot": round(points * lot_size, 2),
    }
    if charges_total is not None:
        result["charges_inr_one_lot"] = round(charges_total, 2)
        result["net_inr_one_lot"] = round(float(result["pnl_inr_one_lot"]) - charges_total, 2)
    if spec.symbol.upper() == "NIFTY" and spec.companion_spread_width_points:
        short_contract_row = choose_spread_short_contract(
            spec.symbol,
            contract_row,
            direction=str(underlying_report["direction"]),
            width_points=int(spec.companion_spread_width_points),
        )
        if short_contract_row is not None:
            short_candles = fetch_option_day_candles(api_key, access_token, spec.symbol, short_contract_row, session_day, refresh=refresh)
            short_entry_ts, short_entry_price = nearest_bar_open(short_candles, entry_timestamp)
            if exit_cutoff is None:
                _, short_close_price = last_close(short_candles)
                short_exit_price = float(short_close_price) if short_close_price is not None else None
            else:
                short_exit_row = first_bar_at_or_after(short_candles, exit_cutoff)
                short_exit_price = float(short_exit_row["open"]) if short_exit_row is not None else None
            if short_entry_price is not None and short_exit_price is not None:
                spread_points = float((option_exit_price - option_entry_price) - (short_exit_price - short_entry_price))
                spread_payload = {
                    "strategy": "bull_call_spread" if str(underlying_report["direction"]) == "LONG" else "bear_put_spread",
                    "spread_width_points": int(spec.companion_spread_width_points),
                    "long_leg": str(contract_row["tradingsymbol"]),
                    "short_leg": str(short_contract_row["tradingsymbol"]),
                    "entry_debit": round(float(option_entry_price - short_entry_price), 2),
                    "exit_value": round(float(option_exit_price - short_exit_price), 2),
                    "pnl_points": round(spread_points, 2),
                    "pnl_inr_one_lot": round(spread_points * lot_size, 2),
                }
                spread_charges = compute_debit_spread_roundtrip_charges(
                    api_key,
                    access_token,
                    long_contract=str(contract_row["tradingsymbol"]),
                    short_contract=str(short_contract_row["tradingsymbol"]),
                    lot_size=lot_size,
                    long_entry=float(option_entry_price),
                    long_exit=float(option_exit_price),
                    short_entry=float(short_entry_price),
                    short_exit=float(short_exit_price),
                )
                if spread_charges is not None:
                    spread_payload["charges_inr_one_lot"] = round(spread_charges, 2)
                    spread_payload["net_inr_one_lot"] = round(float(spread_payload["pnl_inr_one_lot"]) - spread_charges, 2)
                result["companion_spread"] = spread_payload
    return result


def append_journal(report: dict) -> Path:
    DEFAULT_JOURNAL_DIR.mkdir(parents=True, exist_ok=True)
    session = report["session"]
    path = DEFAULT_JOURNAL_DIR / f"{session}_{report['symbol']}.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Kite-backed live-paper version of the index midday momentum strategy.")
    parser.add_argument("--symbol", required=True, choices=sorted(SYMBOLS.keys()))
    parser.add_argument("--session", default=None, help="Session date YYYY-MM-DD. Defaults to today in Asia/Kolkata.")
    parser.add_argument("--threshold-pct", type=float, default=None, help="Override threshold percent.")
    parser.add_argument("--gap-align", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--signal-bar-index", type=int, default=None)
    parser.add_argument("--instrument-mode", choices=["underlying", "atm_option"], default=None)
    parser.add_argument("--expiry-offset", type=int, default=None)
    parser.add_argument("--config-file", default=str(DEFAULT_STRATEGY_CONFIG))
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    load_env_files(DEFAULT_ENV_FILES)
    api_key = require_env("KITE_API_KEY")
    access_token = require_env("KITE_ACCESS_TOKEN")

    session_day = (
        pd.Timestamp(args.session).normalize()
        if args.session
        else pd.Timestamp.now(tz="Asia/Kolkata").tz_localize(None).normalize()
    )
    strategy_config = load_strategy_config(Path(args.config_file))
    config = resolve_symbol_defaults(args.symbol, strategy_config)
    spec = SessionSpec(
        symbol=args.symbol,
        threshold=(float(config["default_threshold_pct"]) / 100.0) if args.threshold_pct is None else args.threshold_pct / 100.0,
        gap_align=config["default_gap_align"] if args.gap_align is None else args.gap_align,
        signal_bar_index=config["signal_bar_index"] if args.signal_bar_index is None else args.signal_bar_index,
        instrument_mode=str(config["instrument_mode"]) if args.instrument_mode is None else args.instrument_mode,
        expiry_offset=int(config["expiry_offset"]) if args.expiry_offset is None else args.expiry_offset,
        latest_entry_time=str(config["latest_entry_time"]),
        hard_exit_time=config.get("hard_exit_time"),
        use_proxy_vwap=bool(config.get("use_proxy_vwap", False)),
        companion_spread_width_points=config.get("companion_spread_width_points"),
    )
    if spec.instrument_mode == "atm_option":
        report = option_trade_report(api_key, access_token, spec, session_day, refresh=args.refresh)
    else:
        report = session_trade_report(api_key, access_token, spec, session_day, refresh=args.refresh)
    journal_path = append_journal(report)
    payload = {
        "journal_path": str(journal_path.resolve()),
        "report": report,
        "spec": asdict(spec),
        "strategy_config_file": str(Path(args.config_file).resolve()),
    }
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
