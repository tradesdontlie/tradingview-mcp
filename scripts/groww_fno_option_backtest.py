#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import pandas as pd

try:
    from growwapi import GrowwAPI
except ImportError as exc:  # pragma: no cover - runtime dependency
    raise RuntimeError("growwapi is required. Install it with `pip install growwapi`.") from exc

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from single_name_intraday_research import CandidateSpec, SYMBOLS as UNDERLYING_SYMBOLS, evaluate_candidate, session_frame

DEFAULT_ENV_FILES = [
    Path(__file__).resolve().parents[1] / "config" / "runtime.env",
    Path(__file__).resolve().parents[1] / "config" / "local.env",
]

DEFAULT_SIGNAL_SPECS = {
    "HDFCBANK": CandidateSpec(
        threshold=0.0020,
        gap_align=True,
        trend_confirm=False,
        benchmark_align=False,
        leader_confirm=True,
        volume_surge=True,
    ),
    "BAJFINANCE": CandidateSpec(
        threshold=0.0025,
        gap_align=False,
        trend_confirm=False,
        benchmark_align=True,
        leader_confirm=False,
        volume_surge=False,
    ),
}


@dataclass(frozen=True)
class ParsedContract:
    groww_symbol: str
    exchange: str
    underlying_symbol: str
    expiry_label: str
    strike_price: float | None
    option_type: str


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


def generate_totp_code(secret: str, *, digits: int = 6, interval_seconds: int = 30, for_time: int | None = None) -> str:
    normalized = secret.strip().replace(" ", "").upper()
    if not normalized:
        raise RuntimeError("Missing Groww TOTP secret.")
    padding = "=" * ((8 - len(normalized) % 8) % 8)
    key = base64.b32decode(normalized + padding, casefold=True)
    timestamp = int(for_time or time.time())
    counter = timestamp // interval_seconds
    digest = hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF) % (10**digits)
    return str(code).zfill(digits)


def generate_approval_checksum(secret: str, timestamp: str) -> str:
    return hashlib.sha256(f"{secret}{timestamp}".encode("utf-8")).hexdigest()


def read_json_cache(path: Path) -> object | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_cache(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def retry_api_call(fn, *, label: str, attempts: int = 5, base_sleep_seconds: float = 1.5):
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as exc:  # pragma: no cover - depends on remote service
            last_error = exc
            if attempt == attempts:
                raise
            time.sleep(base_sleep_seconds * attempt)
    if last_error is not None:
        raise last_error
    raise RuntimeError(f"Unexpected retry state for {label}.")


def request_access_token(api_key: str, payload: dict[str, str]) -> str:
    request = urllib.request.Request(
        "https://api.groww.in/v1/token/api/access",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw_body = exc.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw_body)
        except json.JSONDecodeError:
            body = {"message": raw_body}
        message = (
            body.get("errorMessage", {}).get("message")
            if isinstance(body.get("errorMessage"), dict)
            else body.get("message")
        ) or raw_body
        raise RuntimeError(
            "Groww access-token mint failed with "
            f"HTTP {exc.code}: {message}. "
            "Official Groww docs require a User API Key from the Trading APIs / Cloud API Keys page, "
            "plus daily approval for API-key flows."
        ) from exc
    token = (
        body.get("access_token")
        or body.get("token")
        or body.get("jwtToken")
        or ""
    )
    if not token:
        raise RuntimeError(
            "Groww returned a token-mint response without an access token. "
            f"Response keys: {sorted(body.keys())}"
        )
    return str(token)


def init_client(env_files: list[Path]) -> GrowwAPI:
    load_env_files(env_files)
    token = os.getenv("GROWW_ACCESS_TOKEN")
    if not token:
        api_key = os.getenv("GROWW_API_KEY")
        api_secret = os.getenv("GROWW_API_SECRET")
        totp_secret = os.getenv("GROWW_TOTP_SECRET")
        totp_code = os.getenv("GROWW_TOTP_CODE")
        if api_key and (api_secret or totp_secret or totp_code):
            if totp_secret or totp_code:
                token = request_access_token(
                    api_key,
                    {
                        "key_type": "totp",
                        "totp": totp_code or generate_totp_code(totp_secret or ""),
                    },
                )
            else:
                timestamp = str(int(time.time()))
                token = request_access_token(
                    api_key,
                    {
                        "key_type": "approval",
                        "checksum": generate_approval_checksum(api_secret or "", timestamp),
                        "timestamp": timestamp,
                    },
                )
    if not token:
        raise RuntimeError(
            "Missing Groww credentials. Set `GROWW_ACCESS_TOKEN`, or `GROWW_API_KEY` plus "
            "`GROWW_API_SECRET`/`GROWW_TOTP_SECRET`/`GROWW_TOTP_CODE`, or add them to one of: "
            + ", ".join(str(path) for path in env_files)
        )
    return GrowwAPI(token)


def parse_contract_symbol(groww_symbol: str) -> ParsedContract:
    parts = groww_symbol.split("-")
    if len(parts) < 4:
        raise ValueError(f"Unexpected Groww contract format: {groww_symbol}")
    exchange = parts[0]
    option_type = parts[-1]
    if option_type == "FUT":
        underlying_symbol = "-".join(parts[1:-2])
        expiry_label = parts[-2]
        strike = None
    else:
        underlying_symbol = "-".join(parts[1:-3])
        expiry_label = parts[-3]
        strike = float(parts[-2])
    return ParsedContract(
        groww_symbol=groww_symbol,
        exchange=exchange,
        underlying_symbol=underlying_symbol,
        expiry_label=expiry_label,
        strike_price=strike,
        option_type=option_type,
    )


def extract_expiries(response: object) -> list[str]:
    if isinstance(response, dict):
        data = response.get("expiries")
        if isinstance(data, list):
            return [str(item) for item in data]
    return []


def extract_contracts(response: object) -> list[str]:
    if isinstance(response, dict):
        data = response.get("contracts")
        if isinstance(data, list):
            return [str(item) for item in data]
    return []


def choose_expiry(expiries: list[str], trade_date: pd.Timestamp, expiry_offset: int = 0) -> str | None:
    future_expiries = sorted(date for date in expiries if pd.Timestamp(date) >= trade_date.normalize())
    if expiry_offset >= len(future_expiries):
        return None
    return future_expiries[expiry_offset]


def choose_atm_contract(contracts: list[str], direction: str, spot_price: float) -> ParsedContract | None:
    desired_type = "CE" if direction.upper() == "LONG" else "PE"
    parsed = []
    for symbol in contracts:
        try:
            contract = parse_contract_symbol(symbol)
        except Exception:
            continue
        if contract.option_type != desired_type or contract.strike_price is None:
            continue
        parsed.append(contract)
    if not parsed:
        return None
    return min(parsed, key=lambda item: (abs(float(item.strike_price) - float(spot_price)), float(item.strike_price)))


def candles_to_frame(response: object) -> pd.DataFrame:
    candles = response.get("candles") if isinstance(response, dict) else None
    if not isinstance(candles, list):
        return pd.DataFrame()
    rows = []
    for candle in candles:
        if not isinstance(candle, list) or len(candle) < 6:
            continue
        rows.append(
            {
                "timestamp": pd.Timestamp(candle[0]),
                "open": float(candle[1]),
                "high": float(candle[2]),
                "low": float(candle[3]),
                "close": float(candle[4]),
                "volume": float(candle[5]),
                "oi": None if len(candle) < 7 or candle[6] is None else float(candle[6]),
            }
        )
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame
    frame = frame.sort_values("timestamp").reset_index(drop=True)
    return frame


def candle_cache_path(cache_dir: Path, groww_symbol: str, session_date: pd.Timestamp) -> Path:
    safe_symbol = groww_symbol.replace("/", "_")
    return cache_dir / f"{safe_symbol}_{session_date.strftime('%Y%m%d')}.json"


def expiries_cache_path(cache_dir: Path, symbol_name: str, year: int | None, month: int | None) -> Path:
    year_part = "all" if year is None else str(year)
    month_part = "all" if month is None else f"{month:02d}"
    return cache_dir / "expiries" / f"{symbol_name}_{year_part}_{month_part}.json"


def contracts_cache_path(cache_dir: Path, symbol_name: str, expiry_date: str) -> Path:
    return cache_dir / "contracts" / f"{symbol_name}_{expiry_date}.json"


def result_cache_path(cache_dir: Path, symbol_name: str, expiry_offset: int) -> Path:
    return cache_dir / "results" / f"{symbol_name}_expiry{expiry_offset}.json"


def fetch_expiries_cached(
    client: GrowwAPI,
    symbol_name: str,
    cache_dir: Path,
    *,
    year: int | None = None,
    month: int | None = None,
    refresh: bool = False,
) -> list[str]:
    path = expiries_cache_path(cache_dir, symbol_name, year, month)
    if not refresh:
        cached = read_json_cache(path)
        if isinstance(cached, dict):
            expiries = extract_expiries(cached)
            if expiries:
                return expiries
    response = retry_api_call(
        lambda: client.get_expiries(
            exchange=client.EXCHANGE_NSE,
            underlying_symbol=symbol_name,
            year=year,
            month=month,
        ),
        label=f"get_expiries({symbol_name}, year={year}, month={month})",
    )
    write_json_cache(path, response)
    return extract_expiries(response)


def fetch_contracts_cached(
    client: GrowwAPI,
    symbol_name: str,
    expiry_date: str,
    cache_dir: Path,
    *,
    refresh: bool = False,
) -> list[str]:
    path = contracts_cache_path(cache_dir, symbol_name, expiry_date)
    if not refresh:
        cached = read_json_cache(path)
        if isinstance(cached, dict):
            contracts = extract_contracts(cached)
            if contracts:
                return contracts
    response = retry_api_call(
        lambda: client.get_contracts(
            exchange=client.EXCHANGE_NSE,
            underlying_symbol=symbol_name,
            expiry_date=expiry_date,
        ),
        label=f"get_contracts({symbol_name}, expiry={expiry_date})",
    )
    write_json_cache(path, response)
    return extract_contracts(response)


def fetch_option_day_candles(
    client: GrowwAPI,
    groww_symbol: str,
    session_date: pd.Timestamp,
    cache_dir: Path,
    *,
    refresh: bool = False,
) -> pd.DataFrame:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = candle_cache_path(cache_dir, groww_symbol, session_date)
    if not refresh:
        cached = read_json_cache(cache_path)
        if cached is not None:
            return candles_to_frame(cached)

    response = retry_api_call(
        lambda: client.get_historical_candles(
            exchange=client.EXCHANGE_NSE,
            segment=client.SEGMENT_FNO,
            groww_symbol=groww_symbol,
            start_time=f"{session_date.strftime('%Y-%m-%d')} 09:15:00",
            end_time=f"{session_date.strftime('%Y-%m-%d')} 15:30:00",
            candle_interval=client.CANDLE_INTERVAL_MIN_15,
        ),
        label=f"get_historical_candles({groww_symbol}, {session_date.strftime('%Y-%m-%d')})",
    )
    write_json_cache(cache_path, response)
    return candles_to_frame(response)


def nearest_bar_open(frame: pd.DataFrame, at_or_after: pd.Timestamp) -> tuple[pd.Timestamp, float] | tuple[None, None]:
    if frame.empty:
        return None, None
    subset = frame[frame["timestamp"] >= at_or_after]
    if subset.empty:
        return None, None
    row = subset.iloc[0]
    return pd.Timestamp(row["timestamp"]), float(row["open"])


def last_close(frame: pd.DataFrame) -> tuple[pd.Timestamp, float] | tuple[None, None]:
    if frame.empty:
        return None, None
    row = frame.iloc[-1]
    return pd.Timestamp(row["timestamp"]), float(row["close"])


def load_instruments_frame(client: GrowwAPI, cache_dir: Path, refresh: bool = False) -> pd.DataFrame:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / "groww_instruments.csv"
    if path.exists() and not refresh:
        return pd.read_csv(path, low_memory=False)
    frame = retry_api_call(client.get_all_instruments, label="get_all_instruments")
    frame.to_csv(path, index=False)
    return frame


def lot_size_for_symbol(instruments: pd.DataFrame, groww_symbol: str) -> int | None:
    if instruments.empty or "groww_symbol" not in instruments.columns or "lot_size" not in instruments.columns:
        return None
    matched = instruments[instruments["groww_symbol"] == groww_symbol]
    if matched.empty:
        return None
    value = matched["lot_size"].iloc[0]
    try:
        return int(float(value))
    except Exception:
        return None


def build_recent_option_backtest(
    client: GrowwAPI,
    symbol_name: str,
    cache_dir: Path,
    expiry_offset: int = 0,
    refresh_cache: bool = False,
    refresh_results: bool = False,
) -> dict:
    result_path = result_cache_path(cache_dir, symbol_name, expiry_offset)
    if not refresh_results:
        cached_result = read_json_cache(result_path)
        if isinstance(cached_result, dict):
            return cached_result

    config = UNDERLYING_SYMBOLS[symbol_name]
    spec = DEFAULT_SIGNAL_SPECS[symbol_name]
    recent_frame = session_frame(config["yahoo"], config["benchmark"], "60d", "15m")
    signal_result = evaluate_candidate(recent_frame, spec)
    trades = signal_result["trades"].copy()
    if trades.empty:
        result = {"symbol": symbol_name, "signal_spec": spec_to_dict(spec), "trade_count": 0, "option_trades": []}
        write_json_cache(result_path, result)
        return result

    instruments = load_instruments_frame(client, cache_dir / "instruments", refresh=refresh_cache)
    expiries_by_year: dict[int, list[str]] = {}
    contracts_by_expiry: dict[str, list[str]] = {}
    option_trades = []

    for _, trade in trades.iterrows():
        session_date = pd.Timestamp(trade["session"]).normalize()
        if session_date.year not in expiries_by_year:
            expiries_by_year[session_date.year] = fetch_expiries_cached(
                client,
                symbol_name,
                cache_dir,
                year=session_date.year,
                refresh=refresh_cache,
            )
        expiry = choose_expiry(expiries_by_year[session_date.year], session_date, expiry_offset=expiry_offset)
        if expiry is None:
            option_trades.append(
                {
                    "session": session_date.strftime("%Y-%m-%d"),
                    "direction": trade["direction"],
                    "status": "missing_expiry",
                }
            )
            continue

        if expiry not in contracts_by_expiry:
            contracts_by_expiry[expiry] = fetch_contracts_cached(
                client,
                symbol_name,
                expiry,
                cache_dir,
                refresh=refresh_cache,
            )
        contract = choose_atm_contract(contracts_by_expiry[expiry], str(trade["direction"]), float(trade["entry_price"]))
        if contract is None:
            option_trades.append(
                {
                    "session": session_date.strftime("%Y-%m-%d"),
                    "direction": trade["direction"],
                    "expiry_date": expiry,
                    "status": "missing_contract",
                }
            )
            continue

        candles = fetch_option_day_candles(
            client,
            contract.groww_symbol,
            session_date,
            cache_dir / "candles",
            refresh=refresh_cache,
        )
        entry_time = pd.Timestamp(f"{session_date.strftime('%Y-%m-%d')} 13:15:00")
        entry_ts, entry_price = nearest_bar_open(candles, entry_time)
        exit_ts, exit_price = last_close(candles)
        if entry_price is None or exit_price is None:
            option_trades.append(
                {
                    "session": session_date.strftime("%Y-%m-%d"),
                    "direction": trade["direction"],
                    "expiry_date": expiry,
                    "contract": contract.groww_symbol,
                    "status": "missing_candles",
                }
            )
            continue

        lot_size = lot_size_for_symbol(instruments, contract.groww_symbol)
        pnl_points = float(exit_price - entry_price)
        pnl_rupees = pnl_points * lot_size if lot_size is not None else None
        option_trades.append(
            {
                "session": session_date.strftime("%Y-%m-%d"),
                "direction": trade["direction"],
                "underlying_entry_price": round(float(trade["entry_price"]), 2),
                "underlying_exit_price": round(float(trade["exit_price"]), 2),
                "underlying_pnl_points": round(float(trade["pnl_points"]), 2),
                "expiry_date": expiry,
                "contract": contract.groww_symbol,
                "strike_price": contract.strike_price,
                "option_type": contract.option_type,
                "lot_size": lot_size,
                "entry_timestamp": entry_ts.strftime("%Y-%m-%d %H:%M:%S") if entry_ts is not None else None,
                "entry_price": round(entry_price, 2),
                "exit_timestamp": exit_ts.strftime("%Y-%m-%d %H:%M:%S") if exit_ts is not None else None,
                "exit_price": round(exit_price, 2),
                "pnl_option_points": round(pnl_points, 2),
                "pnl_option_rupees_one_lot": None if pnl_rupees is None else round(float(pnl_rupees), 2),
                "status": "ok",
            }
        )

    ok_trades = [trade for trade in option_trades if trade["status"] == "ok"]
    pnl_points = [trade["pnl_option_points"] for trade in ok_trades]
    pnl_rupees = [trade["pnl_option_rupees_one_lot"] for trade in ok_trades if trade["pnl_option_rupees_one_lot"] is not None]
    result = {
        "symbol": symbol_name,
        "signal_spec": spec_to_dict(spec),
        "trade_count": len(option_trades),
        "completed_trade_count": len(ok_trades),
        "net_option_points": round(float(sum(pnl_points)), 2) if pnl_points else 0.0,
        "net_option_rupees_one_lot": round(float(sum(pnl_rupees)), 2) if pnl_rupees else None,
        "option_trades": option_trades,
    }
    write_json_cache(result_path, result)
    return result


def spec_to_dict(spec: CandidateSpec) -> dict:
    return {
        "threshold_pct": round(spec.threshold * 100.0, 3),
        "gap_align": spec.gap_align,
        "trend_confirm": spec.trend_confirm,
        "benchmark_align": spec.benchmark_align,
        "leader_confirm": spec.leader_confirm,
        "volume_surge": spec.volume_surge,
    }


def list_discovery(
    client: GrowwAPI,
    symbol_name: str,
    cache_dir: Path,
    max_contracts: int,
    year: int | None,
    month: int | None,
    *,
    refresh_cache: bool = False,
) -> dict:
    expiries = fetch_expiries_cached(
        client,
        symbol_name,
        cache_dir,
        year=year,
        month=month,
        refresh=refresh_cache,
    )
    output = {
        "symbol": symbol_name,
        "expiries": expiries[:12],
        "contracts": {},
    }
    for expiry in expiries[:2]:
        contracts = fetch_contracts_cached(
            client,
            symbol_name,
            expiry,
            cache_dir,
            refresh=refresh_cache,
        )
        output["contracts"][expiry] = contracts[:max_contracts]
    return output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Discover and backtest Groww FNO option contracts for HDFCBANK and BAJFINANCE.")
    parser.add_argument("--symbols", nargs="+", default=["HDFCBANK", "BAJFINANCE"], choices=sorted(UNDERLYING_SYMBOLS.keys()))
    parser.add_argument("--mode", choices=["discover", "backtest"], default="discover")
    parser.add_argument("--max-contracts", type=int, default=12, help="Max contracts to print per expiry in discovery mode.")
    parser.add_argument("--year", type=int, default=None, help="Optional year override for discovery mode.")
    parser.add_argument("--month", type=int, default=None, help="Optional month override for discovery mode.")
    parser.add_argument("--expiry-offset", type=int, default=0, help="0 = nearest expiry, 1 = next expiry, etc.")
    parser.add_argument("--cache-dir", default="cache/groww_fno", help="Cache directory for instruments and candle responses.")
    parser.add_argument("--env-file", action="append", default=[], help="Extra env file(s) containing GROWW_ACCESS_TOKEN.")
    parser.add_argument("--json", action="store_true", help="Emit JSON.")
    parser.add_argument("--refresh-cache", action="store_true", help="Ignore saved API-response caches and refetch from Groww.")
    parser.add_argument("--refresh-results", action="store_true", help="Ignore saved backtest-result caches and recompute results.")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    env_files = DEFAULT_ENV_FILES + [Path(path) for path in args.env_file]
    client = init_client(env_files)
    cache_dir = Path(args.cache_dir)

    if args.mode == "discover":
        results = [
            list_discovery(
                client,
                symbol_name,
                cache_dir,
                args.max_contracts,
                args.year,
                args.month,
                refresh_cache=args.refresh_cache,
            )
            for symbol_name in args.symbols
        ]
        payload = {
            "mode": "discover",
            "results": results,
        }
    else:
        results = [
            build_recent_option_backtest(
                client,
                symbol_name,
                cache_dir / symbol_name,
                expiry_offset=args.expiry_offset,
                refresh_cache=args.refresh_cache,
                refresh_results=args.refresh_results,
            )
            for symbol_name in args.symbols
        ]
        payload = {
            "mode": "backtest",
            "note": "This uses the recent-holdout underlying stock signals from single_name_intraday_research.py and maps them to nearest-expiry ATM options.",
            "results": results,
        }

    if args.json:
        print(json.dumps(payload, indent=2))
        return

    if args.mode == "discover":
        print("Groww FNO discovery")
        for result in payload["results"]:
            print(f"{result['symbol']}")
            print(f"  expiries: {', '.join(result['expiries']) or 'none'}")
            for expiry_date, contracts in result["contracts"].items():
                print(f"  {expiry_date}: {len(contracts)} sample contracts")
                for contract in contracts[: min(len(contracts), args.max_contracts)]:
                    print(f"    {contract}")
            print()
        return

    print("Groww FNO option backtest")
    for result in payload["results"]:
        print(f"{result['symbol']}")
        print(f"  signal spec: {result['signal_spec']}")
        print(f"  completed trades: {result['completed_trade_count']} / {result['trade_count']}")
        print(f"  net option points: {result['net_option_points']}")
        print(f"  net option rupees one lot: {result['net_option_rupees_one_lot']}")
        completed = [trade for trade in result["option_trades"] if trade["status"] == "ok"]
        if completed:
            print(f"  latest completed trade: {completed[-1]}")
        else:
            print("  no completed trades")
        print()


if __name__ == "__main__":
    main()
