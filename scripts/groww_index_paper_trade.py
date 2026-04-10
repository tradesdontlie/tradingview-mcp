#!/usr/bin/env python3

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

import pandas as pd
import requests

try:
    from growwapi import GrowwAPI
except ImportError as exc:  # pragma: no cover - runtime dependency
    raise RuntimeError("growwapi is required. Install it with `pip install growwapi`.") from exc

from groww_fno_option_backtest import (
    choose_atm_contract,
    choose_expiry,
    fetch_contracts_cached,
    fetch_expiries_cached,
    fetch_option_day_candles,
    last_close,
    nearest_bar_open,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STRATEGY_CONFIG = REPO_ROOT / "config" / "live_paper_strategy.json"
DEFAULT_ENV_FILES = [
    REPO_ROOT / "config" / "runtime.env",
    REPO_ROOT / "config" / "local.env",
]
DEFAULT_OPTION_CACHE_DIR = REPO_ROOT / "market" / "raw" / "groww" / "options"
NSE_LOT_SIZE_URL = "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv"
NSE_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.nseindia.com/"}

SYMBOLS = {
    "NIFTY": {
        "groww_symbol": "NSE-NIFTY",
        "nse_symbol": "NIFTY",
        "fallback_lot_size": 65,
        "default_threshold": 0.0040,
        "default_gap_align": False,
    },
    "BANKNIFTY": {
        "groww_symbol": "NSE-BANKNIFTY",
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
    merged["signal_bar_index"] = int(shared.get("signal_bar_index", 15))
    merged["instrument_mode"] = str(symbol_defaults.get("instrument_mode", shared.get("instrument_mode", "underlying")))
    merged["expiry_offset"] = int(symbol_defaults.get("expiry_offset", shared.get("expiry_offset", 0)))
    return merged


def load_env_files(paths: Iterable[Path]) -> None:
    for path in paths:
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and value and key not in os.environ:
                os.environ[key] = value


def init_client(env_files: list[Path]) -> GrowwAPI:
    load_env_files(env_files)
    token = os.getenv("GROWW_ACCESS_TOKEN")
    if not token:
        raise RuntimeError("Missing `GROWW_ACCESS_TOKEN`. Add it to config/local.env or pass --env-file.")
    return GrowwAPI(token)


def retry_api_call(fn, *, attempts: int = 5, base_sleep_seconds: float = 1.5):
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as exc:  # pragma: no cover - remote dependency
            last_error = exc
            if attempt == attempts:
                raise
            time.sleep(base_sleep_seconds * attempt)
    if last_error is not None:
        raise last_error
    raise RuntimeError("Unexpected retry state.")


def fetch_lot_sizes() -> dict[str, int]:
    try:
        response = requests.get(NSE_LOT_SIZE_URL, headers=NSE_HEADERS, timeout=20)
        response.raise_for_status()
        raw = pd.read_csv(io.StringIO(response.text))
        raw.columns = [str(col).strip() for col in raw.columns]
        frame = raw.copy()
        for col in frame.columns:
            frame[col] = frame[col].map(lambda value: value.strip() if isinstance(value, str) else value)
        expiry_cols = [col for col in frame.columns if col not in {"UNDERLYING", "SYMBOL"}]
        lot_sizes: dict[str, int] = {}
        for _, row in frame.iterrows():
            symbol = str(row.get("SYMBOL", "")).strip()
            if not symbol:
                continue
            values = []
            for col in expiry_cols:
                value = str(row.get(col, "")).strip()
                if value.isdigit():
                    values.append(int(value))
            if values:
                lot_sizes[symbol] = values[0]
        return lot_sizes
    except Exception:
        return {}


def load_daily_cache(symbol_name: str) -> pd.DataFrame:
    path = REPO_ROOT / "market" / "raw" / "groww" / f"{symbol_name}_daily.parquet"
    if not path.exists():
        raise RuntimeError(f"Missing daily cache for {symbol_name}: {path}")
    frame = pd.read_parquet(path)
    frame["date"] = pd.to_datetime(frame["date"]).dt.normalize()
    return frame.sort_values("date").reset_index(drop=True)


def load_intraday_cache(symbol_name: str) -> pd.DataFrame:
    path = REPO_ROOT / "market" / "raw" / "groww" / f"{symbol_name}_15minute.parquet"
    if not path.exists():
        raise RuntimeError(f"Missing 15minute cache for {symbol_name}: {path}")
    frame = pd.read_parquet(path)
    frame["timestamp"] = pd.to_datetime(frame["timestamp"])
    frame = frame.sort_values("timestamp").reset_index(drop=True)
    frame["session"] = frame["timestamp"].dt.normalize()
    return frame


def locate_expiry(
    client: GrowwAPI,
    symbol_name: str,
    session_day: pd.Timestamp,
    cache_dir: Path,
    *,
    expiry_offset: int,
    refresh: bool,
) -> str | None:
    years = [session_day.year]
    if session_day.month == 12:
        years.append(session_day.year + 1)
    expiries: list[str] = []
    for year in years:
        expiries.extend(
            fetch_expiries_cached(
                client,
                symbol_name,
                cache_dir,
                year=year,
                refresh=refresh,
            )
        )
    return choose_expiry(sorted(set(expiries)), session_day, expiry_offset=expiry_offset)


def refresh_session_bars(
    client: GrowwAPI,
    symbol_name: str,
    session_day: pd.Timestamp,
    cache_frame: pd.DataFrame,
) -> pd.DataFrame:
    groww_symbol = SYMBOLS[symbol_name]["groww_symbol"]
    response = retry_api_call(
        lambda: client.get_historical_candles(
            exchange=client.EXCHANGE_NSE,
            segment=client.SEGMENT_CASH,
            groww_symbol=groww_symbol,
            start_time=f"{session_day.strftime('%Y-%m-%d')} 09:15:00",
            end_time=f"{session_day.strftime('%Y-%m-%d')} 15:30:00",
            candle_interval=client.CANDLE_INTERVAL_MIN_15,
        )
    )
    candles = response.get("candles", []) if isinstance(response, dict) else []
    rows = []
    for candle in candles:
        if not isinstance(candle, list) or len(candle) < 5:
            continue
        rows.append(
            {
                "timestamp": pd.Timestamp(candle[0]).tz_localize(None),
                "open": float(candle[1]),
                "high": float(candle[2]),
                "low": float(candle[3]),
                "close": float(candle[4]),
                "volume": None if len(candle) < 6 or candle[5] is None else float(candle[5]),
                "oi": None if len(candle) < 7 or candle[6] is None else float(candle[6]),
                "interval": "15minute",
                "symbol": symbol_name,
                "groww_symbol": groww_symbol,
                "source": "groww",
                "session": session_day.normalize(),
            }
        )
    refreshed = pd.DataFrame(rows)
    if refreshed.empty:
        return cache_frame
    without_session = cache_frame[cache_frame["session"] != session_day.normalize()].copy()
    merged = pd.concat([without_session, refreshed], ignore_index=True)
    merged = merged.sort_values("timestamp").drop_duplicates(subset=["timestamp"]).reset_index(drop=True)
    path = REPO_ROOT / "market" / "raw" / "groww" / f"{symbol_name}_15minute.parquet"
    merged.drop(columns=["session"]).to_parquet(path, index=False)
    csv_path = REPO_ROOT / "market" / "raw" / "groww" / f"{symbol_name}_15minute.csv"
    merged.drop(columns=["session"]).to_csv(csv_path, index=False)
    merged["session"] = pd.to_datetime(merged["timestamp"]).dt.normalize()
    return merged


def session_trade_report(
    client: GrowwAPI,
    spec: SessionSpec,
    session_day: pd.Timestamp,
    *,
    refresh: bool = False,
) -> dict:
    symbol_config = SYMBOLS[spec.symbol]
    daily = load_daily_cache(spec.symbol)
    intraday = load_intraday_cache(spec.symbol)
    if refresh or session_day.normalize() > pd.Timestamp(intraday["session"].max()):
        intraday = refresh_session_bars(client, spec.symbol, session_day, intraday)

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

    lot_sizes = fetch_lot_sizes()
    lot_size = lot_sizes.get(symbol_config["nse_symbol"], symbol_config["fallback_lot_size"])
    direction = "LONG" if direction_value > 0 else "SHORT"

    base = {
        "symbol": spec.symbol,
        "session": session_day.strftime("%Y-%m-%d"),
        "instrument_mode": "underlying",
        "threshold_pct": round(spec.threshold * 100.0, 3),
        "gap_align": spec.gap_align,
        "signal_bar_index": spec.signal_bar_index,
        "signal_ret_pct": round(signal_ret * 100.0, 3),
        "day_open": round(day_open, 2),
        "signal_close_price": round(signal_close, 2),
        "direction": direction,
        "lot_size": lot_size,
    }
    if not passes_threshold or not passes_gap:
        return {
            **base,
            "status": "no_signal",
            "passes_threshold": passes_threshold,
            "passes_gap": passes_gap,
        }

    entry_row = session_bars.loc[entry_bar_index]
    entry_price = float(entry_row["open"])
    close_row = session_bars.iloc[-1]
    exit_price = float(close_row["close"])
    pnl_points = (exit_price - entry_price) * direction_value

    now = pd.Timestamp.now(tz="Asia/Kolkata").tz_localize(None)
    if session_day.normalize() == now.normalize() and now < pd.Timestamp(f"{session_day.strftime('%Y-%m-%d')} 15:30:00"):
        quote = retry_api_call(
            lambda: client.get_quote(
                trading_symbol=symbol_config["nse_symbol"],
                exchange=client.EXCHANGE_NSE,
                segment=client.SEGMENT_CASH,
            )
        )
        mark_price = float(quote["last_price"])
        mark_points = (mark_price - entry_price) * direction_value
        status = "open_position"
        report = {
            **base,
            "status": status,
            "entry_timestamp": pd.Timestamp(entry_row["timestamp"]).strftime("%Y-%m-%d %H:%M:%S"),
            "entry_price": round(entry_price, 2),
            "mark_price": round(mark_price, 2),
            "mtm_points": round(mark_points, 2),
            "mtm_inr_one_lot": round(mark_points * lot_size, 2),
        }
    else:
        status = "closed"
        report = {
            **base,
            "status": status,
            "entry_timestamp": pd.Timestamp(entry_row["timestamp"]).strftime("%Y-%m-%d %H:%M:%S"),
            "entry_price": round(entry_price, 2),
            "exit_timestamp": pd.Timestamp(close_row["timestamp"]).strftime("%Y-%m-%d %H:%M:%S"),
            "exit_price": round(exit_price, 2),
            "pnl_points": round(pnl_points, 2),
            "pnl_inr_one_lot": round(pnl_points * lot_size, 2),
        }
    return report


def option_trade_report(
    client: GrowwAPI,
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
    )
    underlying_report = session_trade_report(client, underlying_spec, session_day, refresh=refresh)
    option_base = {
        **underlying_report,
        "instrument_mode": "atm_option",
        "expiry_offset": spec.expiry_offset,
    }
    if underlying_report.get("status") not in {"open_position", "closed"}:
        return option_base

    entry_timestamp_raw = underlying_report.get("entry_timestamp")
    entry_timestamp = pd.Timestamp(entry_timestamp_raw) if entry_timestamp_raw else None
    if entry_timestamp is None:
        return {**option_base, "status": "missing_entry_timestamp"}

    option_cache_dir = DEFAULT_OPTION_CACHE_DIR / spec.symbol
    expiry_date = locate_expiry(
        client,
        spec.symbol,
        session_day,
        option_cache_dir,
        expiry_offset=spec.expiry_offset,
        refresh=refresh,
    )
    if expiry_date is None:
        return {**option_base, "status": "missing_expiry"}

    contracts = fetch_contracts_cached(
        client,
        spec.symbol,
        expiry_date,
        option_cache_dir,
        refresh=refresh,
    )
    underlying_entry_price = float(underlying_report["entry_price"])
    contract = choose_atm_contract(contracts, str(underlying_report["direction"]), underlying_entry_price)
    if contract is None:
        return {
            **option_base,
            "status": "missing_contract",
            "option_expiry_date": expiry_date,
        }

    option_candles = fetch_option_day_candles(
        client,
        contract.groww_symbol,
        session_day,
        option_cache_dir / "candles",
        refresh=refresh,
    )
    if option_candles.empty:
        return {
            **option_base,
            "status": "missing_option_candles",
            "option_contract": contract.groww_symbol,
            "option_expiry_date": expiry_date,
        }

    option_entry_ts, option_entry_price = nearest_bar_open(option_candles, entry_timestamp)
    option_mark_ts, option_mark_price = last_close(option_candles)
    if option_entry_price is None or option_mark_price is None:
        return {
            **option_base,
            "status": "missing_option_entry_or_exit",
            "option_contract": contract.groww_symbol,
            "option_expiry_date": expiry_date,
        }

    lot_size = int(underlying_report["lot_size"])
    option_points = float(option_mark_price - option_entry_price)
    option_inr = option_points * lot_size
    report = {
        **option_base,
        "option_contract": contract.groww_symbol,
        "option_expiry_date": expiry_date,
        "option_type": contract.option_type,
        "option_strike_price": round(float(contract.strike_price), 2) if contract.strike_price is not None else None,
        "underlying_entry_price": round(underlying_entry_price, 2),
        "entry_timestamp": option_entry_ts.strftime("%Y-%m-%d %H:%M:%S") if option_entry_ts is not None else None,
        "entry_price": round(float(option_entry_price), 2),
    }

    now = pd.Timestamp.now(tz="Asia/Kolkata").tz_localize(None)
    live_cutoff = pd.Timestamp(f"{session_day.strftime('%Y-%m-%d')} 15:30:00")
    if session_day.normalize() == now.normalize() and now < live_cutoff:
        return {
            **report,
            "status": "open_position",
            "mark_timestamp": option_mark_ts.strftime("%Y-%m-%d %H:%M:%S") if option_mark_ts is not None else None,
            "mark_price": round(float(option_mark_price), 2),
            "mtm_points": round(option_points, 2),
            "mtm_inr_one_lot": round(option_inr, 2),
        }

    return {
        **report,
        "status": "closed",
        "exit_timestamp": option_mark_ts.strftime("%Y-%m-%d %H:%M:%S") if option_mark_ts is not None else None,
        "exit_price": round(float(option_mark_price), 2),
        "pnl_points": round(option_points, 2),
        "pnl_inr_one_lot": round(option_inr, 2),
    }


def append_journal(report: dict) -> Path:
    root = REPO_ROOT / "market" / "paper_trades"
    root.mkdir(parents=True, exist_ok=True)
    session = report["session"]
    path = root / f"{session}_{report['symbol']}.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the live-paper version of the index midday momentum strategy with Groww data and journal the result.")
    parser.add_argument("--symbol", required=True, choices=sorted(SYMBOLS.keys()))
    parser.add_argument("--session", default=None, help="Session date YYYY-MM-DD. Defaults to today in Asia/Kolkata.")
    parser.add_argument("--threshold-pct", type=float, default=None, help="Override threshold percent.")
    parser.add_argument(
        "--gap-align",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Require overnight gap alignment. Use --no-gap-align to disable explicitly.",
    )
    parser.add_argument("--signal-bar-index", type=int, default=None, help="Override the signal bar index within the session.")
    parser.add_argument(
        "--instrument-mode",
        choices=["underlying", "atm_option"],
        default=None,
        help="Trade the underlying index direction or buy the nearest-expiry ATM CE/PE option.",
    )
    parser.add_argument("--expiry-offset", type=int, default=None, help="0 = nearest expiry, 1 = next expiry, etc.")
    parser.add_argument("--config-file", default=str(DEFAULT_STRATEGY_CONFIG), help="Path to the live-paper strategy config JSON.")
    parser.add_argument("--refresh", action="store_true", help="Refresh the selected session bars from Groww.")
    parser.add_argument("--env-file", action="append", default=[], help="Extra env file(s) with GROWW_ACCESS_TOKEN.")
    parser.add_argument("--json", action="store_true", help="Emit JSON.")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

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
    )
    if spec.threshold < 0:
        raise ValueError("threshold must be non-negative")
    if spec.signal_bar_index < 0:
        raise ValueError("signal-bar-index must be non-negative")
    if spec.expiry_offset < 0:
        raise ValueError("expiry-offset must be non-negative")
    env_files = DEFAULT_ENV_FILES + [Path(path) for path in args.env_file]
    client = init_client(env_files)
    if spec.instrument_mode == "atm_option":
        report = option_trade_report(client, spec, session_day, refresh=args.refresh)
    else:
        report = session_trade_report(client, spec, session_day, refresh=args.refresh)
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
        print(f"Paper-trade journal: {journal_path}")
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
