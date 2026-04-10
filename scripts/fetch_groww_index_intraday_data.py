#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable

import pandas as pd

try:
    from growwapi import GrowwAPI
except ImportError as exc:  # pragma: no cover - runtime dependency
    raise RuntimeError("growwapi is required. Install it with `pip install growwapi`.") from exc


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV_FILES = [
    REPO_ROOT / "config" / "runtime.env",
    REPO_ROOT / "config" / "local.env",
]
DEFAULT_RAW_DIR = REPO_ROOT / "market" / "raw" / "groww"
DEFAULT_MANIFEST = REPO_ROOT / "market" / "manifest.json"
MAX_RANGE_DAYS = {
    "1hour": 175,
    "15minute": 85,
}


@dataclass(frozen=True)
class IndexSpec:
    name: str
    groww_symbol: str


INDEX_SPECS = {
    "NIFTY": IndexSpec(name="NIFTY", groww_symbol="NSE-NIFTY"),
    "BANKNIFTY": IndexSpec(name="BANKNIFTY", groww_symbol="NSE-BANKNIFTY"),
}

INTERVALS = {
    "1hour": "CANDLE_INTERVAL_HOUR_1",
    "15minute": "CANDLE_INTERVAL_MIN_15",
}


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


def read_json(path: Path) -> object | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


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


def candles_to_frame(candles: list[list], *, interval: str) -> pd.DataFrame:
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
                "interval": interval,
            }
        )
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame
    return frame.sort_values("timestamp").drop_duplicates(subset=["timestamp"]).reset_index(drop=True)


def fetch_chunk(
    client: GrowwAPI,
    spec: IndexSpec,
    interval: str,
    chunk_start: date,
    chunk_end: date,
    raw_dir: Path,
    *,
    refresh: bool = False,
) -> pd.DataFrame:
    path = chunk_cache_path(raw_dir, spec.name, interval, chunk_start, chunk_end)
    if not refresh:
        cached = read_json(path)
        if isinstance(cached, dict):
            return candles_to_frame(cached.get("candles", []), interval=interval)

    response = retry_api_call(
        lambda: client.get_historical_candles(
            exchange=client.EXCHANGE_NSE,
            segment=client.SEGMENT_CASH,
            groww_symbol=spec.groww_symbol,
            start_time=f"{chunk_start.isoformat()} 09:15:00",
            end_time=f"{chunk_end.isoformat()} 15:30:00",
            candle_interval=getattr(client, INTERVALS[interval]),
        )
    )
    write_json(path, response)
    candles = response.get("candles", []) if isinstance(response, dict) else []
    return candles_to_frame(candles, interval=interval)


def fetch_symbol_history(
    client: GrowwAPI,
    spec: IndexSpec,
    interval: str,
    start_day: date,
    end_day: date,
    raw_dir: Path,
    *,
    refresh: bool = False,
) -> pd.DataFrame:
    frames = []
    for chunk_start, chunk_end in chunk_ranges(start_day, end_day, MAX_RANGE_DAYS[interval]):
        frame = fetch_chunk(client, spec, interval, chunk_start, chunk_end, raw_dir, refresh=refresh)
        if not frame.empty:
            frames.append(frame)
    if not frames:
        return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume", "oi", "interval", "symbol", "groww_symbol", "source"])
    frame = pd.concat(frames, ignore_index=True)
    frame = frame.sort_values("timestamp").drop_duplicates(subset=["timestamp"]).reset_index(drop=True)
    frame["symbol"] = spec.name
    frame["groww_symbol"] = spec.groww_symbol
    frame["source"] = "groww"
    return frame


def save_symbol_history(frame: pd.DataFrame, spec: IndexSpec, interval: str, raw_dir: Path) -> dict:
    raw_dir.mkdir(parents=True, exist_ok=True)
    csv_path = raw_dir / f"{spec.name}_{interval}.csv"
    parquet_path = raw_dir / f"{spec.name}_{interval}.parquet"
    frame.to_csv(csv_path, index=False)
    frame.to_parquet(parquet_path, index=False)
    return {
        "rows": int(len(frame)),
        "start": None if frame.empty else pd.Timestamp(frame["timestamp"].min()).strftime("%Y-%m-%d %H:%M:%S"),
        "end": None if frame.empty else pd.Timestamp(frame["timestamp"].max()).strftime("%Y-%m-%d %H:%M:%S"),
        "path_csv": str(csv_path.resolve()),
        "path_parquet": str(parquet_path.resolve()),
        "columns": list(frame.columns),
        "source": "groww",
        "interval": interval,
    }


def update_manifest(manifest_path: Path, entries: dict[str, dict]) -> None:
    manifest: dict[str, object] = {}
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest.update(entries)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Download and cache Groww intraday index history for NIFTY and BANKNIFTY.")
    parser.add_argument("--symbols", nargs="+", default=["NIFTY", "BANKNIFTY"], choices=sorted(INDEX_SPECS.keys()))
    parser.add_argument("--intervals", nargs="+", default=["1hour", "15minute"], choices=sorted(INTERVALS.keys()))
    parser.add_argument("--start", type=str, default="2020-01-01", help="Start date YYYY-MM-DD.")
    parser.add_argument("--end", type=str, default=None, help="End date YYYY-MM-DD.")
    parser.add_argument("--raw-dir", default=str(DEFAULT_RAW_DIR), help="Directory for raw chunk caches and assembled symbol files.")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST), help="Market manifest path.")
    parser.add_argument("--env-file", action="append", default=[], help="Extra env file(s) with GROWW_ACCESS_TOKEN.")
    parser.add_argument("--refresh", action="store_true", help="Refetch Groww chunk caches.")
    parser.add_argument("--json", action="store_true", help="Emit a JSON summary.")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    start_day = datetime.strptime(args.start, "%Y-%m-%d").date()
    end_day = datetime.strptime(args.end, "%Y-%m-%d").date() if args.end else date.today()
    env_files = DEFAULT_ENV_FILES + [Path(path) for path in args.env_file]
    raw_dir = Path(args.raw_dir)
    manifest_path = Path(args.manifest)

    client = init_client(env_files)
    entries: dict[str, dict] = {}

    for symbol_name in args.symbols:
        spec = INDEX_SPECS[symbol_name]
        for interval in args.intervals:
            frame = fetch_symbol_history(client, spec, interval, start_day, end_day, raw_dir, refresh=args.refresh)
            entries[f"groww_{symbol_name.lower()}_{interval}"] = save_symbol_history(frame, spec, interval, raw_dir)

    update_manifest(manifest_path, entries)

    summary = {
        "start": start_day.isoformat(),
        "end": end_day.isoformat(),
        "symbols": args.symbols,
        "intervals": args.intervals,
        "entries": entries,
    }
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print("Downloaded Groww intraday index history")
        for key, value in entries.items():
            print(f"- {key}: {value['start']} -> {value['end']} ({value['rows']} rows)")


if __name__ == "__main__":
    main()
