#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = REPO_ROOT / "market" / "manifest.json"
DEFAULT_OUTPUT = REPO_ROOT / "market" / "reports" / "kite_market_audit.json"


def load_manifest(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def entry_end(entry: dict) -> str | None:
    return entry.get("end")


def entry_start(entry: dict) -> str | None:
    return entry.get("start")


def build_audit(manifest: dict) -> dict:
    update_needed = []
    enrichable = []
    help_items = []

    for symbol in ("nifty", "banknifty"):
        groww_daily = manifest.get(f"groww_{symbol}_daily")
        kite_daily = manifest.get(f"kite_{symbol}_daily")
        groww_1h = manifest.get(f"groww_{symbol}_1hour")
        kite_1h = manifest.get(f"kite_{symbol}_1hour")
        groww_15m = manifest.get(f"groww_{symbol}_15minute")
        kite_15m = manifest.get(f"kite_{symbol}_15minute")

        if not kite_daily:
            update_needed.append(
                {
                    "dataset": f"kite_{symbol}_daily",
                    "reason": "No Zerodha daily cache exists yet. Current backtests still depend on groww+yfinance for daily history.",
                }
            )
        elif groww_daily and entry_start(kite_daily) and entry_start(groww_daily) and str(entry_start(kite_daily)) > str(entry_start(groww_daily)):
            update_needed.append(
                {
                    "dataset": f"kite_{symbol}_daily",
                    "reason": f"Kite daily cache starts at {entry_start(kite_daily)}, while the stitched Groww/Yahoo daily store starts at {entry_start(groww_daily)}. Pre-2020 backfill is still missing on the pure Kite side.",
                }
            )

        if not kite_1h:
            update_needed.append(
                {
                    "dataset": f"kite_{symbol}_1hour",
                    "reason": "No Zerodha 1hour cache exists yet. Intraday research still depends on Groww 1hour data.",
                }
            )
        if not kite_15m:
            update_needed.append(
                {
                    "dataset": f"kite_{symbol}_15minute",
                    "reason": "No Zerodha 15minute cache exists yet. Live paper-trade runner still depends on Groww 15minute bars.",
                }
            )

    if not manifest.get("kite_index_reference"):
        enrichable.append(
            {
                "dataset": "kite_index_reference",
                "benefit": "Add instrument_token, exchange_token, tradingsymbol, segment, tick_size, and lot_size so research and execution stop depending on broker-specific symbol strings only.",
            }
        )
    if not manifest.get("kite_instruments_latest"):
        enrichable.append(
            {
                "dataset": "kite_instruments_latest",
                "benefit": "Daily instrument master lets us resolve real option tradingsymbols, expiries, strikes, and lot sizes locally without repeated API discovery calls.",
            }
        )
    if not manifest.get("kite_index_quote_snapshot"):
        enrichable.append(
            {
                "dataset": "kite_index_quote_snapshot",
                "benefit": "Quote snapshots can enrich live-paper MTM, day open/high/low/close validation, and help reconcile candle-based backtests against live quote behavior.",
            }
        )
    enrichable.append(
        {
            "dataset": "options_and_futures_metadata",
            "benefit": "Kite instrument dump can enrich the current option paper trader with instrument tokens, exchange tradingsymbols, strike ladders, expiries, and lot sizes instead of relying on Groww-only discovery.",
        }
    )
    enrichable.append(
        {
            "dataset": "charges_and_margin_checks",
            "benefit": "Kite margin and charges APIs can price realistic brokerage, taxes, and margin impact for option/futures trades before we trust backtest P&L.",
        }
    )

    help_items.append(
        {
            "item": "auth_requirement",
            "detail": "Kite historical, quote, and websocket APIs require a daily access_token minted from request_token via /session/token. That token expires at 6 AM next day.",
        }
    )
    help_items.append(
        {
            "item": "plan_requirement",
            "detail": "If this app was created on the free Personal tier, historical chart data and live quotes/websockets will not be available. The paid Connect tier is required for the data path we want.",
        }
    )
    help_items.append(
        {
            "item": "cache_strategy",
            "detail": "Best practice is: store daily instrument dump once each morning, cache historical candle chunks locally, and keep live quote snapshots separate from the offline backtest lake.",
        }
    )

    return {
        "update_needed": update_needed,
        "enrichable": enrichable,
        "other_help": help_items,
        "summary": {
            "update_count": len(update_needed),
            "enrich_count": len(enrichable),
            "help_count": len(help_items),
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Audit the repo market store for the planned Zerodha/Kite migration.")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--json", action="store_true")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    manifest = load_manifest(Path(args.manifest))
    payload = {
        "manifest_path": str(Path(args.manifest).resolve()) if Path(args.manifest).exists() else str(Path(args.manifest)),
        **build_audit(manifest),
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
