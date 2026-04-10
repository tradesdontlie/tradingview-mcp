#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from dataclasses import dataclass, field
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs
from zoneinfo import ZoneInfo


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV_FILES = [
    REPO_ROOT / "config" / "runtime.env",
    REPO_ROOT / "config" / "local.env",
]
IST = ZoneInfo("Asia/Kolkata")

INDEX_LOT_SIZES = {
    "NIFTY": 65,
    "BANKNIFTY": 30,
}

SYMBOL_ALIASES = {
    "NIFTY 50": "NIFTY",
    "NIFTY50": "NIFTY",
    "NSE-NIFTY": "NIFTY",
    "NSE:NIFTY": "NIFTY",
    "NSE-NIFTY50": "NIFTY",
    "BANK NIFTY": "BANKNIFTY",
    "NIFTY BANK": "BANKNIFTY",
    "NSE-BANKNIFTY": "BANKNIFTY",
    "NSE:BANKNIFTY": "BANKNIFTY",
}

ENTRY_WORDS = {"BUY", "LONG", "ENTRY", "ENTER"}
EXIT_WORDS = {"SELL", "SHORT", "EXIT", "CLOSE", "FLAT", "FLATTEN"}


@dataclass(frozen=True)
class ListenerConfig:
    host: str
    port: int
    mode: str
    queue_file: Path
    journal_dir: Path
    secret: str | None
    secret_fields: tuple[str, ...]
    max_events: int
    default_lot_sizes: dict[str, int] = field(default_factory=lambda: dict(INDEX_LOT_SIZES))


def load_env_files(paths: list[Path]) -> None:
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


def now_ist() -> datetime:
    return datetime.now(tz=IST)


def isoformat(value: Any | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=IST)
        return dt.astimezone(IST).isoformat()
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=IST)
        return parsed.astimezone(IST).isoformat()
    except ValueError:
        return text


def normalize_key(text: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "_" for ch in text).strip("_")


def parse_raw_payload(raw_body: bytes, content_type: str | None) -> dict[str, Any]:
    text = raw_body.decode("utf-8", errors="replace").strip()
    if not text:
        return {}

    if content_type and "json" in content_type.lower():
        try:
            payload = json.loads(text)
            if isinstance(payload, dict):
                return payload
            return {"payload": payload}
        except json.JSONDecodeError:
            pass

    if text.startswith("{") or text.startswith("["):
        try:
            payload = json.loads(text)
            if isinstance(payload, dict):
                return payload
            return {"payload": payload}
        except json.JSONDecodeError:
            pass

    form = parse_qs(text, keep_blank_values=True)
    if form and "=" in text:
        return {key: values[-1] for key, values in form.items()}

    parsed: dict[str, Any] = {}
    message_lines: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if ":" in line:
            key, value = line.split(":", 1)
            parsed[normalize_key(key)] = value.strip()
            continue
        if "=" in line:
            key, value = line.split("=", 1)
            parsed[normalize_key(key)] = value.strip()
            continue
        if "|" in line and "strategy" not in parsed and "symbol" not in parsed:
            left, right = line.split("|", 1)
            parsed["strategy"] = left.strip()
            parsed["symbol"] = right.strip()
            continue
        message_lines.append(line)

    if message_lines:
        parsed["message"] = "\n".join(message_lines)
    return parsed


def normalize_symbol(payload: dict[str, Any]) -> str:
    candidates = [
        payload.get("symbol"),
        payload.get("ticker"),
        payload.get("exchange_symbol"),
        payload.get("trading_symbol"),
        payload.get("instrument"),
        payload.get("name"),
        payload.get("message"),
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        text = str(candidate).strip().upper()
        if not text:
            continue
        text = text.replace("/", " ").replace("-", " ").replace(":", " ")
        text = " ".join(text.split())
        for alias, target in SYMBOL_ALIASES.items():
            if text == alias or text.endswith(f" {alias}") or text.startswith(f"{alias} "):
                return target
        if "BANK" in text and "NIFTY" in text:
            return "BANKNIFTY"
        if text == "NIFTY" or text.endswith(" NIFTY") or text.endswith(" NIFTY50") or "NIFTY50" in text:
            return "NIFTY"
        if text == "BANKNIFTY" or "BANKNIFTY" in text:
            return "BANKNIFTY"
    return ""


def infer_direction(payload: dict[str, Any]) -> str | None:
    candidates = [
        payload.get("direction"),
        payload.get("side"),
        payload.get("signal"),
        payload.get("action"),
        payload.get("order_action"),
        payload.get("message"),
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        text = str(candidate).upper()
        if any(word in text for word in ("LONG", "BUY", "ENTER")):
            return "LONG"
        if any(word in text for word in ("SHORT", "SELL", "EXIT", "CLOSE", "FLAT")):
            return "SHORT"
    return None


def infer_event_type(payload: dict[str, Any]) -> str:
    candidates = [
        payload.get("event_type"),
        payload.get("event"),
        payload.get("status"),
        payload.get("action"),
        payload.get("signal"),
        payload.get("message"),
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        text = str(candidate).upper()
        if any(word in text for word in EXIT_WORDS):
            return "exit"
        if any(word in text for word in ENTRY_WORDS):
            return "entry"
    return "signal"


def pick_price(payload: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    for key in keys:
        value = payload.get(key)
        if value in (None, ""):
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def parse_timestamp(payload: dict[str, Any]) -> datetime:
    for key in ("timestamp", "time", "datetime", "bar_time", "alert_time", "received_at"):
        value = payload.get(key)
        if value in (None, ""):
            continue
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=IST)
            return parsed.astimezone(IST)
        except ValueError:
            continue
    return now_ist()


def build_trade_key(payload: dict[str, Any], session: str, symbol: str) -> str:
    for key in ("trade_id", "signal_id", "order_id", "alert_id", "id"):
        value = payload.get(key)
        if value not in (None, ""):
            return str(value)
    strategy = payload.get("strategy") or payload.get("study") or payload.get("name") or "webhook"
    return f"{session}_{symbol}_{normalize_key(str(strategy))}"


def safe_json_load(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def write_atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, indent=2, sort_keys=False), encoding="utf-8")
    tmp_path.replace(path)


class PaperTradeStore:
    def __init__(self, config: ListenerConfig) -> None:
        self.config = config
        self.lock = threading.Lock()
        self.queue_file = config.queue_file
        self.journal_dir = config.journal_dir
        self.journal_dir.mkdir(parents=True, exist_ok=True)
        self.queue_file.parent.mkdir(parents=True, exist_ok=True)

    def append_queue(self, record: dict[str, Any]) -> None:
        line = json.dumps(record, separators=(",", ":"), ensure_ascii=True)
        with self.lock:
            self.queue_file.parent.mkdir(parents=True, exist_ok=True)
            with self.queue_file.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
                handle.flush()
                os.fsync(handle.fileno())

    def journal_path(self, session: str, symbol: str, trade_key: str) -> Path:
        safe_trade_key = normalize_key(trade_key)[:64] or "default"
        return self.journal_dir / f"{session}_{symbol}_{safe_trade_key}.json"

    def update_journal(self, normalized: dict[str, Any], event_record: dict[str, Any]) -> Path:
        session = normalized["session"]
        symbol = normalized["symbol"]
        trade_key = normalized["trade_key"]
        journal_path = self.journal_path(session, symbol, trade_key)
        with self.lock:
            current = safe_json_load(journal_path)
            journal = self._merge_journal(current, normalized, event_record)
            write_atomic_json(journal_path, journal)
        return journal_path

    def _merge_journal(
        self,
        current: dict[str, Any],
        normalized: dict[str, Any],
        event_record: dict[str, Any],
    ) -> dict[str, Any]:
        now = event_record["received_at"]
        event_type = normalized["event_type"]
        direction = normalized.get("direction")
        symbol = normalized["symbol"]
        session = normalized["session"]
        strategy = normalized.get("strategy") or "webhook"
        lot_size = self.config.default_lot_sizes.get(symbol)
        entry_price = normalized.get("entry_price")
        exit_price = normalized.get("exit_price")
        price = normalized.get("price")

        journal = dict(current)
        journal.setdefault("source", "tradingview_webhook")
        journal.setdefault("paper_only", True)
        journal.setdefault("symbol", symbol)
        journal.setdefault("session", session)
        journal.setdefault("trade_key", normalized["trade_key"])
        journal.setdefault("lot_size", lot_size)
        journal.setdefault("events", [])

        if not journal.get("entry_timestamp") and normalized.get("entry_timestamp"):
            journal["entry_timestamp"] = normalized["entry_timestamp"]
        if not journal.get("entry_price") and entry_price is not None:
            journal["entry_price"] = round(entry_price, 2)

        if event_type == "entry":
            journal["status"] = "open_position"
            journal["direction"] = direction or journal.get("direction") or "LONG"
            if price is not None:
                journal["mark_price"] = round(price, 2)
            if normalized.get("entry_timestamp"):
                journal["entry_timestamp"] = normalized["entry_timestamp"]
            if entry_price is not None:
                journal["entry_price"] = round(entry_price, 2)
        elif event_type == "exit":
            journal["status"] = "closed"
            journal["direction"] = direction or journal.get("direction") or "LONG"
            if normalized.get("exit_timestamp"):
                journal["exit_timestamp"] = normalized["exit_timestamp"]
            if exit_price is None and price is not None:
                exit_price = price
            if exit_price is not None:
                journal["exit_price"] = round(exit_price, 2)
            if journal.get("entry_price") is not None and journal.get("exit_price") is not None:
                direction_value = 1 if journal["direction"] == "LONG" else -1
                pnl_points = (float(journal["exit_price"]) - float(journal["entry_price"])) * direction_value
                journal["pnl_points"] = round(pnl_points, 2)
                if lot_size:
                    journal["pnl_inr_one_lot"] = round(pnl_points * float(lot_size), 2)
        else:
            journal["status"] = journal.get("status") or "signal_received"
            if direction:
                journal["direction"] = direction
            if price is not None:
                journal["mark_price"] = round(price, 2)

        journal["strategy"] = strategy
        journal["last_event_type"] = event_type
        journal["last_received_at"] = now
        journal["updated_at"] = now
        journal["events"] = self._append_event(journal.get("events", []), event_record)
        return journal

    def _append_event(self, events: list[Any], event_record: dict[str, Any]) -> list[Any]:
        if not isinstance(events, list):
            events = []
        events.append(
            {
                "received_at": event_record["received_at"],
                "event_type": event_record["normalized"]["event_type"],
                "symbol": event_record["normalized"]["symbol"],
                "direction": event_record["normalized"].get("direction"),
                "strategy": event_record["normalized"].get("strategy"),
                "trade_key": event_record["normalized"]["trade_key"],
                "summary": event_record["normalized"].get("summary"),
            }
        )
        return events[-self.config.max_events :]


def summarize_payload(payload: dict[str, Any]) -> str:
    parts = []
    for key in ("symbol", "ticker", "strategy", "event_type", "signal", "action", "direction"):
        value = payload.get(key)
        if value not in (None, ""):
            parts.append(f"{key}={value}")
    return ", ".join(parts) if parts else "webhook received"


def normalize_payload(payload: dict[str, Any], *, config: ListenerConfig) -> dict[str, Any]:
    received_at = now_ist()
    timestamp = parse_timestamp(payload)
    symbol = normalize_symbol(payload)
    strategy = str(payload.get("strategy") or payload.get("study") or payload.get("name") or "webhook").strip()
    event_type = infer_event_type(payload)
    direction = infer_direction(payload)
    session = str(payload.get("session") or timestamp.date().isoformat())
    trade_key = build_trade_key(payload, session, symbol or "UNKNOWN")
    price = pick_price(payload, ("price", "close", "last_price", "mark_price", "signal_price"))
    entry_price = pick_price(payload, ("entry_price", "entry", "price", "close"))
    exit_price = pick_price(payload, ("exit_price", "exit", "price", "close"))
    entry_timestamp = isoformat(payload.get("entry_timestamp") or payload.get("entry_time") or payload.get("signal_time") or (timestamp if event_type == "entry" else None))
    exit_timestamp = isoformat(payload.get("exit_timestamp") or payload.get("exit_time") or (timestamp if event_type == "exit" else None))
    summary = summarize_payload(payload)

    return {
        "received_at": received_at.isoformat(),
        "timestamp": timestamp.isoformat(),
        "session": session,
        "symbol": symbol or "UNKNOWN",
        "strategy": strategy,
        "event_type": event_type,
        "direction": direction,
        "trade_key": trade_key,
        "price": price,
        "entry_price": entry_price,
        "exit_price": exit_price,
        "entry_timestamp": entry_timestamp,
        "exit_timestamp": exit_timestamp,
        "lot_size": config.default_lot_sizes.get(symbol or "", None),
        "summary": summary,
        "raw": payload,
    }


def validate_secret(payload: dict[str, Any], headers: dict[str, str], config: ListenerConfig) -> tuple[bool, str | None]:
    if not config.secret:
        return True, None
    for field in config.secret_fields:
        value = payload.get(field)
        if value not in (None, "") and str(value) == config.secret:
            return True, None
    header_secret = headers.get("x-webhook-token") or headers.get("authorization")
    if header_secret:
        token = header_secret.split(" ", 1)[-1].strip() if " " in header_secret else header_secret.strip()
        if token == config.secret:
            return True, None
    return False, "missing or invalid webhook secret"


class WebhookHandler(BaseHTTPRequestHandler):
    server_version = "TradingViewWebhook/1.0"

    def do_GET(self) -> None:  # noqa: N802
        if self.path not in {"/", "/health"}:
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        payload = {
            "ok": True,
            "paper_only": True,
            "queue_file": str(self.server.store.queue_file),  # type: ignore[attr-defined]
            "journal_dir": str(self.server.store.journal_dir),  # type: ignore[attr-defined]
            "pending_events": self._queue_line_count(),
        }
        self._send_json(HTTPStatus.OK, payload)

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in {"/", "/webhook", "/alert"}:
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "")
        parsed = parse_raw_payload(raw_body, content_type)
        headers = {key.lower(): value for key, value in self.headers.items()}
        config: ListenerConfig = self.server.config  # type: ignore[attr-defined]
        store: PaperTradeStore = self.server.store  # type: ignore[attr-defined]

        secret_ok, secret_error = validate_secret(parsed, headers, config)
        if not secret_ok:
            self._send_json(
                HTTPStatus.UNAUTHORIZED,
                {
                    "ok": False,
                    "error": secret_error,
                    "paper_only": True,
                },
            )
            return

        normalized = normalize_payload(parsed, config=config)
        event_record = {
            "received_at": now_ist().isoformat(),
            "client_ip": self.client_address[0] if self.client_address else None,
            "path": self.path,
            "content_type": content_type,
            "raw_text": raw_body.decode("utf-8", errors="replace"),
            "parsed": parsed,
            "normalized": normalized,
        }

        store.append_queue(event_record)
        journal_path = None
        if config.mode in {"journal", "both"} and normalized["symbol"] != "UNKNOWN":
            journal_path = store.update_journal(normalized, event_record)

        response = {
            "ok": True,
            "paper_only": True,
            "mode": config.mode,
            "queue_file": str(store.queue_file),
            "journal_path": str(journal_path) if journal_path else None,
            "normalized": {
                "session": normalized["session"],
                "symbol": normalized["symbol"],
                "strategy": normalized["strategy"],
                "event_type": normalized["event_type"],
                "direction": normalized["direction"],
                "trade_key": normalized["trade_key"],
                "entry_price": normalized["entry_price"],
                "exit_price": normalized["exit_price"],
                "timestamp": normalized["timestamp"],
            },
        }
        self._send_json(HTTPStatus.ACCEPTED, response)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write(
            "[webhook] "
            + fmt % args
            + "\n"
        )
        sys.stdout.flush()

    def _queue_line_count(self) -> int:
        store: PaperTradeStore = self.server.store  # type: ignore[attr-defined]
        if not store.queue_file.exists():
            return 0
        try:
            return sum(1 for _ in store.queue_file.open("r", encoding="utf-8"))
        except Exception:
            return 0

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class WebhookServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], handler_class: type[BaseHTTPRequestHandler], *, config: ListenerConfig, store: PaperTradeStore) -> None:
        super().__init__(address, handler_class)
        self.config = config
        self.store = store


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a local, paper-trade-only TradingView webhook listener.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host. Defaults to 127.0.0.1.")
    parser.add_argument("--port", type=int, default=8787, help="Bind port. Defaults to 8787.")
    parser.add_argument("--mode", choices=["queue", "journal", "both"], default="both", help="Queue only, journal only, or both.")
    parser.add_argument("--queue-file", default=str(REPO_ROOT / "market" / "paper_trades" / "webhook_queue.jsonl"), help="Append-only queue file.")
    parser.add_argument("--journal-dir", default=str(REPO_ROOT / "market" / "paper_trades" / "webhook_journals"), help="Directory for per-session journal snapshots.")
    parser.add_argument("--secret", default=None, help="Webhook secret. If set, payloads must include it in `secret`, `token`, or `webhook_secret`.")
    parser.add_argument("--secret-field", action="append", default=[], help="Extra payload field name to check for the webhook secret.")
    parser.add_argument("--max-events", type=int, default=25, help="Maximum events to keep per journal snapshot.")
    parser.add_argument("--env-file", action="append", default=[], help="Extra env file(s) to load before reading `TV_WEBHOOK_SECRET`.")
    return parser


def resolve_secret(args: argparse.Namespace) -> str | None:
    if args.secret:
        return args.secret
    return os.getenv("TV_WEBHOOK_SECRET") or os.getenv("WEBHOOK_SECRET")


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    env_files = DEFAULT_ENV_FILES + [Path(path) for path in args.env_file]
    load_env_files(env_files)

    config = ListenerConfig(
        host=args.host,
        port=args.port,
        mode=args.mode,
        queue_file=Path(args.queue_file),
        journal_dir=Path(args.journal_dir),
        secret=resolve_secret(args),
        secret_fields=tuple(["secret", "token", "webhook_secret", *args.secret_field]),
        max_events=max(1, int(args.max_events)),
    )
    store = PaperTradeStore(config)
    server = WebhookServer((config.host, config.port), WebhookHandler, config=config, store=store)

    print("TradingView webhook listener started")
    print(f"  mode: {config.mode}")
    print(f"  host: {config.host}")
    print(f"  port: {config.port}")
    print(f"  queue file: {config.queue_file}")
    print(f"  journal dir: {config.journal_dir}")
    print(f"  paper only: True")
    if config.secret:
        print("  webhook secret: enabled")
    else:
        print("  webhook secret: disabled")
    print("  endpoints: POST /webhook, POST /alert, GET /health")
    print("  stop with Ctrl+C")

    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\nShutting down webhook listener...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
