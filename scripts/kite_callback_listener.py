#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo


REPO_ROOT = Path(__file__).resolve().parents[1]
IST = ZoneInfo("Asia/Kolkata")


@dataclass(frozen=True)
class ListenerConfig:
    host: str
    port: int
    callback_path: str
    postback_path: str
    output_dir: Path


def now_ist() -> str:
    return datetime.now(tz=IST).isoformat()


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=True) + "\n")


def parse_raw_body(body: bytes, content_type: str | None) -> dict[str, Any]:
    text = body.decode("utf-8", errors="replace").strip()
    if not text:
        return {}
    if content_type and "json" in content_type.lower():
        try:
            payload = json.loads(text)
            return payload if isinstance(payload, dict) else {"payload": payload}
        except json.JSONDecodeError:
            return {"raw_body": text}
    if "=" in text:
        parsed = parse_qs(text, keep_blank_values=True)
        return {key: values[-1] for key, values in parsed.items()}
    try:
        payload = json.loads(text)
        return payload if isinstance(payload, dict) else {"payload": payload}
    except json.JSONDecodeError:
        return {"raw_body": text}


def build_handler(config: ListenerConfig):
    class Handler(BaseHTTPRequestHandler):
        server_version = "KiteCallbackListener/0.1"

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, indent=2).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_html(self, status: int, html: str) -> None:
            body = html.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args) -> None:
            return

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "service": "kite-callback-listener",
                        "time": now_ist(),
                        "callback_path": config.callback_path,
                        "postback_path": config.postback_path,
                    },
                )
                return

            if parsed.path != config.callback_path:
                self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})
                return

            query = {key: values[-1] for key, values in parse_qs(parsed.query, keep_blank_values=True).items()}
            event = {
                "kind": "redirect_callback",
                "time": now_ist(),
                "path": parsed.path,
                "query": query,
                "request_token": query.get("request_token"),
                "status": query.get("status"),
                "action": query.get("action"),
            }
            append_jsonl(config.output_dir / "kite_redirect_events.jsonl", event)

            request_token = query.get("request_token", "")
            status_text = query.get("status", "received")
            html = f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Kite Callback Received</title>
    <style>
      body {{ font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 40px; }}
      code {{ background: #f5f5f5; padding: 2px 6px; border-radius: 6px; }}
    </style>
  </head>
  <body>
    <h1>Kite callback received</h1>
    <p>Status: <code>{status_text}</code></p>
    <p>Request token: <code>{request_token or "missing"}</code></p>
    <p>You can close this window and continue in Codex.</p>
  </body>
</html>"""
            self._send_html(HTTPStatus.OK, html)

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path != config.postback_path:
                self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})
                return

            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length > 0 else b""
            payload = parse_raw_body(body, self.headers.get("Content-Type"))
            event = {
                "kind": "postback",
                "time": now_ist(),
                "path": parsed.path,
                "headers": {key.lower(): value for key, value in self.headers.items()},
                "payload": payload,
            }
            append_jsonl(config.output_dir / "kite_postbacks.jsonl", event)
            self._send_json(HTTPStatus.OK, {"ok": True, "received": True})

    return Handler


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a local Kite Connect redirect/postback listener.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8789)
    parser.add_argument("--callback-path", default="/kite/callback")
    parser.add_argument("--postback-path", default="/kite/postback")
    parser.add_argument("--output-dir", default=str(REPO_ROOT / "market" / "kite"))
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    config = ListenerConfig(
        host=args.host,
        port=args.port,
        callback_path=args.callback_path,
        postback_path=args.postback_path,
        output_dir=Path(args.output_dir),
    )
    handler = build_handler(config)
    server = ThreadingHTTPServer((config.host, config.port), handler)
    print("Kite callback listener started")
    print(f"  health: http://{config.host}:{config.port}/health")
    print(f"  redirect callback: http://{config.host}:{config.port}{config.callback_path}")
    print(f"  postback: http://{config.host}:{config.port}{config.postback_path}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
