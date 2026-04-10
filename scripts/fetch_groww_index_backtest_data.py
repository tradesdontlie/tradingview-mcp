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
import yfinance as yf

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
DEFAULT_PROCESSED_DIR = REPO_ROOT / "market" / "processed"
DEFAULT_MANIFEST = REPO_ROOT / "market" / "manifest.json"
CHUNK_DAYS = 175


@dataclass(frozen=True)
class IndexSpec:
    name: str
    groww_symbol: str
    yahoo_symbol: str


INDEX_SPECS = {
    "NIFTY": IndexSpec(name="NIFTY", groww_symbol="NSE-NIFTY", yahoo_symbol="^NSEI"),
    "BANKNIFTY": IndexSpec(name="BANKNIFTY", groww_symbol="NSE-BANKNIFTY", yahoo_symbol="^NSEBANK"),
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
        raise RuntimeError(
            "Missing `GROWW_ACCESS_TOKEN`. Add it to config/local.env or pass --env-file."
        )
    return GrowwAPI(token)


def retry_api_call(fn, *, attempts: int = 5, base_sleep_seconds: float = 1.5):
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
    raise RuntimeError("Unexpected retry state.")


def read_json(path: Path) -> object | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def chunk_ranges(start_day: date, end_day: date, chunk_days: int = CHUNK_DAYS) -> list[tuple[date, date]]:
    ranges: list[tuple[date, date]] = []
    current = start_day
    while current <= end_day:
        chunk_end = min(current + timedelta(days=chunk_days - 1), end_day)
        ranges.append((current, chunk_end))
        current = chunk_end + timedelta(days=1)
    return ranges


def chunk_cache_path(raw_dir: Path, symbol_name: str, chunk_start: date, chunk_end: date) -> Path:
    return raw_dir / "chunks" / f"{symbol_name}_{chunk_start.isoformat()}_{chunk_end.isoformat()}_1day.json"


def candles_to_frame(candles: list[list]) -> pd.DataFrame:
    rows = []
    for candle in candles:
        if not isinstance(candle, list) or len(candle) < 5:
            continue
        rows.append(
            {
                "date": pd.Timestamp(candle[0]).normalize(),
                "open": float(candle[1]),
                "high": float(candle[2]),
                "low": float(candle[3]),
                "close": float(candle[4]),
                "volume": None if len(candle) < 6 or candle[5] is None else float(candle[5]),
                "oi": None if len(candle) < 7 or candle[6] is None else float(candle[6]),
            }
        )
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame
    return frame.sort_values("date").drop_duplicates(subset=["date"]).reset_index(drop=True)


def fetch_chunk(
    client: GrowwAPI,
    spec: IndexSpec,
    chunk_start: date,
    chunk_end: date,
    raw_dir: Path,
    *,
    refresh: bool = False,
) -> pd.DataFrame:
    path = chunk_cache_path(raw_dir, spec.name, chunk_start, chunk_end)
    if not refresh:
        cached = read_json(path)
        if isinstance(cached, dict):
            return candles_to_frame(cached.get("candles", []))

    response = retry_api_call(
        lambda: client.get_historical_candles(
            exchange=client.EXCHANGE_NSE,
            segment=client.SEGMENT_CASH,
            groww_symbol=spec.groww_symbol,
            start_time=f"{chunk_start.isoformat()} 09:15:00",
            end_time=f"{chunk_end.isoformat()} 15:30:00",
            candle_interval=client.CANDLE_INTERVAL_DAY,
        )
    )
    write_json(path, response)
    candles = response.get("candles", []) if isinstance(response, dict) else []
    return candles_to_frame(candles)


def fetch_symbol_history(
    client: GrowwAPI,
    spec: IndexSpec,
    start_day: date,
    end_day: date,
    raw_dir: Path,
    *,
    refresh: bool = False,
) -> pd.DataFrame:
    frames = []
    for chunk_start, chunk_end in chunk_ranges(start_day, end_day):
        frame = fetch_chunk(client, spec, chunk_start, chunk_end, raw_dir, refresh=refresh)
        if not frame.empty:
            frames.append(frame)
    base_columns = ["date", "open", "high", "low", "close", "volume", "oi", "source", "symbol", "groww_symbol"]
    if frames:
        groww_frame = pd.concat(frames, ignore_index=True)
        groww_frame = groww_frame.sort_values("date").drop_duplicates(subset=["date"]).reset_index(drop=True)
        groww_frame["source"] = "groww"
        groww_frame["symbol"] = spec.name
        groww_frame["groww_symbol"] = spec.groww_symbol
    else:
        groww_frame = pd.DataFrame(columns=base_columns)

    backfill_end = end_day if groww_frame.empty else (pd.Timestamp(groww_frame["date"].min()).date() - timedelta(days=1))
    if backfill_end >= start_day:
        yahoo_frame = fetch_yahoo_backfill(spec, start_day, backfill_end)
        if not yahoo_frame.empty:
            frames_to_merge = [frame for frame in [yahoo_frame, groww_frame] if not frame.empty]
            merged = pd.concat(frames_to_merge, ignore_index=True)
            merged = merged.sort_values("date").drop_duplicates(subset=["date"], keep="last").reset_index(drop=True)
            return merged
    return groww_frame


def fetch_yahoo_backfill(spec: IndexSpec, start_day: date, end_day: date) -> pd.DataFrame:
    base_columns = ["date", "open", "high", "low", "close", "volume", "oi", "source", "symbol", "groww_symbol"]
    if end_day < start_day:
        return pd.DataFrame(columns=base_columns)
    history = yf.download(
        spec.yahoo_symbol,
        start=start_day.isoformat(),
        end=(end_day + timedelta(days=1)).isoformat(),
        interval="1d",
        auto_adjust=False,
        progress=False,
    )
    if history is None or history.empty:
        return pd.DataFrame(columns=base_columns)
    if isinstance(history.columns, pd.MultiIndex):
        history.columns = history.columns.get_level_values(0)
    history = history.rename(
        columns={
            "Open": "open",
            "High": "high",
            "Low": "low",
            "Close": "close",
            "Volume": "volume",
        }
    )
    frame = history.reset_index()
    date_column = "Date" if "Date" in frame.columns else frame.columns[0]
    frame = frame.rename(columns={date_column: "date"})
    frame["date"] = pd.to_datetime(frame["date"]).dt.normalize()
    frame["oi"] = None
    frame["source"] = "yfinance"
    frame["symbol"] = spec.name
    frame["groww_symbol"] = spec.groww_symbol
    return frame[base_columns].sort_values("date").drop_duplicates(subset=["date"]).reset_index(drop=True)


def save_symbol_history(frame: pd.DataFrame, spec: IndexSpec, raw_dir: Path) -> dict:
    raw_dir.mkdir(parents=True, exist_ok=True)
    csv_path = raw_dir / f"{spec.name}_daily.csv"
    parquet_path = raw_dir / f"{spec.name}_daily.parquet"
    frame.to_csv(csv_path, index=False)
    frame.to_parquet(parquet_path, index=False)
    return {
        "rows": int(len(frame)),
        "start": None if frame.empty else frame["date"].min().date().isoformat(),
        "end": None if frame.empty else frame["date"].max().date().isoformat(),
        "path_csv": str(csv_path.resolve()),
        "path_parquet": str(parquet_path.resolve()),
        "columns": list(frame.columns),
        "source": "groww+yfinance" if not frame.empty and frame["source"].nunique() > 1 else (None if frame.empty else str(frame["source"].iloc[0])),
        "interval": "1day",
    }


def save_close_matrix(frames: dict[str, pd.DataFrame], processed_dir: Path) -> dict:
    processed_dir.mkdir(parents=True, exist_ok=True)
    matrix = pd.DataFrame()
    for symbol_name, frame in frames.items():
        close_series = frame.set_index("date")["close"].rename(symbol_name)
        matrix = close_series.to_frame() if matrix.empty else matrix.join(close_series, how="outer")
    matrix = matrix.sort_index()
    csv_path = processed_dir / "india_index_daily_close.csv"
    parquet_path = processed_dir / "india_index_daily_close.parquet"
    matrix.to_csv(csv_path)
    matrix.to_parquet(parquet_path)
    return {
        "rows": int(len(matrix)),
        "columns": list(matrix.columns),
        "start": None if matrix.empty else pd.Timestamp(matrix.index.min()).date().isoformat(),
        "end": None if matrix.empty else pd.Timestamp(matrix.index.max()).date().isoformat(),
        "path_csv": str(csv_path.resolve()),
        "path_parquet": str(parquet_path.resolve()),
        "source": "groww+yfinance",
        "interval": "1day",
    }


def update_manifest(manifest_path: Path, entries: dict[str, dict]) -> None:
    manifest: dict[str, object] = {}
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest.update(entries)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Download and cache 5-10 years of Groww daily index backtest data for NIFTY and BANKNIFTY.")
    parser.add_argument("--symbols", nargs="+", default=["NIFTY", "BANKNIFTY"], choices=sorted(INDEX_SPECS.keys()))
    parser.add_argument("--years", type=int, default=10, help="How many years back from today to fetch.")
    parser.add_argument("--start", type=str, default=None, help="Optional explicit start date YYYY-MM-DD.")
    parser.add_argument("--end", type=str, default=None, help="Optional explicit end date YYYY-MM-DD.")
    parser.add_argument("--raw-dir", default=str(DEFAULT_RAW_DIR), help="Directory for raw chunk caches and assembled symbol files.")
    parser.add_argument("--processed-dir", default=str(DEFAULT_PROCESSED_DIR), help="Directory for processed combined outputs.")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST), help="Market manifest path.")
    parser.add_argument("--env-file", action="append", default=[], help="Extra env file(s) with GROWW_ACCESS_TOKEN.")
    parser.add_argument("--refresh", action="store_true", help="Refetch Groww chunk caches.")
    parser.add_argument("--json", action="store_true", help="Emit a JSON summary.")
    return parser


def resolve_date_range(args: argparse.Namespace) -> tuple[date, date]:
    end_day = datetime.strptime(args.end, "%Y-%m-%d").date() if args.end else date.today()
    if args.start:
        start_day = datetime.strptime(args.start, "%Y-%m-%d").date()
    else:
        start_day = end_day - timedelta(days=365 * args.years)
    return start_day, end_day


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    start_day, end_day = resolve_date_range(args)
    env_files = DEFAULT_ENV_FILES + [Path(path) for path in args.env_file]
    raw_dir = Path(args.raw_dir)
    processed_dir = Path(args.processed_dir)
    manifest_path = Path(args.manifest)

    client = init_client(env_files)
    symbol_frames: dict[str, pd.DataFrame] = {}
    manifest_entries: dict[str, dict] = {}

    for symbol_name in args.symbols:
        spec = INDEX_SPECS[symbol_name]
        frame = fetch_symbol_history(client, spec, start_day, end_day, raw_dir, refresh=args.refresh)
        symbol_frames[symbol_name] = frame
        manifest_entries[f"groww_{symbol_name.lower()}_daily"] = save_symbol_history(frame, spec, raw_dir)

    manifest_entries["groww_index_daily_close"] = save_close_matrix(symbol_frames, processed_dir)
    update_manifest(manifest_path, manifest_entries)

    summary = {
        "start": start_day.isoformat(),
        "end": end_day.isoformat(),
        "symbols": args.symbols,
        "entries": manifest_entries,
    }
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print("Downloaded Groww index backtest data")
        for key, value in manifest_entries.items():
            print(f"- {key}: {value['start']} -> {value['end']} ({value['rows']} rows)")


if __name__ == "__main__":
    main()
