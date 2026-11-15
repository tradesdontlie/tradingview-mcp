"""Local web console (standard library only). Reads the database; writes only the kill switch.
Binds to 127.0.0.1. Control actions need the token printed at startup."""
import json
import os
import time
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .analytics import summarize
from .config import Config
from .database import Database
from .kill_switch import KillSwitch
from .models import Mode

HTML = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "dashboard", "index.html")


def build_state(db, cfg) -> dict:
    snaps = db.conn.execute("SELECT ts, equity FROM snapshots ORDER BY ts DESC LIMIT 400").fetchall()
    snaps = [[r[0], r[1]] for r in reversed(snaps)]
    ks = KillSwitch(db)
    peak = float(db.kv_get("peak_equity", 0) or 0)
    day0 = float(db.kv_get("day_start_equity", 0) or 0)
    eq = snaps[-1][1] if snaps else 0
    reasons = db.conn.execute("SELECT reason, COUNT(*) FROM risk_decisions WHERE approved=0 "
                              "GROUP BY reason ORDER BY 2 DESC").fetchall()
    audit = db.conn.execute("SELECT ts, actor, event_type, payload FROM audit "
                            "ORDER BY event_id DESC LIMIT 25").fetchall()
    nodes = db.nodes()[-400:]
    return {
        "run_mode": db.kv_get("run_mode", "idle"), "heartbeat": float(db.kv_get("heartbeat", 0) or 0),
        "now": time.time(), "kill": {"mode": ks.mode.value, "reason": ks.reason},
        "account": {"equity": eq, "day_pnl": eq - day0 if day0 else 0,
                    "drawdown_pct": (peak - eq) / peak * 100 if peak else 0},
        "stats": summarize(db), "equity": snaps, "nodes": nodes,
        "rejections": [[r[0], r[1]] for r in reasons], "audit": [list(r) for r in audit],
        "config": asdict(cfg),
    }


def make_handler(cfg, token):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/":
                with open(HTML, "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            if self.path.startswith("/api/state"):
                return self._send(200, json.dumps(build_state(Database(cfg.db_path), cfg), default=str))
            self._send(404, "{}")

        def do_POST(self):
            if self.path != "/api/kill":
                return self._send(404, "{}")
            if self.headers.get("X-Token") != token:
                return self._send(403, json.dumps({"error": "bad token"}))
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            ks, action = KillSwitch(Database(cfg.db_path)), body.get("action", "")
            if action in ("pause", "freeze", "liquidate"):
                ks.trigger(Mode[action.upper()], "dashboard", actor="operator")
            elif action == "reset":
                if not ks.reset("operator", body.get("confirm", "")):
                    return self._send(400, json.dumps({"error": "type RESET to confirm"}))
            else:
                return self._send(400, json.dumps({"error": "unknown action"}))
            self._send(200, json.dumps({"mode": ks.mode.value}))
    return H


def serve(cfg, token, port=8765):
    srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(cfg, token))
    srv.serve_forever()
