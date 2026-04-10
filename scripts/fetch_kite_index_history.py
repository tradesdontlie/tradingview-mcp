#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import io
import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable

import pandas as pd

from kite_api import (
    DEFAULT_ENV_FILES,
    get_historical_candles,
    get_instruments_csv,
    get_quotes,
    load_env_files,
    read_json,
    require_env,
    write_json,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RAW_DIR = REPO_ROOT / "market" / "raw" / "kite"
DEFAULT_MANIFEST = REPO_ROOT / "market" / "manifest.json"
DEFAULT_REFERENCE_DIR = DEFAULT_RAW_DIR / "reference"
DEFAULT_QUOTE_DIR = DEFAULT_RAW_DIR / "quotes"
MAX_RANGE_DAYS = {
    "day": 365,
    "60minute": 60,
    "15minute": 60,
}


@dataclass(frozen=True)
class IndexSpec:
    name: str
    quote_symbol: str
    tradingsymbol_candidates: tuple[str, ...]


INDEX_SPECS = {
    "NIFTY": IndexSpec(
        name="NIFTY",
        quote_symbol="NSE:NIFTY 50",
        tradingsymbol_candidates=("NIFTY 50", "NIFTY50", "NIFTY_50"),
    ),
    "BANKNIFTY": IndexSpec(
        name="BANKNIFTY",
        quote_symbol="NSE:NIFTY BANK",
        tradingsymbol_candidates=("NIFTY BANK", "BANKNIFTY", "NIFTY_BANK"),
    ),
}


def update_manifest(manifest_path: Path, entries: dict[str, dict]) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    manifest.update(entries)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def instruments_cache_path(reference_dir: Path, as_of_day: date) -> Path:
    return reference_dir / f"instruments_{as_of_day.isoformat()}.csv"


def read_instruments_frame(path: Path) -> pd.DataFrame:
    frame = pd.read_csv(path, low_memory=False)
    for col in ("instrument_token", "exchange_token", "lot_size"):
        if col in frame.columns:
            frame[col] = pd.to_numeric(frame[col], errors="coerce")
    return frame


def fetch_instruments_frame(
    api_key: str,
    access_token: str,
    reference_dir: Path,
    *,
    refresh: bool = False,
) -> tuple[pd.DataFrame, Path]:
    as_of_day = datetime.now().date()
    path = instruments_cache_path(reference_dir, as_of_day)
    latest_path = reference_dir / "instruments_latest.csv"
    if path.exists() and not refresh:
        frame = read_instruments_frame(path)
        if not latest_path.exists():
            latest_path.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        return frame, path
    text = get_instruments_csv(api_key, access_token)
    reference_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    latest_path.write_text(text, encoding="utf-8")
    return read_instruments_frame(path), path


def resolve_index_row(frame: pd.DataFrame, spec: IndexSpec) -> pd.Series:
    if frame.empty:
        raise RuntimeError("Kite instrument dump is empty.")
    ranked = frame.copy()
    ranked["score"] = 0
    if "exchange" in ranked.columns:
        ranked.loc[ranked["exchange"].astype(str).str.upper() == "NSE", "score"] += 2
    if "segment" in ranked.columns:
        ranked.loc[ranked["segment"].astype(str).str.upper().str.contains("INDICES", na=False), "score"] += 4
    tradingsymbol = ranked["tradingsymbol"].astype(str).str.upper() if "tradingsymbol" in ranked.columns else pd.Series(dtype=str)
    name = ranked["name"].astype(str).str.upper() if "name" in ranked.columns else pd.Series(dtype=str)
    for candidate in spec.tradingsymbol_candidates:
        candidate_upper = candidate.upper()
        ranked.loc[tradingsymbol == candidate_upper, "score"] += 10
        ranked.loc[name == candidate_upper, "score"] += 6
        ranked.loc[tradingsymbol.str.contains(candidate_upper, na=False), "score"] += 3
    ranked = ranked.sort_values(["score"], ascending=False).reset_index(drop=True)
    best = ranked.iloc[0]
    if int(best.get("score", 0)) <= 0:
        raise RuntimeError(f"Could not resolve a Kite instrument token for {spec.name} from the instrument dump.")
    return best


def chunk_ranges(start_day: date, end_day: date, chunk_days: int) -> list[tuple[date, date]]:
    ranges: list[tuple[date, date]] = []
    current = start_day
    while current <= end_day:
        chunk_end = min(current + timedelta(days=chunk_days - 1), end_day)
        ranges.append((current, chunk_end))
        current = chunk_end + timedelta(days=1)
    return ranges


def chunk_cache_path(raw_dir: Path, symbol_name: str, interval: str, chunk_start: date, chunk_end: date) -> Path:
    return raw_dir / "chunks" / f"{symbol_name}_{interval}_{chunk_start.isoformat()}_{chunk_end.isoformat()}.json"


def candles_to_frame(payload: dict, *, interval: str, symbol: str, instrument_token: int, tradingsymbol: str) -> pd.DataFrame:
    candles = payload.get("data", {}).get("candles", []) if isinstance(payload, dict) else []
    rows = []
    ts_col = "date" if interval == "day" else "timestamp"
    for candle in candles:
        if not isinstance(candle, list) or len(candle) < 6:
            continue
        ts = pd.Timestamp(candle[0]).tz_localize(None)
        rows.append(
            {
                ts_col: ts.normalize() if interval == "day" else ts,
                "open": float(candle[1]),
                "high": float(candle[2]),
                "low": float(candle[3]),
                "close": float(candle[4]),
                "volume": float(candle[5]) if candle[5] is not None else None,
                "oi": None if len(candle) < 7 or candle[6] is None else float(candle[6]),
                "symbol": symbol,
                "tradingsymbol": tradingsymbol,
                "instrument_token": int(instrument_token),
                "source": "kite",
                "interval": "1day" if interval == "day" else ("1hour" if interval == "60minute" else interval),
            }
        )
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame
    return frame.sort_values(ts_col).drop_duplicates(subset=[ts_col]).reset_index(drop=True)


def fetch_history(
    api_key: str,
    access_token: str,
    spec: IndexSpec,
    instrument_token: int,
    tradingsymbol: str,
    interval: str,
    start_day: date,
    end_day: date,
    raw_dir: Path,
    *,
    refresh: bool = False,
) -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for chunk_start, chunk_end in chunk_ranges(start_day, end_day, MAX_RANGE_DAYS[interval]):
        cache_path = chunk_cache_path(raw_dir, spec.name, interval, chunk_start, chunk_end)
        if cache_path.exists() and not refresh:
            payload = read_json(cache_path)
        else:
            payload = get_historical_candles(
                api_key,
                access_token,
                instrument_token,
                interval,
                from_ts=f"{chunk_start.isoformat()} 09:15:00",
                to_ts=f"{chunk_end.isoformat()} 15:30:00",
                oi=1,
            )
            write_json(cache_path, payload)
        if isinstance(payload, dict):
            frame = candles_to_frame(
                payload,
                interval=interval,
                symbol=spec.name,
                instrument_token=instrument_token,
                tradingsymbol=tradingsymbol,
            )
            if not frame.empty:
                frames.append(frame)
    if not frames:
        return pd.DataFrame()
    ts_col = "date" if interval == "day" else "timestamp"
    return pd.concat(frames, ignore_index=True).sort_values(ts_col).drop_duplicates(subset=[ts_col]).reset_index(drop=True)


def save_history(frame: pd.DataFrame, symbol_name: str, interval: str, raw_dir: Path) -> dict:
    raw_dir.mkdir(parents=True, exist_ok=True)
    name = "daily" if interval == "day" else ("1hour" if interval == "60minute" else interval)
    csv_path = raw_dir / f"{symbol_name}_{name}.csv"
    parquet_path = raw_dir / f"{symbol_name}_{name}.parquet"
    frame.to_csv(csv_path, index=False)
    frame.to_parquet(parquet_path, index=False)
    ts_col = "date" if interval == "day" else "timestamp"
    return {
        "rows": int(len(frame)),
        "start": None if frame.empty else str(frame[ts_col].min()),
        "end": None if frame.empty else str(frame[ts_col].max()),
        "path_csv": str(csv_path.resolve()),
        "path_parquet": str(parquet_path.resolve()),
        "columns": list(frame.columns),
        "source": "kite",
        "interval": "1day" if interval == "day" else ("1hour" if interval == "60minute" else interval),
    }


def save_reference(frame: pd.DataFrame, path: Path) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    parquet_path = path.with_suffix(".parquet")
    frame.to_csv(path, index=False)
    frame.to_parquet(parquet_path, index=False)
    return {
        "rows": int(len(frame)),
        "path_csv": str(path.resolve()),
        "path_parquet": str(parquet_path.resolve()),
        "columns": list(frame.columns),
        "source": "kite",
        "interval": "reference",
    }


def save_quote_snapshot(api_key: str, access_token: str, symbols: list[IndexSpec], quote_dir: Path) -> dict:
    quote_dir.mkdir(parents=True, exist_ok=True)
    payload = get_quotes(api_key, access_token, [spec.quote_symbol for spec in symbols], mode="quote")
    as_of = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    json_path = quote_dir / f"quote_snapshot_{as_of}.json"
    latest_path = quote_dir / "quote_snapshot_latest.json"
    write_json(json_path, payload)
    write_json(latest_path, payload)
    return {
        "rows": len(payload.get("data", {})) if isinstance(payload, dict) else 0,
        "path_json": str(json_path.resolve()),
        "path_latest_json": str(latest_path.resolve()),
        "source": "kite",
        "interval": "snapshot",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Download and cache Kite instrument master, quotes, and NIFTY/BANKNIFTY historical data.")
    parser.add_argument("--symbols", nargs="+", default=["NIFTY", "BANKNIFTY"], choices=sorted(INDEX_SPECS.keys()))
    parser.add_argument("--intervals", nargs="+", default=["day", "60minute", "15minute"], choices=sorted(MAX_RANGE_DAYS.keys()))
    parser.add_argument("--start", default="2020-01-01", help="Start date YYYY-MM-DD.")
    parser.add_argument("--end", default=None, help="End date YYYY-MM-DD. Defaults to today.")
    parser.add_argument("--raw-dir", default=str(DEFAULT_RAW_DIR))
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--refresh", action="store_true", help="Refresh instrument dump and candle chunk caches.")
    parser.add_argument("--skip-quotes", action="store_true", help="Skip the live quote snapshot fetch.")
    parser.add_argument("--json", action="store_true")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    load_env_files(DEFAULT_ENV_FILES)
    api_key = require_env("KITE_API_KEY")
    access_token = require_env("KITE_ACCESS_TOKEN")

    start_day = datetime.strptime(args.start, "%Y-%m-%d").date()
    end_day = datetime.strptime(args.end, "%Y-%m-%d").date() if args.end else date.today()
    raw_dir = Path(args.raw_dir)
    reference_dir = raw_dir / "reference"
    manifest_path = Path(args.manifest)

    instruments_frame, instruments_path = fetch_instruments_frame(api_key, access_token, reference_dir, refresh=args.refresh)
    resolved_rows = []
    entries: dict[str, dict] = {}

    for symbol_name in args.symbols:
        spec = INDEX_SPECS[symbol_name]
        row = resolve_index_row(instruments_frame, spec)
        resolved_rows.append(
            {
                "symbol": spec.name,
                "quote_symbol": spec.quote_symbol,
                "tradingsymbol": row.get("tradingsymbol"),
                "name": row.get("name"),
                "exchange": row.get("exchange"),
                "segment": row.get("segment"),
                "instrument_type": row.get("instrument_type"),
                "instrument_token": int(row.get("instrument_token")),
                "exchange_token": None if pd.isna(row.get("exchange_token")) else int(row.get("exchange_token")),
                "tick_size": None if pd.isna(row.get("tick_size")) else float(row.get("tick_size")),
                "lot_size": None if pd.isna(row.get("lot_size")) else int(row.get("lot_size")),
            }
        )
        for interval in args.intervals:
            history = fetch_history(
                api_key,
                access_token,
                spec,
                int(row["instrument_token"]),
                str(row.get("tradingsymbol")),
                interval,
                start_day,
                end_day,
                raw_dir,
                refresh=args.refresh,
            )
            entries[f"kite_{symbol_name.lower()}_{'daily' if interval == 'day' else ('1hour' if interval == '60minute' else interval)}"] = save_history(history, symbol_name, interval, raw_dir)

    resolved_frame = pd.DataFrame(resolved_rows)
    entries["kite_index_reference"] = save_reference(resolved_frame, reference_dir / "index_reference.csv")
    entries["kite_instruments_latest"] = {
        "rows": int(len(instruments_frame)),
        "path_csv": str(instruments_path.resolve()),
        "columns": list(instruments_frame.columns),
        "source": "kite",
        "interval": "reference",
    }
    if not args.skip_quotes:
        entries["kite_index_quote_snapshot"] = save_quote_snapshot(api_key, access_token, [INDEX_SPECS[name] for name in args.symbols], DEFAULT_QUOTE_DIR)

    update_manifest(manifest_path, entries)
    payload = {
        "start": start_day.isoformat(),
        "end": end_day.isoformat(),
        "symbols": args.symbols,
        "intervals": args.intervals,
        "reference_csv": str((reference_dir / "index_reference.csv").resolve()),
        "entries": entries,
    }
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
