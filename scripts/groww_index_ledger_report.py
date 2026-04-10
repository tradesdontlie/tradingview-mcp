#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import pandas as pd


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_JOURNAL_DIR = REPO_ROOT / "market" / "paper_trades"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "market" / "reports"
JOURNAL_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}_(NIFTY|BANKNIFTY)\.json$")


def read_journal(path: Path) -> dict | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def normalize_row(path: Path, payload: dict) -> dict:
    status = str(payload.get("status", "")).strip()
    realized_points = payload.get("pnl_points")
    realized_inr = payload.get("pnl_inr_one_lot")
    if status == "open_position":
        realized_points = payload.get("mtm_points")
        realized_inr = payload.get("mtm_inr_one_lot")
    if status not in {"closed", "open_position"}:
        realized_points = 0.0
        realized_inr = 0.0
    return {
        "journal_path": str(path.resolve()),
        "session": payload.get("session"),
        "symbol": payload.get("symbol"),
        "instrument_mode": payload.get("instrument_mode"),
        "status": status,
        "threshold_pct": payload.get("threshold_pct"),
        "gap_align": payload.get("gap_align"),
        "signal_ret_pct": payload.get("signal_ret_pct"),
        "direction": payload.get("direction"),
        "lot_size": payload.get("lot_size"),
        "option_contract": payload.get("option_contract"),
        "option_expiry_date": payload.get("option_expiry_date"),
        "option_type": payload.get("option_type"),
        "option_strike_price": payload.get("option_strike_price"),
        "underlying_entry_price": payload.get("underlying_entry_price"),
        "entry_timestamp": payload.get("entry_timestamp"),
        "entry_price": payload.get("entry_price"),
        "exit_timestamp": payload.get("exit_timestamp"),
        "exit_price": payload.get("exit_price"),
        "mark_timestamp": payload.get("mark_timestamp"),
        "mark_price": payload.get("mark_price"),
        "pnl_points": payload.get("pnl_points"),
        "pnl_inr_one_lot": payload.get("pnl_inr_one_lot"),
        "mtm_points": payload.get("mtm_points"),
        "mtm_inr_one_lot": payload.get("mtm_inr_one_lot"),
        "realized_points": realized_points,
        "realized_inr_one_lot": realized_inr,
    }


def collect_rows(journal_dir: Path, session: str | None, symbol: str | None, status: str | None) -> list[dict]:
    rows: list[dict] = []
    for path in sorted(journal_dir.glob("*.json")):
        if not JOURNAL_PATTERN.match(path.name):
            continue
        payload = read_journal(path)
        if not payload:
            continue
        if session and str(payload.get("session")) != session:
            continue
        if symbol and str(payload.get("symbol")) != symbol:
            continue
        if status and str(payload.get("status")) != status:
            continue
        rows.append(normalize_row(path, payload))
    return rows


def summarize_rows(frame: pd.DataFrame) -> dict:
    if frame.empty:
        return {
            "row_count": 0,
            "trade_count": 0,
            "closed_count": 0,
            "open_count": 0,
            "no_signal_count": 0,
            "gross_points": 0.0,
            "gross_inr_one_lot": 0.0,
            "profit_factor": None,
            "max_drawdown_inr": 0.0,
        }

    trade_frame = frame[frame["status"].isin(["closed", "open_position"])].copy()
    wins = trade_frame[trade_frame["realized_inr_one_lot"] > 0]
    losses = trade_frame[trade_frame["realized_inr_one_lot"] < 0]
    gross_profit = float(wins["realized_inr_one_lot"].sum()) if not wins.empty else 0.0
    gross_loss = float(-losses["realized_inr_one_lot"].sum()) if not losses.empty else 0.0
    equity = trade_frame["realized_inr_one_lot"].cumsum() if not trade_frame.empty else pd.Series(dtype=float)
    drawdown = equity - equity.cummax() if not equity.empty else pd.Series(dtype=float)
    profit_factor = None if gross_loss == 0 else round(gross_profit / gross_loss, 4)
    return {
        "row_count": int(len(frame)),
        "trade_count": int(len(trade_frame)),
        "closed_count": int((frame["status"] == "closed").sum()),
        "open_count": int((frame["status"] == "open_position").sum()),
        "no_signal_count": int((frame["status"] == "no_signal").sum()),
        "gross_points": round(float(trade_frame["realized_points"].sum()), 2),
        "gross_inr_one_lot": round(float(trade_frame["realized_inr_one_lot"].sum()), 2),
        "win_rate_pct": round(float((trade_frame["realized_inr_one_lot"] > 0).mean() * 100.0), 2) if not trade_frame.empty else None,
        "profit_factor": profit_factor,
        "max_drawdown_inr": round(float(drawdown.min()), 2) if not drawdown.empty else 0.0,
        "max_drawdown_abs_inr": round(float(-drawdown.min()), 2) if not drawdown.empty else 0.0,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Aggregate Groww paper-trade journal JSON files into CSV and JSON summaries."
    )
    parser.add_argument("--journal-dir", default=str(DEFAULT_JOURNAL_DIR), help="Directory containing per-session journal JSON files.")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Directory for the ledger outputs.")
    parser.add_argument("--session", default=None, help="Optional session filter YYYY-MM-DD.")
    parser.add_argument("--symbol", default=None, choices=["NIFTY", "BANKNIFTY"], help="Optional symbol filter.")
    parser.add_argument("--status", default=None, choices=["closed", "open_position", "no_signal", "failed"], help="Optional status filter.")
    parser.add_argument("--json", action="store_true", help="Emit the summary payload as JSON.")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    journal_dir = Path(args.journal_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    rows = collect_rows(journal_dir, args.session, args.symbol, args.status)
    frame = pd.DataFrame(rows)
    if not frame.empty:
        frame = frame.sort_values(["session", "symbol", "journal_path"]).reset_index(drop=True)

    detail_csv_path = output_dir / "paper_trade_ledger_rows.csv"
    session_csv_path = output_dir / "paper_trade_session_summary.csv"
    summary_json_path = output_dir / "paper_trade_ledger_summary.json"

    frame.to_csv(detail_csv_path, index=False)

    session_summary_rows = []
    if not frame.empty:
        for session_key, session_frame in frame.groupby("session", dropna=False):
            session_summary_rows.append(
                {
                    "session": session_key,
                    **summarize_rows(session_frame),
                }
            )
    session_summary_frame = pd.DataFrame(session_summary_rows)
    session_summary_frame.to_csv(session_csv_path, index=False)

    overall = summarize_rows(frame)
    by_symbol = {}
    if not frame.empty:
        for symbol_key, symbol_frame in frame.groupby("symbol", dropna=False):
            by_symbol[str(symbol_key)] = summarize_rows(symbol_frame)
    by_session = {str(row["session"]): row for row in session_summary_rows}

    payload = {
        "generated_at": pd.Timestamp.now(tz="Asia/Kolkata").isoformat(),
        "journal_dir": str(journal_dir.resolve()),
        "output_dir": str(output_dir.resolve()),
        "detail_csv": str(detail_csv_path.resolve()),
        "session_csv": str(session_csv_path.resolve()),
        "overall": overall,
        "by_session": by_session,
        "by_symbol": by_symbol,
        "rows": rows,
    }
    summary_json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"Ledger detail CSV: {detail_csv_path}")
        print(f"Session summary CSV: {session_csv_path}")
        print(f"Summary JSON: {summary_json_path}")
        print(json.dumps(overall, indent=2))


if __name__ == "__main__":
    main()
