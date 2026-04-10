#!/usr/bin/env python3

from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import pandas as pd


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = REPO_ROOT / "scripts"
DEFAULT_PAPER_TRADE_SCRIPT = SCRIPT_DIR / "groww_index_paper_trade.py"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "market" / "reports" / "daily_runs"
DEFAULT_SYMBOLS = ("NIFTY", "BANKNIFTY")


@dataclass(frozen=True)
class RunSpec:
    session: str
    symbol: str
    refresh: bool
    paper_trade_script: str
    env_files: tuple[str, ...]


def normalize_session(session: str | None) -> pd.Timestamp:
    if session:
        return pd.Timestamp(session).normalize()
    return pd.Timestamp.now(tz="Asia/Kolkata").tz_localize(None).normalize()


def parse_json_stdout(stdout: str) -> dict:
    payload = stdout.strip()
    if not payload:
        raise RuntimeError("Child process returned empty output.")
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        start = payload.find("{")
        end = payload.rfind("}")
        if start >= 0 and end > start:
            return json.loads(payload[start : end + 1])
        raise


def build_child_command(spec: RunSpec) -> list[str]:
    cmd = [
        sys.executable,
        spec.paper_trade_script,
        "--symbol",
        spec.symbol,
        "--session",
        spec.session,
        "--json",
    ]
    if spec.refresh:
        cmd.append("--refresh")
    for env_file in spec.env_files:
        cmd.extend(["--env-file", env_file])
    return cmd


def execute_symbol(spec: RunSpec) -> dict:
    command = build_child_command(spec)
    completed = subprocess.run(command, capture_output=True, text=True)
    result: dict[str, object] = {
        "symbol": spec.symbol,
        "session": spec.session,
        "command": command,
        "returncode": completed.returncode,
    }
    if completed.stdout:
        result["stdout"] = completed.stdout.strip()
    if completed.stderr:
        result["stderr"] = completed.stderr.strip()
    if completed.returncode != 0:
        result["status"] = "failed"
        return result
    try:
        parsed = parse_json_stdout(completed.stdout)
    except Exception as exc:
        result["status"] = "failed"
        result["parse_error"] = str(exc)
        return result
    result["status"] = "ok"
    result["payload"] = parsed
    result["journal_path"] = parsed.get("journal_path")
    result["report"] = parsed.get("report", {})
    result["spec"] = parsed.get("spec", {})
    return result


def flatten_report(run_result: dict) -> dict:
    report = dict(run_result.get("report") or {})
    row = {
        "session": report.get("session", run_result.get("session")),
        "symbol": report.get("symbol", run_result.get("symbol")),
        "instrument_mode": report.get("instrument_mode"),
        "status": report.get("status", run_result.get("status")),
        "journal_path": run_result.get("journal_path"),
        "threshold_pct": report.get("threshold_pct"),
        "gap_align": report.get("gap_align"),
        "signal_ret_pct": report.get("signal_ret_pct"),
        "direction": report.get("direction"),
        "lot_size": report.get("lot_size"),
        "day_open": report.get("day_open"),
        "signal_close_1315": report.get("signal_close_1315", report.get("signal_close_price")),
        "option_contract": report.get("option_contract"),
        "option_expiry_date": report.get("option_expiry_date"),
        "option_type": report.get("option_type"),
        "option_strike_price": report.get("option_strike_price"),
        "underlying_entry_price": report.get("underlying_entry_price"),
        "entry_timestamp": report.get("entry_timestamp"),
        "entry_price": report.get("entry_price"),
        "exit_timestamp": report.get("exit_timestamp"),
        "exit_price": report.get("exit_price"),
        "mark_timestamp": report.get("mark_timestamp"),
        "mark_price": report.get("mark_price"),
        "pnl_points": report.get("pnl_points"),
        "pnl_inr_one_lot": report.get("pnl_inr_one_lot"),
        "charges_inr_one_lot": report.get("charges_inr_one_lot"),
        "net_inr_one_lot": report.get("net_inr_one_lot"),
        "mtm_points": report.get("mtm_points"),
        "mtm_inr_one_lot": report.get("mtm_inr_one_lot"),
        "companion_spread_strategy": (report.get("companion_spread") or {}).get("strategy"),
        "companion_spread_width_points": (report.get("companion_spread") or {}).get("spread_width_points"),
        "companion_spread_long_leg": (report.get("companion_spread") or {}).get("long_leg"),
        "companion_spread_short_leg": (report.get("companion_spread") or {}).get("short_leg"),
        "companion_spread_pnl_inr_one_lot": (report.get("companion_spread") or {}).get("pnl_inr_one_lot"),
        "companion_spread_net_inr_one_lot": (report.get("companion_spread") or {}).get("net_inr_one_lot"),
    }
    if row["status"] == "closed":
        row["trade_points"] = row["pnl_points"]
        row["trade_inr_one_lot"] = row["pnl_inr_one_lot"]
    elif row["status"] == "open_position":
        row["trade_points"] = row["mtm_points"]
        row["trade_inr_one_lot"] = row["mtm_inr_one_lot"]
    else:
        row["trade_points"] = 0.0
        row["trade_inr_one_lot"] = 0.0
    return row


def write_outputs(output_dir: Path, session: str, results: list[dict]) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    rows = [flatten_report(result) for result in results]
    frame = pd.DataFrame(rows)
    if not frame.empty:
        frame = frame.sort_values(["session", "symbol"]).reset_index(drop=True)

    summary_rows = []
    if not frame.empty:
        for session_key, session_frame in frame.groupby("session", dropna=False):
            trade_frame = session_frame[session_frame["status"].isin(["closed", "open_position"])].copy()
            wins = trade_frame[trade_frame["trade_inr_one_lot"] > 0]
            losses = trade_frame[trade_frame["trade_inr_one_lot"] < 0]
            gross_profit = float(wins["trade_inr_one_lot"].sum()) if not wins.empty else 0.0
            gross_loss = float(-losses["trade_inr_one_lot"].sum()) if not losses.empty else 0.0
            profit_factor = None if gross_loss == 0 else round(gross_profit / gross_loss, 4)
            summary_rows.append(
                {
                    "session": session_key,
                    "row_count": int(len(session_frame)),
                    "trade_count": int(len(trade_frame)),
                    "closed_count": int((session_frame["status"] == "closed").sum()),
                    "open_count": int((session_frame["status"] == "open_position").sum()),
                    "no_signal_count": int((session_frame["status"] == "no_signal").sum()),
                    "symbols": ",".join(session_frame["symbol"].dropna().astype(str).tolist()),
                    "gross_points": round(float(trade_frame["trade_points"].sum()), 2),
                    "gross_inr_one_lot": round(float(trade_frame["trade_inr_one_lot"].sum()), 2),
                    "win_rate_pct": round(float((trade_frame["trade_inr_one_lot"] > 0).mean() * 100.0), 2)
                    if not trade_frame.empty
                    else None,
                    "profit_factor": profit_factor,
                }
            )

    csv_path = output_dir / f"{session}_daily_run.csv"
    json_path = output_dir / f"{session}_daily_run.json"
    summary_csv_path = output_dir / f"{session}_daily_run_summary.csv"

    frame.to_csv(csv_path, index=False)
    pd.DataFrame(summary_rows).to_csv(summary_csv_path, index=False)

    overall = {
        "session": session,
        "generated_at": pd.Timestamp.now(tz="Asia/Kolkata").isoformat(),
        "row_count": int(len(frame)),
        "trade_count": int((frame["status"].isin(["closed", "open_position"])).sum()) if not frame.empty else 0,
        "gross_points": round(float(frame["trade_points"].sum()), 2) if not frame.empty else 0.0,
        "gross_inr_one_lot": round(float(frame["trade_inr_one_lot"].sum()), 2) if not frame.empty else 0.0,
        "rows_csv": str(csv_path.resolve()),
        "summary_csv": str(summary_csv_path.resolve()),
        "symbols": [row["symbol"] for row in rows],
    }
    payload = {
        "overall": overall,
        "runs": results,
        "rows": rows,
        "session_summary": summary_rows,
    }
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    overall["json_path"] = str(json_path.resolve())
    return {"overall": overall, "json_path": str(json_path.resolve()), "rows_csv": str(csv_path.resolve()), "summary_csv": str(summary_csv_path.resolve())}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Execute the Groww-backed NIFTY/BANKNIFTY paper-trade flow for a target session and save a combined daily report."
    )
    parser.add_argument("--session", default=None, help="Session date YYYY-MM-DD. Defaults to today in Asia/Kolkata.")
    parser.add_argument("--symbols", nargs="+", default=list(DEFAULT_SYMBOLS), choices=sorted(DEFAULT_SYMBOLS), help="Symbols to run.")
    parser.add_argument("--refresh", action="store_true", help="Refresh the target session bars from Groww before computing the signal.")
    parser.add_argument("--paper-trade-script", default=str(DEFAULT_PAPER_TRADE_SCRIPT), help="Path to groww_index_paper_trade.py.")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Directory for combined run outputs.")
    parser.add_argument("--env-file", action="append", default=[], help="Extra env file(s) forwarded to the child paper-trade script.")
    parser.add_argument("--json", action="store_true", help="Emit the combined run payload as JSON.")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    session_day = normalize_session(args.session)
    session = session_day.strftime("%Y-%m-%d")
    env_files = tuple(str(Path(path)) for path in args.env_file)
    specs = [
        RunSpec(
            session=session,
            symbol=symbol,
            refresh=args.refresh,
            paper_trade_script=str(Path(args.paper_trade_script)),
            env_files=env_files,
        )
        for symbol in args.symbols
    ]

    results: list[dict] = []
    with futures.ThreadPoolExecutor(max_workers=max(1, len(specs))) as executor:
        future_map = {executor.submit(execute_symbol, spec): spec.symbol for spec in specs}
        for future in futures.as_completed(future_map):
            try:
                results.append(future.result())
            except Exception as exc:
                results.append(
                    {
                        "symbol": future_map[future],
                        "session": session,
                        "status": "failed",
                        "error": str(exc),
                    }
                )

    results = sorted(results, key=lambda item: str(item.get("symbol", "")))
    output = write_outputs(Path(args.output_dir), session, results)
    output["results"] = results
    output["specs"] = [asdict(spec) for spec in specs]
    if args.json:
        print(json.dumps(output, indent=2))
    else:
        print(f"Daily run saved to: {output['json_path']}")
        print(json.dumps(output["overall"], indent=2))


if __name__ == "__main__":
    main()
