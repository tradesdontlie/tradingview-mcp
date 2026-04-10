#!/usr/bin/env python3

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import pandas as pd

from kite_api import (
    DEFAULT_ENV_FILES,
    get_order_charges,
    load_env_files,
    require_env,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPORT_PATH = REPO_ROOT / "market" / "reports" / "kite_strict_execution_report_2020.json"
DEFAULT_INSTRUMENTS = REPO_ROOT / "market" / "raw" / "kite" / "reference" / "instruments_latest.csv"
DEFAULT_OPTION_JOURNALS = REPO_ROOT / "market" / "paper_trades_kite"

BASE_SPECS = {
    "NIFTY": {"threshold": 0.0040, "fallback_lot_size": 65},
    "BANKNIFTY": {"threshold": 0.0035, "fallback_lot_size": 30},
}
SLIPPAGE_POINTS_PER_SIDE = (0.0, 0.5, 1.0)
CHARGE_CHUNK_SIZE = 100


def load_research_module():
    spec = importlib.util.spec_from_file_location("india_intraday_research", REPO_ROOT / "scripts" / "india_intraday_research.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_instruments() -> pd.DataFrame:
    if not DEFAULT_INSTRUMENTS.exists():
        raise RuntimeError(f"Missing Kite instrument dump: {DEFAULT_INSTRUMENTS}")
    frame = pd.read_csv(DEFAULT_INSTRUMENTS, low_memory=False)
    for column in ("instrument_token", "lot_size", "strike", "tick_size"):
        if column in frame.columns:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
    if "expiry" in frame.columns:
        frame["expiry"] = pd.to_datetime(frame["expiry"], errors="coerce")
    return frame


def representative_future(symbol_name: str) -> dict:
    instruments = load_instruments()
    subset = instruments[
        (instruments["exchange"].astype(str).str.upper() == "NFO")
        & (instruments["name"].fillna("").astype(str).str.upper() == symbol_name.upper())
        & (instruments["instrument_type"].astype(str).str.upper() == "FUT")
        & instruments["expiry"].notna()
    ].copy()
    if subset.empty:
        raise RuntimeError(f"Could not find a live NFO future for {symbol_name}")
    subset = subset.sort_values(["expiry", "tradingsymbol"]).reset_index(drop=True)
    row = subset.iloc[0]
    return {
        "tradingsymbol": str(row["tradingsymbol"]),
        "exchange": "NFO",
        "expiry": row["expiry"].strftime("%Y-%m-%d"),
        "tick_size": float(row["tick_size"]) if pd.notna(row["tick_size"]) else None,
        "lot_size": int(row["lot_size"]) if pd.notna(row["lot_size"]) else None,
    }


def chunked(iterable: list[dict], size: int) -> list[list[dict]]:
    return [iterable[idx : idx + size] for idx in range(0, len(iterable), size)]


def build_futures_orders(trades: pd.DataFrame, future_symbol: str, lot_size: int) -> tuple[list[dict], list[tuple[int, int]]]:
    orders: list[dict] = []
    mapping: list[tuple[int, int]] = []
    for idx, trade in trades.reset_index(drop=True).iterrows():
        entry_side = "BUY" if str(trade["direction"]).upper() == "LONG" else "SELL"
        exit_side = "SELL" if entry_side == "BUY" else "BUY"
        entry_order_idx = len(orders)
        orders.append(
            {
                "order_id": f"trade_{idx}_entry",
                "exchange": "NFO",
                "tradingsymbol": future_symbol,
                "transaction_type": entry_side,
                "variety": "regular",
                "product": "MIS",
                "order_type": "MARKET",
                "quantity": int(lot_size),
                "average_price": round(float(trade["entry_price"]), 2),
            }
        )
        exit_order_idx = len(orders)
        orders.append(
            {
                "order_id": f"trade_{idx}_exit",
                "exchange": "NFO",
                "tradingsymbol": future_symbol,
                "transaction_type": exit_side,
                "variety": "regular",
                "product": "MIS",
                "order_type": "MARKET",
                "quantity": int(lot_size),
                "average_price": round(float(trade["exit_price"]), 2),
            }
        )
        mapping.append((entry_order_idx, exit_order_idx))
    return orders, mapping


def fetch_charge_rows(api_key: str, access_token: str, orders: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for batch in chunked(orders, CHARGE_CHUNK_SIZE):
        payload = get_order_charges(api_key, access_token, batch)
        rows.extend(payload.get("data", []) if isinstance(payload, dict) else [])
    return rows


def apply_costs(
    trades: pd.DataFrame,
    charge_rows: list[dict],
    mapping: list[tuple[int, int]],
    *,
    lot_size: int,
    slippage_points_per_side: float,
) -> pd.DataFrame:
    frame = trades.reset_index(drop=True).copy()
    per_trade_slippage_inr = float(slippage_points_per_side) * 2.0 * lot_size
    charges = []
    for entry_idx, exit_idx in mapping:
        entry_total = float(charge_rows[entry_idx]["charges"]["total"])
        exit_total = float(charge_rows[exit_idx]["charges"]["total"])
        charges.append(entry_total + exit_total)
    frame["gross_inr"] = frame["pnl_points"].astype(float) * lot_size
    frame["charges_inr"] = charges
    frame["slippage_inr"] = per_trade_slippage_inr
    frame["net_inr"] = frame["gross_inr"] - frame["charges_inr"] - frame["slippage_inr"]
    frame["net_points_equiv"] = frame["net_inr"] / lot_size
    return frame


def summarize_trade_costs(frame: pd.DataFrame, *, lot_size: int, slippage_points_per_side: float) -> dict:
    if frame.empty:
        return {
            "trade_count": 0,
            "gross_points": 0.0,
            "gross_inr_one_lot": 0.0,
            "charges_inr_one_lot": 0.0,
            "slippage_points_per_side": slippage_points_per_side,
            "slippage_inr_one_lot": 0.0,
            "net_points_equiv": 0.0,
            "net_inr_one_lot": 0.0,
            "win_rate_after_costs": 0.0,
            "avg_charge_inr_per_trade": 0.0,
            "avg_net_inr_per_trade": 0.0,
        }
    return {
        "trade_count": int(len(frame)),
        "gross_points": round(float(frame["pnl_points"].sum()), 2),
        "gross_inr_one_lot": round(float(frame["gross_inr"].sum()), 2),
        "charges_inr_one_lot": round(float(frame["charges_inr"].sum()), 2),
        "slippage_points_per_side": float(slippage_points_per_side),
        "slippage_inr_one_lot": round(float(frame["slippage_inr"].sum()), 2),
        "net_points_equiv": round(float(frame["net_points_equiv"].sum()), 2),
        "net_inr_one_lot": round(float(frame["net_inr"].sum()), 2),
        "win_rate_after_costs": round(float((frame["net_inr"] > 0.0).mean() * 100.0), 2),
        "avg_charge_inr_per_trade": round(float(frame["charges_inr"].mean()), 2),
        "avg_net_inr_per_trade": round(float(frame["net_inr"].mean()), 2),
    }


def build_option_journal_section(api_key: str, access_token: str) -> dict:
    journals = sorted(DEFAULT_OPTION_JOURNALS.glob("*.json"))
    if not journals:
        return {
            "exact_historical_backtest_possible": False,
            "reason": "No Kite option journals exist yet.",
            "recent_closed_examples": [],
        }
    recent = []
    for path in journals:
        payload = json.loads(path.read_text(encoding="utf-8"))
        report = payload if isinstance(payload, dict) else {}
        if not isinstance(report, dict) or report.get("status") != "closed" or not report.get("option_contract"):
            continue
        lot_size = int(report.get("lot_size") or 0)
        if lot_size <= 0:
            continue
        orders = [
            {
                "order_id": f"{path.stem}_entry",
                "exchange": "NFO",
                "tradingsymbol": str(report["option_contract"]),
                "transaction_type": "BUY",
                "variety": "regular",
                "product": "MIS",
                "order_type": "MARKET",
                "quantity": lot_size,
                "average_price": round(float(report["entry_price"]), 2),
            },
            {
                "order_id": f"{path.stem}_exit",
                "exchange": "NFO",
                "tradingsymbol": str(report["option_contract"]),
                "transaction_type": "SELL",
                "variety": "regular",
                "product": "MIS",
                "order_type": "MARKET",
                "quantity": lot_size,
                "average_price": round(float(report["exit_price"]), 2),
            },
        ]
        charge_rows = fetch_charge_rows(api_key, access_token, orders)
        total_charges = sum(float(row["charges"]["total"]) for row in charge_rows)
        gross_inr = float(report["pnl_inr_one_lot"])
        recent.append(
            {
                "session": str(report.get("session")),
                "symbol": str(report.get("symbol")),
                "option_contract": str(report.get("option_contract")),
                "entry_price": round(float(report["entry_price"]), 2),
                "exit_price": round(float(report["exit_price"]), 2),
                "gross_inr_one_lot": round(gross_inr, 2),
                "charges_inr_one_lot": round(total_charges, 2),
                "net_inr_one_lot": round(gross_inr - total_charges, 2),
            }
        )
    return {
        "exact_historical_backtest_possible": False,
        "reason": (
            "Kite historical options require expired instrument tokens, but this repo only has the current-day instrument dump. "
            "That means exact ATM option reconstruction back to 2020 is not possible without archived daily instrument masters."
        ),
        "recent_closed_examples": recent,
    }


def build_symbol_report(module, api_key: str, access_token: str, symbol_name: str) -> dict:
    config = BASE_SPECS[symbol_name]
    lot_sizes = module.fetch_lot_sizes()
    lot_size = int(lot_sizes.get(module.SYMBOLS[symbol_name]["nse_symbol"], config["fallback_lot_size"]))
    vix = module.load_vix()
    yahoo_symbol = module.SYMBOLS[symbol_name]["yahoo"]
    daily, daily_source = module.load_daily(symbol_name, yahoo_symbol)
    recent = module.prepare_recent_validation(yahoo_symbol, daily=daily, vix=vix)
    long_history = module.prepare_long_history(yahoo_symbol, daily=daily, vix=vix)
    holdout_start = pd.Timestamp(recent["session"].min()) if not recent.empty else None
    research = long_history[long_history["session"] < holdout_start].reset_index(drop=True) if holdout_start is not None else long_history.copy()
    if len(research) <= module.TRAIN_SESSIONS + module.TEST_SESSIONS:
        research = long_history.copy()
    pseudo_oos = research.iloc[module.TRAIN_SESSIONS :].reset_index(drop=True) if len(research) > module.TRAIN_SESSIONS else research.iloc[0:0].copy()
    spec = module.CandidateSpec("mid_cont", config["threshold"], "none", False, False, False)

    future = representative_future(symbol_name)

    sample_frames = {
        "fixed_oos_research": pseudo_oos,
        "recent_holdout_15m": recent,
    }
    samples = {}
    for sample_name, frame in sample_frames.items():
        trades, _ = module.candidate_trade_frame(frame, spec)
        if trades.empty:
            samples[sample_name] = {
                "sample_range": {
                    "start": None if frame.empty else frame["session"].min().strftime("%Y-%m-%d"),
                    "end": None if frame.empty else frame["session"].max().strftime("%Y-%m-%d"),
                    "session_count": int(len(frame)),
                },
                "gross_summary": module.summary_from_trades(trades, pd.Series(dtype=float), session_count=len(frame)),
                "cost_scenarios": [],
            }
            continue

        orders, mapping = build_futures_orders(trades, future["tradingsymbol"], lot_size)
        charge_rows = fetch_charge_rows(api_key, access_token, orders)
        scenario_rows = []
        for slippage_points in SLIPPAGE_POINTS_PER_SIDE:
            costed = apply_costs(
                trades,
                charge_rows,
                mapping,
                lot_size=lot_size,
                slippage_points_per_side=slippage_points,
            )
            scenario_rows.append(summarize_trade_costs(costed, lot_size=lot_size, slippage_points_per_side=slippage_points))
        samples[sample_name] = {
            "sample_range": {
                "start": frame["session"].min().strftime("%Y-%m-%d"),
                "end": frame["session"].max().strftime("%Y-%m-%d"),
                "session_count": int(len(frame)),
            },
            "gross_summary": module.evaluate_candidate(frame, spec)["summary"],
            "cost_scenarios": scenario_rows,
        }

    return {
        "symbol": symbol_name,
        "daily_source": daily_source,
        "spec": spec.to_public_dict(),
        "lot_size": lot_size,
        "representative_future": future,
        "research_sample": {
            "start": None if research.empty else research["session"].min().strftime("%Y-%m-%d"),
            "end": None if research.empty else research["session"].max().strftime("%Y-%m-%d"),
            "session_count": int(len(research)),
        },
        "recent_holdout_sample": {
            "start": None if recent.empty else recent["session"].min().strftime("%Y-%m-%d"),
            "end": None if recent.empty else recent["session"].max().strftime("%Y-%m-%d"),
            "session_count": int(len(recent)),
        },
        "samples": samples,
    }


def lookahead_bias_audit() -> dict:
    return {
        "future_bar_leak_detected": False,
        "signal_timing": {
            "research_60m": "Signal uses the close of the 4th hourly bar and enters on the next hourly bar open.",
            "holdout_15m": "Signal uses the close of the 13:00 bar and enters on the 13:15 bar open.",
        },
        "daily_and_vix_filters": "Previous day only. The code uses daily/vix rows strictly earlier than the session date.",
        "holdout_separation": "The recent 15m holdout is removed from the search sample before evaluation.",
        "residual_bias_risks": [
            "Data-snooping risk from testing many candidate variants. This is overfitting risk, not bar-level look-ahead bias.",
            "Session completeness filtering is known only after the full day is present, which is acceptable for historical cleaning but should not be used as a live signal filter.",
            "The strict report uses spot index prices as a proxy for futures entry/exit because historical expired futures tokens are not cached.",
            "Current Zerodha charges are applied across the full 2020-2026 sample, so historical fee schedule changes are ignored.",
        ],
        "how_to_reduce_remaining_risk": [
            "Archive the full Kite instrument master every trading day so expired futures/options can be reconstructed exactly.",
            "Run the live variant unchanged through a multi-week forward paper trial and compare realized fills vs backtest assumptions.",
            "Keep the holdout untouched and avoid retuning thresholds on every new month of data.",
        ],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a stricter Kite-only execution report with Zerodha charges and bias audit.")
    parser.add_argument("--symbols", nargs="+", default=["NIFTY", "BANKNIFTY"], choices=sorted(BASE_SPECS.keys()))
    parser.add_argument("--report-path", default=str(DEFAULT_REPORT_PATH))
    parser.add_argument("--json", action="store_true")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    load_env_files(DEFAULT_ENV_FILES)
    api_key = require_env("KITE_API_KEY")
    access_token = require_env("KITE_ACCESS_TOKEN")
    module = load_research_module()

    payload = {
        "method": {
            "description": "Strict Kite-only execution report using cached Kite bars, current Zerodha order charges, and explicit futures-proxy assumptions.",
            "signal_source": "Kite spot index 60m/15m caches",
            "cost_source": "Kite /charges/orders API",
            "futures_price_assumption": (
                "Intraday entry and exit use the Kite index price as a proxy for front-month futures because expired futures instrument tokens "
                "were not archived daily in this repo."
            ),
            "options_exact_historical_status": "Not possible for 2020 onward with only the current-day Kite instrument dump.",
            "samples": ["fixed_oos_research", "recent_holdout_15m"],
        },
        "lookahead_bias_audit": lookahead_bias_audit(),
        "reports": [build_symbol_report(module, api_key, access_token, symbol_name) for symbol_name in args.symbols],
        "option_section": build_option_journal_section(api_key, access_token),
    }

    report_path = Path(args.report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    if args.json:
        print(json.dumps(payload, indent=2))
        return

    print(f"Saved strict Kite report to {report_path}")
    for report in payload["reports"]:
        print(report["symbol"])
        for sample_name, sample in report["samples"].items():
            base = sample["gross_summary"]
            print(
                f"  {sample_name}: gross {base['net_points']} pts across {base['trade_count']} trades | "
                f"Sharpe {base['session_sharpe']}"
            )
            for scenario in sample["cost_scenarios"]:
                print(
                    f"    slippage {scenario['slippage_points_per_side']} pts/side -> "
                    f"net Rs {scenario['net_inr_one_lot']} | net pts eq {scenario['net_points_equiv']}"
                )


if __name__ == "__main__":
    main()
