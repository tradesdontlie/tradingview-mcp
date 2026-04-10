#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TRIAL_DIR = REPO_ROOT / "market" / "forward_trials"
DEFAULT_JOURNAL_DIR = REPO_ROOT / "market" / "paper_trades"
DEFAULT_CONFIG_PATH = REPO_ROOT / "config" / "live_paper_strategy.json"

FALLBACK_CONFIG = {
    "NIFTY": {"family": "mid_cont", "default_threshold_pct": 0.4, "default_gap_align": False, "fallback_lot_size": 65},
    "BANKNIFTY": {"family": "mid_cont", "default_threshold_pct": 0.35, "default_gap_align": False, "fallback_lot_size": 30},
}


def load_config(path: Path) -> dict:
    if path.exists():
        payload = json.loads(path.read_text(encoding="utf-8"))
        if "symbols" in payload:
            shared = payload.get("shared", {})
            merged = {}
            for symbol, config in payload["symbols"].items():
                merged[str(symbol)] = {**shared, **config}
            return merged
        return payload
    return FALLBACK_CONFIG


def load_journal_rows(journal_dir: Path, symbols: list[str]) -> list[dict]:
    rows: list[dict] = []
    for path in sorted(journal_dir.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        report = payload.get("report", payload)
        symbol = report.get("symbol")
        if symbol not in symbols:
            continue
        rows.append({**report, "_path": str(path.resolve())})
    return rows


def summarize_rows(rows: list[dict], lot_sizes: dict[str, int], sessions_required: int) -> dict:
    if not rows:
        return {
            "session_count": 0,
            "trade_count": 0,
            "completed_pct": 0.0,
            "net_points": 0.0,
            "net_inr_one_lot": 0.0,
            "win_rate": None,
            "max_drawdown_inr": None,
            "max_consecutive_losses": 0,
            "positive_day_ratio": None,
        }

    frame = pd.DataFrame(rows).sort_values(["session", "symbol"]).reset_index(drop=True)
    closed = frame[frame["status"] == "closed"].copy()
    if closed.empty:
        return {
            "session_count": int(frame["session"].nunique()),
            "trade_count": 0,
            "completed_pct": round(float(frame["session"].nunique() / sessions_required * 100.0), 2),
            "net_points": 0.0,
            "net_inr_one_lot": 0.0,
            "win_rate": None,
            "max_drawdown_inr": None,
            "max_consecutive_losses": 0,
            "positive_day_ratio": None,
        }

    closed["pnl_points"] = pd.to_numeric(closed["pnl_points"], errors="coerce").fillna(0.0)
    closed["pnl_inr_one_lot"] = closed.apply(
        lambda row: float(row["pnl_points"]) * float(lot_sizes.get(str(row["symbol"]), row.get("lot_size") or 1)),
        axis=1,
    )
    equity = closed["pnl_inr_one_lot"].cumsum()
    drawdown = equity - equity.cummax()

    max_losses = 0
    current_losses = 0
    for value in closed["pnl_inr_one_lot"]:
        if value < 0:
            current_losses += 1
            max_losses = max(max_losses, current_losses)
        else:
            current_losses = 0

    by_day = closed.groupby("session")["pnl_inr_one_lot"].sum()
    return {
        "session_count": int(frame["session"].nunique()),
        "trade_count": int(len(closed)),
        "completed_pct": round(float(frame["session"].nunique() / sessions_required * 100.0), 2),
        "net_points": round(float(closed["pnl_points"].sum()), 2),
        "net_inr_one_lot": round(float(closed["pnl_inr_one_lot"].sum()), 2),
        "win_rate": round(float((closed["pnl_inr_one_lot"] > 0).mean() * 100.0), 2),
        "max_drawdown_inr": round(float(drawdown.min()), 2),
        "max_consecutive_losses": int(max_losses),
        "positive_day_ratio": round(float((by_day > 0).mean() * 100.0), 2),
    }


def build_trial_payload(
    *,
    trial_name: str,
    symbols: list[str],
    sessions_required: int,
    config_path: Path,
    journal_dir: Path,
) -> dict:
    config = load_config(config_path)
    rows = load_journal_rows(journal_dir, symbols)
    lot_sizes = {
        symbol: int(config.get(symbol, {}).get("lot_size", config.get(symbol, {}).get("fallback_lot_size", FALLBACK_CONFIG[symbol]["fallback_lot_size"])))
        for symbol in symbols
    }
    summary = summarize_rows(rows, lot_sizes, sessions_required)
    done = summary["session_count"] >= sessions_required
    return {
        "trial_name": trial_name,
        "symbols": symbols,
        "sessions_required": sessions_required,
        "config_path": str(config_path.resolve()) if config_path.exists() else str(config_path),
        "journal_dir": str(journal_dir.resolve()),
        "locked_parameters": {symbol: config.get(symbol, FALLBACK_CONFIG[symbol]) for symbol in symbols},
        "status": "complete" if done else "in_progress",
        "summary": summary,
        "journal_rows": rows,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Track a 20-session forward paper-trading trial from journal files.")
    parser.add_argument("--trial-name", default="index_midday_live_trial")
    parser.add_argument("--symbols", nargs="+", default=["NIFTY", "BANKNIFTY"])
    parser.add_argument("--sessions-required", type=int, default=20)
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    parser.add_argument("--journal-dir", default=str(DEFAULT_JOURNAL_DIR))
    parser.add_argument("--trial-dir", default=str(DEFAULT_TRIAL_DIR))
    parser.add_argument("--json", action="store_true")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    payload = build_trial_payload(
        trial_name=args.trial_name,
        symbols=args.symbols,
        sessions_required=args.sessions_required,
        config_path=Path(args.config),
        journal_dir=Path(args.journal_dir),
    )

    trial_dir = Path(args.trial_dir)
    trial_dir.mkdir(parents=True, exist_ok=True)
    path = trial_dir / f"{args.trial_name}.json"
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    if args.json:
        print(json.dumps({"trial_path": str(path.resolve()), **payload}, indent=2))
    else:
        print(f"Trial file: {path}")
        print(json.dumps(payload["summary"], indent=2))


if __name__ == "__main__":
    main()
