"""Hub: ONE phone screen for MANY broker accounts. Each account runs its own bot (app.py, own
port and database); the hub merges them and can stop them all at once.

    python hub.py --agent exness=http://127.0.0.1:8765,TOKEN1 --agent other=http://127.0.0.1:8766,TOKEN2 \
                  --host 0.0.0.0 --max-dd 0.06
Hub token: env HUB_TOKEN (printed if unset). Global guard: if COMBINED equity falls max-dd from its
combined peak, every agent is frozen. Also flags the same trade open on several accounts."""
import argparse
import json
import os
import secrets
import urllib.request

from tradingbot.jsonutil import safe_json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SEV = {"NONE": 0, "PAUSE": 1, "FREEZE": 2, "LIQUIDATE": 3}
ROOT = os.path.dirname(os.path.abspath(__file__))


def call(agent, path, body=None, timeout=4):
    url, tok = agent["url"] + path, agent["token"]
    req = urllib.request.Request(url, json.dumps(body).encode() if body is not None else None,
                                 {"X-Token": tok, "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


def merge(results):
    """results: [(name, state_or_None)] -> one state in the same shape a single bot returns."""
    out = {"run_mode": "hub", "heartbeat": 0.0, "now": 0.0, "kill": {"mode": "NONE", "reason": ""},
           "account": {"equity": 0.0, "day_pnl": 0.0, "drawdown_pct": 0.0}, "nodes": [], "accounts": [],
           "rejections": [], "audit": [], "equity": [], "config": {}, "stats": {}, "alerts": []}
    wins = trades = 0
    td = {"opened": 0, "closed": 0, "wins": 0, "losses": 0, "net": 0.0}
    net, seen = 0.0, {}
    for name, s in results:
        if s is None:
            out["accounts"].append({"name": name, "ok": False, "equity": 0, "kill": "OFFLINE"})
            out["alerts"].append(f"{name} is offline")
            continue
        out["accounts"].append({"name": name, "ok": True, "equity": s["account"]["equity"],
                                "kill": s["kill"]["mode"], "mode": s["run_mode"]})
        a = out["account"]
        a["equity"] += s["account"]["equity"]
        a["day_pnl"] += s["account"]["day_pnl"]
        a["drawdown_pct"] = max(a["drawdown_pct"], s["account"]["drawdown_pct"])
        if SEV[s["kill"]["mode"]] > SEV[out["kill"]["mode"]]:
            out["kill"] = {"mode": s["kill"]["mode"], "reason": f"{name}: {s['kill']['reason']}"}
        out["heartbeat"] = max(out["heartbeat"], s["heartbeat"])
        out["now"] = max(out["now"], s["now"])
        for n in s["nodes"]:
            n["account"] = name
            out["nodes"].append(n)
            if n["state"] in ("OPEN", "SENDING"):
                seen.setdefault((n["symbol"], n["side"]), []).append(name)
        for k in td:
            td[k] += (s.get("today") or {}).get(k, 0)
        st = s["stats"]
        trades += st.get("trades", 0)
        wins += round(st.get("win_rate", 0) * st.get("trades", 0))
        net += st.get("net_pnl", 0)
        out["audit"] += [e + [name] for e in s["audit"][:6]]
    for (sym, side), names in seen.items():
        if len(set(names)) > 1:
            out["alerts"].append(f"{sym} {side} is open on {len(set(names))} accounts: double exposure")
    td["win_pct"] = td["wins"] / td["closed"] * 100 if td["closed"] else 0.0
    td["loss_pct"] = td["losses"] / td["closed"] * 100 if td["closed"] else 0.0
    out["today"] = td
    out["stats"] = {"trades": trades, "win_rate": wins / trades if trades else 0, "net_pnl": net,
                    "profit_factor": 0, "trades_per_root": 0, "root_pool": 0, "states": {}, "by_level": {}}
    return out


class Hub:
    def __init__(self, agents, max_dd):
        self.agents, self.max_dd, self.peak = agents, max_dd, 0.0

    def state(self):
        res = []
        for a in self.agents:
            try:
                res.append((a["name"], call(a, "/api/state")))
            except Exception:
                res.append((a["name"], None))
        m = merge(res)
        eq = m["account"]["equity"]
        self.peak = max(self.peak, eq)
        if self.peak > 0 and (self.peak - eq) / self.peak >= self.max_dd and m["kill"]["mode"] == "NONE":
            self.kill("freeze", "hub: combined drawdown limit")
            m["alerts"].append("Combined drawdown limit hit: all accounts frozen")
        return m

    def kill(self, action, why="hub"):
        done = {}
        for a in self.agents:
            try:
                done[a["name"]] = call(a, "/api/kill", {"action": action, "confirm": "RESET" if action == "reset" else ""})
            except Exception as e:
                done[a["name"]] = {"error": str(e)}
        return done


def handler(hub, token):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _ok(self):
            return self.headers.get("X-Token") == token or ("t=" + token) in self.path

        def do_GET(self):
            route = self.path.split("?")[0]
            if route == "/":
                return self._send(200, open(os.path.join(ROOT, "dashboard", "mobile.html"), "rb").read(),
                                  "text/html; charset=utf-8")
            if not self._ok():
                return self._send(403, '{"error":"token required"}')
            if route.startswith("/api/state"):
                return self._send(200, safe_json(hub.state()))
            if route.startswith("/api/journal"):
                try:
                    return self._send(200, safe_json(call(hub.agents[0], "/api/journal")))
                except Exception:
                    return self._send(200, "{}")
            self._send(404, "{}")

        def do_POST(self):
            if self.path != "/api/kill" or not self._ok():
                return self._send(403, '{"error":"token required"}')
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            self._send(200, json.dumps({"mode": body.get("action"), "accounts": hub.kill(body.get("action", ""))}))
    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", action="append", required=True, help="name=http://host:port,TOKEN")
    ap.add_argument("--port", type=int, default=8800)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--max-dd", type=float, default=0.06)
    a = ap.parse_args()
    agents = []
    for spec in a.agent:
        name, rest = spec.split("=", 1)
        url, _, tok = rest.partition(",")
        agents.append({"name": name, "url": url.rstrip("/"), "token": tok or os.environ.get("DASHBOARD_TOKEN", "")})
    token = os.environ.get("HUB_TOKEN") or secrets.token_urlsafe(8)
    print(f"\nHub:  http://{a.host}:{a.port}/?t={token}   token: {token}   ({len(agents)} accounts)\n")
    ThreadingHTTPServer((a.host, a.port), handler(Hub(agents, a.max_dd), token)).serve_forever()


if __name__ == "__main__":
    main()
