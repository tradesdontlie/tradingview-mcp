#!/usr/bin/env python3

from __future__ import annotations

import argparse
import io
import json
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import requests


REPO_ROOT = Path(__file__).resolve().parents[1]
RAW_ROOT = REPO_ROOT / "market" / "raw" / "nse" / "derivatives" / "bhavcopy"
PROCESSED_ROOT = REPO_ROOT / "market" / "raw" / "nse" / "options"
REPORT_ROOT = REPO_ROOT / "market" / "reports"
ARCHIVE_BASE = "https://nsearchives.nseindia.com/content/historical/DERIVATIVES"
USER_AGENT = "Mozilla/5.0"


def iter_days(start_day: date, end_day: date):
    current = start_day
    while current <= end_day:
        yield current
        current += timedelta(days=1)


def archive_file_name(day: date) -> str:
    return f"fo{day:%d%b%Y}".upper().replace("FO", "fo", 1) + "bhav.csv.zip"


def archive_url(day: date) -> str:
    return f"{ARCHIVE_BASE}/{day:%Y}/{day:%b}".replace(day.strftime("%b"), day.strftime("%b").upper()) + f"/{archive_file_name(day)}"


def zip_cache_path(day: date) -> Path:
    return RAW_ROOT / "zips" / f"{day:%Y}" / day.strftime("%b").upper() / archive_file_name(day)


def normalized_output_paths(symbol: str) -> tuple[Path, Path, Path]:
    stem = f"{symbol.upper()}_OPTIDX_eod"
    return (
        PROCESSED_ROOT / f"{stem}.parquet",
        PROCESSED_ROOT / f"{stem}.csv",
        REPORT_ROOT / f"{symbol.lower()}_nse_fo_bhavcopy_summary.json",
    )


def download_zip(day: date, *, refresh: bool = False) -> Path | None:
    path = zip_cache_path(day)
    if path.exists() and not refresh:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    response = requests.get(archive_url(day), timeout=30, headers={"User-Agent": USER_AGENT})
    if response.status_code == 404:
        return None
    response.raise_for_status()
    path.write_bytes(response.content)
    return path


def read_zip_csv(path: Path) -> pd.DataFrame:
    with zipfile.ZipFile(io.BytesIO(path.read_bytes())) as zf:
        names = zf.namelist()
        if not names:
            return pd.DataFrame()
        with zf.open(names[0]) as handle:
            frame = pd.read_csv(handle)
    return frame


def normalize_option_rows(frame: pd.DataFrame, *, symbol: str) -> pd.DataFrame:
    if frame.empty:
        return frame
    subset = frame[
        (frame["INSTRUMENT"].astype(str).str.upper() == "OPTIDX")
        & (frame["SYMBOL"].astype(str).str.upper() == symbol.upper())
    ].copy()
    if subset.empty:
        return subset
    subset = subset.rename(
        columns={
            "INSTRUMENT": "instrument",
            "SYMBOL": "symbol",
            "EXPIRY_DT": "expiry_date",
            "STRIKE_PR": "strike_price",
            "OPTION_TYP": "option_type",
            "OPEN": "open",
            "HIGH": "high",
            "LOW": "low",
            "CLOSE": "close",
            "SETTLE_PR": "settle_price",
            "CONTRACTS": "contracts",
            "VAL_INLAKH": "turnover_lakh",
            "OPEN_INT": "open_interest",
            "CHG_IN_OI": "chg_in_oi",
            "TIMESTAMP": "trade_date",
        }
    )
    subset["trade_date"] = pd.to_datetime(subset["trade_date"], format="%d-%b-%Y", errors="coerce").dt.normalize()
    subset["expiry_date"] = pd.to_datetime(subset["expiry_date"], format="%d-%b-%Y", errors="coerce").dt.normalize()
    numeric_cols = [
        "strike_price",
        "open",
        "high",
        "low",
        "close",
        "settle_price",
        "contracts",
        "turnover_lakh",
        "open_interest",
        "chg_in_oi",
    ]
    for col in numeric_cols:
        subset[col] = pd.to_numeric(subset[col], errors="coerce")
    subset["option_type"] = subset["option_type"].astype(str).str.upper()
    subset = subset.sort_values(["trade_date", "expiry_date", "strike_price", "option_type"]).reset_index(drop=True)
    return subset


def build_dataset(symbol: str, start_day: date, end_day: date, *, refresh: bool = False) -> dict:
    daily_frames: list[pd.DataFrame] = []
    seen = 0
    archived = 0
    missing = 0
    for day in iter_days(start_day, end_day):
        if day.weekday() >= 5:
            continue
        seen += 1
        path = download_zip(day, refresh=refresh)
        if path is None:
            missing += 1
            continue
        archived += 1
        raw = read_zip_csv(path)
        normalized = normalize_option_rows(raw, symbol=symbol)
        if not normalized.empty:
            daily_frames.append(normalized)
    combined = pd.concat(daily_frames, ignore_index=True) if daily_frames else pd.DataFrame()
    parquet_path, csv_path, report_path = normalized_output_paths(symbol)
    parquet_path.parent.mkdir(parents=True, exist_ok=True)
    if parquet_path.exists():
        existing = pd.read_parquet(parquet_path)
        existing["trade_date"] = pd.to_datetime(existing["trade_date"]).dt.normalize()
        existing["expiry_date"] = pd.to_datetime(existing["expiry_date"]).dt.normalize()
        combined = pd.concat([existing, combined], ignore_index=True) if not combined.empty else existing
    if not combined.empty:
        combined = combined.drop_duplicates(subset=["trade_date", "expiry_date", "strike_price", "option_type"]).sort_values(
            ["trade_date", "expiry_date", "strike_price", "option_type"]
        ).reset_index(drop=True)
        combined.to_parquet(parquet_path, index=False)
        combined.to_csv(csv_path, index=False)
    summary = {
        "symbol": symbol.upper(),
        "start": start_day.isoformat(),
        "end": end_day.isoformat(),
        "archive_base": ARCHIVE_BASE,
        "sessions_checked": seen,
        "archives_downloaded_or_cached": archived,
        "archives_missing": missing,
        "row_count": int(len(combined)),
        "trade_dates": int(combined["trade_date"].nunique()) if not combined.empty else 0,
        "expiries": int(combined["expiry_date"].nunique()) if not combined.empty else 0,
        "strikes": int(combined["strike_price"].nunique()) if not combined.empty else 0,
        "option_types": sorted(combined["option_type"].dropna().astype(str).unique().tolist()) if not combined.empty else [],
        "parquet_path": str(parquet_path.resolve()),
        "csv_path": str(csv_path.resolve()),
    }
    report_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    summary["report_path"] = str(report_path.resolve())
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fetch and cache official NSE derivative bhavcopy archives for option EOD data.")
    parser.add_argument("--symbol", default="NIFTY", choices=["NIFTY", "BANKNIFTY"])
    parser.add_argument("--start", default=f"{date.today().year}-01-01", help="Start date YYYY-MM-DD.")
    parser.add_argument("--end", default=date.today().isoformat(), help="End date YYYY-MM-DD.")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    start_day = datetime.strptime(args.start, "%Y-%m-%d").date()
    end_day = datetime.strptime(args.end, "%Y-%m-%d").date()
    if end_day < start_day:
        raise SystemExit("--end must be on or after --start")
    summary = build_dataset(args.symbol, start_day, end_day, refresh=args.refresh)
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print("NSE F&O bhavcopy archive")
        for key, value in summary.items():
            print(f"  {key}: {value}")


if __name__ == "__main__":
    main()
