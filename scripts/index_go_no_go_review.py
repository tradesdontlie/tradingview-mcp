#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path


def evaluate_trial(payload: dict) -> dict:
    summary = payload.get("summary", {})
    sessions_required = int(payload.get("sessions_required", 20))
    reasons: list[str] = []

    session_count = int(summary.get("session_count") or 0)
    net_inr = float(summary.get("net_inr_one_lot") or 0.0)
    max_drawdown_inr = float(summary.get("max_drawdown_inr") or 0.0)
    win_rate = summary.get("win_rate")
    positive_day_ratio = summary.get("positive_day_ratio")
    max_consecutive_losses = int(summary.get("max_consecutive_losses") or 0)

    if session_count < sessions_required:
        reasons.append("forward_trial_incomplete")
    if net_inr <= 0.0:
        reasons.append("net_pnl_not_positive")
    if win_rate is None or float(win_rate) < 50.0:
        reasons.append("win_rate_below_50")
    if positive_day_ratio is None or float(positive_day_ratio) < 50.0:
        reasons.append("positive_day_ratio_below_50")
    if abs(max_drawdown_inr) > max(25000.0, abs(net_inr) * 0.75):
        reasons.append("drawdown_too_large_vs_pnl")
    if max_consecutive_losses >= 5:
        reasons.append("loss_streak_too_long")

    status = "go_small_size_paper_plus_monitoring" if not reasons else ("wait_for_more_data" if reasons == ["forward_trial_incomplete"] else "no_go_yet")
    return {
        "status": status,
        "reasons": reasons,
        "summary": summary,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Apply a simple go/no-go review to a forward-trial summary.")
    parser.add_argument("--trial-file", required=True)
    parser.add_argument("--json", action="store_true")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    path = Path(args.trial_file)
    payload = json.loads(path.read_text(encoding="utf-8"))
    review = evaluate_trial(payload)
    out_path = path.with_name(path.stem + "_review.json")
    out_path.write_text(json.dumps(review, indent=2), encoding="utf-8")

    if args.json:
        print(json.dumps({"review_path": str(out_path.resolve()), **review}, indent=2))
    else:
        print(f"Review file: {out_path}")
        print(json.dumps(review, indent=2))


if __name__ == "__main__":
    main()
