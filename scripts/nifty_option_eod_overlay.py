#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import nifty_kite_enhanced_research as nk  # noqa: E402


OPTION_EOD_PATH = REPO_ROOT / "market" / "raw" / "nse" / "options" / "NIFTY_OPTIDX_eod.parquet"
REPORT_PATH = REPO_ROOT / "market" / "reports" / "nifty_option_eod_overlay.json"


def summarize(series: pd.Series) -> dict:
    if series.empty:
        return {
            "trade_count": 0,
            "win_rate": None,
            "net_points": 0.0,
            "avg_points": None,
            "best_points": None,
            "worst_points": None,
        }
    wins = (series > 0).sum()
    return {
        "trade_count": int(len(series)),
        "win_rate": round(float(wins / len(series) * 100.0), 2),
        "net_points": round(float(series.sum()), 2),
        "avg_points": round(float(series.mean()), 2),
        "best_points": round(float(series.max()), 2),
        "worst_points": round(float(series.min()), 2),
    }


def load_signal_trades(candidate_name: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    nk.load_env_files(nk.DEFAULT_ENV_FILES)
    api_key = nk.require_env("KITE_API_KEY")
    access_token = nk.require_env("KITE_ACCESS_TOKEN")
    proxy = nk.ensure_proxy_15m_cache(api_key, access_token, refresh=False)
    frame = nk.build_feature_frame(proxy)
    candidates = {candidate.name: candidate for candidate in nk.candidate_pool()}
    if candidate_name not in candidates:
        raise RuntimeError(f"Unknown candidate: {candidate_name}")
    candidate = candidates[candidate_name]
    trades, _ = nk.candidate_trade_frame(frame, candidate)
    detail_cols = [
        "session",
        "signal_ret",
        "entry_time",
        "proxy_rvol_ratio",
        "or_width_1h",
        "prev_cpr_width",
        "event_name",
    ]
    detail = frame[frame["signal_bar_index"] == candidate.signal_bar_index][detail_cols].drop_duplicates(subset=["session"]).copy()
    trades = trades.merge(detail, on="session", how="left")
    return trades, frame


def load_option_eod() -> pd.DataFrame:
    if not OPTION_EOD_PATH.exists():
        raise RuntimeError(f"Missing option EOD archive: {OPTION_EOD_PATH}")
    frame = pd.read_parquet(OPTION_EOD_PATH)
    frame["trade_date"] = pd.to_datetime(frame["trade_date"]).dt.normalize()
    frame["expiry_date"] = pd.to_datetime(frame["expiry_date"]).dt.normalize()
    return frame.sort_values(["trade_date", "expiry_date", "strike_price", "option_type"]).reset_index(drop=True)


def choose_contract(option_eod: pd.DataFrame, session: pd.Timestamp, direction: str, spot_price: float) -> pd.Series | None:
    option_type = "CE" if direction == "LONG" else "PE"
    subset = option_eod[
        (option_eod["trade_date"] == session.normalize())
        & (option_eod["option_type"] == option_type)
        & (option_eod["expiry_date"] >= session.normalize())
    ].copy()
    if subset.empty:
        return None
    nearest_expiry = subset["expiry_date"].min()
    subset = subset[subset["expiry_date"] == nearest_expiry].copy()
    subset["strike_gap"] = (subset["strike_price"].astype(float) - float(spot_price)).abs()
    subset = subset.sort_values(["strike_gap", "strike_price"]).reset_index(drop=True)
    return subset.iloc[0]


def next_trade_date(option_eod: pd.DataFrame, contract_row: pd.Series) -> pd.Timestamp | None:
    subset = option_eod[
        (option_eod["expiry_date"] == contract_row["expiry_date"])
        & (option_eod["strike_price"] == contract_row["strike_price"])
        & (option_eod["option_type"] == contract_row["option_type"])
        & (option_eod["trade_date"] > contract_row["trade_date"])
    ].copy()
    if subset.empty:
        return None
    return pd.Timestamp(subset["trade_date"].min())


def lookup_contract_row(option_eod: pd.DataFrame, contract_row: pd.Series, trade_date: pd.Timestamp) -> pd.Series | None:
    subset = option_eod[
        (option_eod["trade_date"] == trade_date.normalize())
        & (option_eod["expiry_date"] == contract_row["expiry_date"])
        & (option_eod["strike_price"] == contract_row["strike_price"])
        & (option_eod["option_type"] == contract_row["option_type"])
    ]
    if subset.empty:
        return None
    return subset.iloc[0]


def build_overlay(candidate_name: str) -> dict:
    trades, frame = load_signal_trades(candidate_name)
    option_eod = load_option_eod()
    overlay_rows = []
    for _, trade in trades.iterrows():
        session = pd.Timestamp(trade["session"]).normalize()
        contract = choose_contract(option_eod, session, str(trade["direction"]), float(trade["entry_price"]))
        if contract is None:
            continue
        exit_trade_date = next_trade_date(option_eod, contract)
        if exit_trade_date is None:
            continue
        exit_row = lookup_contract_row(option_eod, contract, exit_trade_date)
        if exit_row is None:
            continue
        entry_price = float(contract["close"])
        exit_price = float(exit_row["close"])
        points = exit_price - entry_price
        overlay_rows.append(
            {
                "session": session.strftime("%Y-%m-%d"),
                "direction": str(trade["direction"]),
                "signal_ret_pct": round(float(trade["signal_ret"]) * 100.0, 3),
                "event_name": trade.get("event_name"),
                "entry_underlying": round(float(trade["entry_price"]), 2),
                "option_type": str(contract["option_type"]),
                "expiry_date": pd.Timestamp(contract["expiry_date"]).strftime("%Y-%m-%d"),
                "strike_price": round(float(contract["strike_price"]), 2),
                "entry_option_close": round(entry_price, 2),
                "exit_trade_date": pd.Timestamp(exit_trade_date).strftime("%Y-%m-%d"),
                "exit_option_close": round(exit_price, 2),
                "pnl_option_points_close_to_next_close": round(points, 2),
                "contracts": int(contract["contracts"]) if pd.notna(contract["contracts"]) else None,
                "open_interest": int(contract["open_interest"]) if pd.notna(contract["open_interest"]) else None,
                "turnover_lakh": round(float(contract["turnover_lakh"]), 2) if pd.notna(contract["turnover_lakh"]) else None,
            }
        )
    overlay = pd.DataFrame(overlay_rows)
    if overlay.empty:
        payload = {
            "candidate": candidate_name,
            "note": "No overlapping signal sessions and archived option rows yet.",
            "summary": summarize(pd.Series(dtype=float)),
            "rows": [],
        }
        REPORT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return payload

    overlay["signal_bucket"] = pd.cut(
        overlay["signal_ret_pct"].abs(),
        bins=[0.5, 0.7, 1.0, 10.0],
        labels=["0.50-0.70", "0.70-1.00", "1.00+"],
        right=False,
    )
    overlay["weekday"] = pd.to_datetime(overlay["session"]).dt.day_name()
    summary = summarize(overlay["pnl_option_points_close_to_next_close"])
    by_bucket = {
        ("NA" if pd.isna(name) else str(name)): summarize(group["pnl_option_points_close_to_next_close"])
        for name, group in overlay.groupby("signal_bucket", dropna=False, observed=False)
    }
    by_weekday = {
        str(name): summarize(group["pnl_option_points_close_to_next_close"])
        for name, group in overlay.groupby("weekday", observed=False)
    }
    payload = {
        "candidate": candidate_name,
        "option_price_model": "Entry at signal-day option close, exit at next available trade-day close for the same contract. This is an EOD archive overlay, not an intraday option backtest.",
        "available_trade_dates": int(option_eod["trade_date"].nunique()),
        "overlay_summary": summary,
        "by_signal_bucket": by_bucket,
        "by_weekday": by_weekday,
        "rows": overlay.sort_values("session").to_dict(orient="records"),
    }
    REPORT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Overlay archived NSE Nifty option EOD data on historical signal days.")
    parser.add_argument("--candidate", default="mid_1315_thr050_vwap")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    payload = build_overlay(args.candidate)
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print("Nifty option EOD overlay")
        print(f"  candidate: {payload['candidate']}")
        print(f"  trade_count: {payload['overlay_summary']['trade_count']}")
        print(f"  net_points: {payload['overlay_summary']['net_points']}")


if __name__ == "__main__":
    main()
