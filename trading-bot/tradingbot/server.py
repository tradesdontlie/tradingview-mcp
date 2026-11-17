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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, "dashboard", "mobile.html")          # phone-first home screen
HTML_DESKTOP = os.path.join(ROOT, "dashboard", "index.html")   # the original full console


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
        "accounts": [{"name": "this", "equity": eq, "kill": ks.mode.value, "ok": True}],
    }


MANIFEST = json.dumps({"name": "Tree Bot", "short_name": "TreeBot", "start_url": "/", "display": "standalone",
                       "background_color": "#10181d", "theme_color": "#10181d", "icons": [{
                           "src": "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231b2b34'/%3E%3Cpath d='M32 50V30M32 30L18 16M32 30l14-14' stroke='%234cc39a' stroke-width='5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E",
                           "sizes": "any", "type": "image/svg+xml"}]})


def make_handler(cfg, token, lan=False):
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

        def _authed(self):
            q = self.path.split("t=")[-1] if "t=" in self.path else ""
            return self.headers.get("X-Token") == token or q == token

        def do_GET(self):
            if self.path in ("/", "/desktop"):
                with open(HTML if self.path == "/" else HTML_DESKTOP, "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            if self.path == "/manifest.json":
                return self._send(200, MANIFEST, "application/manifest+json")
            if lan and self.path.startswith("/api") and not self._authed():
                return self._send(403, json.dumps({"error": "token required"}))
            if self.path.startswith("/api/journal"):
                from .journal import Journal
                return self._send(200, json.dumps(Journal(Database(cfg.db_path), cfg).analyze(), default=str))
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


def serve(cfg, token, port=8765, host="127.0.0.1"):
    """host 127.0.0.1 = this machine only. Any other host turns on token checks for ALL api calls."""
    srv = ThreadingHTTPServer((host, port), make_handler(cfg, token, lan=host != "127.0.0.1"))
    srv.serve_forever()
