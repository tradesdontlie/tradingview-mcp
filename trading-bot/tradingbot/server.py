"""Local web console (standard library only). Reads the database; writes only the kill switch.
Binds to 127.0.0.1. Control actions need the token printed at startup."""
import json
import math
import os
import time
import urllib.request
import urllib.error
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .analytics import summarize
from .config import Config
from .database import Database
from .jsonutil import safe_json
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
    all_nodes = db.nodes()
    nodes = all_nodes[-400:]
    t_now = snaps[-1][0] if snaps else time.time()
    d0 = t_now - t_now % 86400
    done = [n for n in all_nodes if n["closed_ts"] and n["closed_ts"] >= d0 and n["state"] in ("WON", "LOST")]
    w = sum(1 for n in done if n["state"] == "WON")
    today = {"opened": sum(1 for n in all_nodes if n["opened_ts"] and n["opened_ts"] >= d0), "closed": len(done),
             "wins": w, "losses": len(done) - w, "win_pct": w / len(done) * 100 if done else 0.0,
             "loss_pct": (len(done) - w) / len(done) * 100 if done else 0.0,
             "net": sum(n["net_pnl"] or 0 for n in done)}
    return {
        "run_mode": db.kv_get("run_mode", "idle"), "heartbeat": float(db.kv_get("heartbeat", 0) or 0),
        "now": time.time(), "kill": {"mode": ks.mode.value, "reason": ks.reason},
        "account": {"equity": eq, "day_pnl": eq - day0 if day0 else 0,
                    "drawdown_pct": (peak - eq) / peak * 100 if peak else 0},
        "stats": summarize(db), "equity": snaps, "nodes": nodes,
        "rejections": [[r[0], r[1]] for r in reasons], "audit": [list(r) for r in audit],
        "config": asdict(cfg),
        "today": today, "accounts": [{"name": "this", "equity": eq, "kill": ks.mode.value, "ok": True}],
    }


MANIFEST = json.dumps({"name": "Tree Bot", "short_name": "TreeBot", "start_url": "/", "display": "standalone",
                       "background_color": "#10181d", "theme_color": "#10181d", "icons": [{
                           "src": "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231b2b34'/%3E%3Cpath d='M32 50V30M32 30L18 16M32 30l14-14' stroke='%234cc39a' stroke-width='5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E",
                           "sizes": "any", "type": "image/svg+xml"}]})



SETTINGS_DEFAULT_PROFILE = "standard"
SETTING_LIMITS = {
    "daily_loss_pct": (0.001, 0.20),
}


def apply_profile(cfg, profile):
    presets = {
        "standard": Config.improved,
        "small": Config.small,
        "scalp": Config.scalp,
    }
    if profile not in presets:
        raise ValueError("profile must be standard, small, or scalp")

    preset = presets[profile](db_path=cfg.db_path)
    for name in Config.__dataclass_fields__:
        if name not in ("db_path", "allocated_capital", "risk_per_trade_amount"):
            setattr(cfg, name, getattr(preset, name))


def settings_payload(cfg, profile):
    return {
        "profile": profile,
        "allocated_capital": cfg.allocated_capital,
        "risk_per_trade_amount": cfg.risk_per_trade_amount,
        "daily_loss_pct": cfg.daily_loss_pct,
        "max_open": cfg.max_open,
    }


def load_settings(cfg, default_profile="standard"):
    db = Database(cfg.db_path)
    try:
        profile = db.kv_get("settings_profile", default_profile)
        if profile not in ("standard", "small", "scalp"):
            profile = default_profile
        apply_profile(cfg, profile)

        for key in ("allocated_capital", "risk_per_trade_amount",
                    "daily_loss_pct", "max_open"):
            raw = db.kv_get("setting_" + key)
            if raw is not None:
                value = float(raw)
                if key == "max_open":
                    value = int(value)
                setattr(cfg, key, value)
        return profile
    finally:
        db.close()


def save_settings(cfg, db, body, supervisor):
    if supervisor is None:
        return 503, {"error": "engine supervisor unavailable"}

    state = supervisor.status()["state"]
    if state != "STOPPED":
        return 409, {"error": "stop the engine before changing settings", "engine_state": state}

    allowed = {"profile", "allocated_capital", "risk_per_trade_amount",
               "daily_loss_pct", "max_open"}
    unknown = set(body) - allowed
    if unknown:
        return 400, {"error": "unknown settings", "fields": sorted(unknown)}

    current_profile = db.kv_get("settings_profile", "standard")
    profile = body.get("profile", current_profile)
    if profile not in ("standard", "small", "scalp"):
        return 400, {"error": "profile must be standard, small, or scalp"}

    values = {}
    try:
        for key in ("allocated_capital", "risk_per_trade_amount", "daily_loss_pct"):
            if key in body:
                value = float(body[key])
                if not math.isfinite(value):
                    raise ValueError(key + " must be finite")
                if key in ("allocated_capital", "risk_per_trade_amount") and value < 0:
                    raise ValueError(key + " cannot be negative")
                if key == "daily_loss_pct" and not 0.001 <= value <= 0.20:
                    raise ValueError("daily_loss_pct must be between 0.001 and 0.20")
                values[key] = value

        if "max_open" in body:
            value = body["max_open"]
            if isinstance(value, bool) or int(value) != float(value) or not 1 <= int(value) <= 5:
                raise ValueError("max_open must be a whole number from 1 to 5")
            values["max_open"] = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        return 400, {"error": str(exc)}

    apply_profile(cfg, profile)
    for key, value in values.items():
        setattr(cfg, key, value)

    db.kv_set("settings_profile", profile)
    for key in ("allocated_capital", "risk_per_trade_amount",
                "daily_loss_pct", "max_open"):
        db.kv_set("setting_" + key, getattr(cfg, key))

    db.audit("operator", "settings_updated", settings_payload(cfg, profile))
    return 200, {"saved": True, "settings": settings_payload(cfg, profile)}

_AUTH_CACHE = {}


def verify_supabase_token(access_token):
    """Validate a Supabase access token and return its user record."""
    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    api_key = (
        os.environ.get("SUPABASE_PUBLISHABLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY", "")
    )

    if not base_url or not api_key or not access_token:
        return None

    now = time.time()
    cached = _AUTH_CACHE.get(access_token)
    if cached and cached[0] > now:
        return cached[1]

    request = urllib.request.Request(
        base_url + "/auth/v1/user",
        headers={
            "apikey": api_key,
            "Authorization": "Bearer " + access_token,
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            user = json.loads(response.read().decode())
    except (urllib.error.URLError, ValueError, TimeoutError):
        return None

    if not isinstance(user, dict) or not user.get("id"):
        return None

    _AUTH_CACHE[access_token] = (now + 45, user)
    return user


def make_handler(cfg, token, lan=False, supervisor=None, auth_verifier=None):
    verify = auth_verifier or verify_supabase_token
    admin_ids = {
        value.strip()
        for value in os.environ.get("TREEBOT_ADMIN_USER_IDS", "").split(",")
        if value.strip()
    }

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

        def _identity(self, allow_query=True):
            authorization = self.headers.get("Authorization", "")
            if authorization.startswith("Bearer "):
                user = verify(authorization[7:].strip())
                if user:
                    user_id = str(user.get("id", ""))
                    return {"kind": "supabase", "admin": user_id in admin_ids}

            q = self.path.split("t=")[-1] if allow_query and "t=" in self.path else ""
            if self.headers.get("X-Token") == token or (allow_query and q == token):
                return {"kind": "legacy", "admin": True}
            return None

        def _authed(self):
            return self._identity() is not None

        def _admin(self):
            identity = self._identity(allow_query=False)
            return bool(identity and identity["admin"])

        def do_GET(self):
            route = self.path.split("?")[0]            # "/?t=TOKEN" must still be the page
            if route in ("/", "/desktop"):
                with open(HTML if route == "/" else HTML_DESKTOP, "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            if route == "/manifest.json":
                return self._send(200, MANIFEST, "application/manifest+json")
            if route in ("/api/settings", "/api/access") and not self._authed():
                return self._send(403, json.dumps({"error": "token required"}))
            if route == "/api/access":
                identity = self._identity()
                return self._send(200, safe_json({
                    "authenticated": bool(identity),
                    "admin": bool(identity and identity["admin"]),
                }))
            if lan and route.startswith("/api") and not self._authed():
                return self._send(403, json.dumps({"error": "token required"}))
            if route.startswith("/api/journal"):
                from .journal import Journal
                return self._send(200, safe_json(Journal(Database(cfg.db_path), cfg).analyze()))
            if route == "/api/settings":
                db = Database(cfg.db_path)
                try:
                    profile = db.kv_get("settings_profile", "standard")
                    return self._send(200, safe_json(settings_payload(cfg, profile)))
                finally:
                    db.close()
            if route == "/api/engine":
                if supervisor is None:
                    return self._send(503, json.dumps({"error": "engine supervisor unavailable"}))
                return self._send(200, safe_json(supervisor.status()))
            if route.startswith("/api/state"):
                return self._send(200, safe_json(build_state(Database(cfg.db_path), cfg)))
            self._send(404, "{}")

        def do_POST(self):
            route = self.path.split("?")[0]
            if route not in ("/api/kill", "/api/engine", "/api/settings"):
                return self._send(404, "{}")
            if not self._admin():
                return self._send(403, json.dumps({"error": "administrator access required"}))

            try:
                body = json.loads(
                    self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}"
                )
            except (ValueError, json.JSONDecodeError):
                return self._send(400, json.dumps({"error": "invalid JSON"}))

            if not isinstance(body, dict):
                return self._send(400, json.dumps({"error": "JSON object required"}))

            if route == "/api/settings":
                db = Database(cfg.db_path)
                try:
                    code, result = save_settings(cfg, db, body, supervisor)
                finally:
                    db.close()
                return self._send(code, safe_json(result))

            if route == "/api/engine":
                if supervisor is None:
                    return self._send(503, json.dumps({"error": "engine supervisor unavailable"}))

                action = body.get("action", "")

                if action == "start":
                    db = Database(cfg.db_path)
                    try:
                        kill_mode = KillSwitch(db).mode.value
                    finally:
                        db.close()

                    if kill_mode != Mode.NONE.value:
                        return self._send(409, json.dumps({
                            "error": "kill switch active; explicitly reset it before starting",
                            "kill_mode": kill_mode,
                        }))

                    accepted, state = supervisor.start()
                    code = 200 if accepted else 409
                    return self._send(code, safe_json({
                        "accepted": accepted, **state
                    }))

                if action == "stop":
                    stopped, state = supervisor.stop()
                    code = 200 if stopped else 202
                    return self._send(code, safe_json({
                        "stopped": stopped, **state
                    }))

                return self._send(400, json.dumps({"error": "unknown engine action"}))

            db = Database(cfg.db_path)
            try:
                ks, action = KillSwitch(db), body.get("action", "")
                if action in ("pause", "freeze", "liquidate"):
                    ks.trigger(Mode[action.upper()], "dashboard", actor="operator")
                elif action == "reset":
                    if not ks.reset("operator", body.get("confirm", "")):
                        return self._send(400, json.dumps({"error": "type RESET to confirm"}))
                else:
                    return self._send(400, json.dumps({"error": "unknown action"}))
                result = {"mode": ks.mode.value}
            finally:
                db.close()

            self._send(200, json.dumps(result))
    return H


def serve(cfg, token, port=8765, host="127.0.0.1", supervisor=None):
    """host 127.0.0.1 = this machine only. Other hosts require API authentication."""
    handler = make_handler(
        cfg, token, lan=host != "127.0.0.1", supervisor=supervisor
    )
    srv = ThreadingHTTPServer((host, port), handler)
    try:
        srv.serve_forever()
    finally:
        srv.server_close()
