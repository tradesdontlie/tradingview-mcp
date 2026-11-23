import json
import os
import sys
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import hub
from tradingbot.alerts import format_event, poll_once
from tradingbot.config import Config
from tradingbot.database import Database
from tradingbot.jsonutil import safe_json
from tradingbot.kill_switch import KillSwitch
from tradingbot.models import Mode
from tradingbot.server import make_handler


def st(eq, kill="NONE", nodes=(), day=0.0, dd=0.0):
    return {"account": {"equity": eq, "day_pnl": day, "drawdown_pct": dd}, "kill": {"mode": kill, "reason": "x"},
            "run_mode": "demo", "heartbeat": 10.0, "now": 12.0, "nodes": list(nodes),
            "stats": {"trades": 10, "win_rate": 0.3, "net_pnl": 5.0}, "audit": []}


def node(sym, side, state="OPEN"):
    return {"symbol": sym, "side": side, "state": state}


class Hub(unittest.TestCase):
    def test_merges_equity_and_picks_most_severe_stop(self):
        m = hub.merge([("a", st(1000, day=5)), ("b", st(2000, kill="FREEZE", day=-2, dd=4))])
        self.assertEqual(m["account"]["equity"], 3000)
        self.assertEqual(m["account"]["day_pnl"], 3)
        self.assertEqual(m["kill"]["mode"], "FREEZE")
        self.assertEqual(m["account"]["drawdown_pct"], 4)

    def test_offline_account_is_flagged_not_hidden(self):
        m = hub.merge([("a", st(1000)), ("b", None)])
        self.assertIn("b is offline", m["alerts"])
        self.assertFalse(m["accounts"][1]["ok"])

    def test_double_exposure_across_accounts_is_flagged(self):
        m = hub.merge([("a", st(1, nodes=[node("EURUSD", "BUY")])), ("b", st(1, nodes=[node("EURUSD", "BUY")]))])
        self.assertTrue(any("double exposure" in x for x in m["alerts"]))
        m2 = hub.merge([("a", st(1, nodes=[node("EURUSD", "BUY")])), ("b", st(1, nodes=[node("EURUSD", "SELL")]))])
        self.assertEqual(m2["alerts"], [])

    def test_global_drawdown_freezes_every_agent(self):
        h = hub.Hub([{"name": "a", "url": "u", "token": "t"}, {"name": "b", "url": "u", "token": "t"}], 0.05)
        calls, level = [], [3000]
        orig = hub.call
        hub.call = lambda agent, path, body=None, timeout=4: (calls.append((agent["name"], path, body)) or
                                                              (st(level[0]) if path == "/api/state" else {"mode": "FREEZE"}))
        try:
            h.state()
            level[0] = 2800                                       # -6.7% from combined peak (each agent returns it)
            h.state()
        finally:
            hub.call = orig
        frozen = [c for c in calls if c[1] == "/api/kill" and c[2]["action"] == "freeze"]
        self.assertEqual({c[0] for c in frozen}, {"a", "b"})


class Alerts(unittest.TestCase):
    def test_sends_new_important_events_once(self):
        db = Database()
        ks = KillSwitch(db)
        sent = []
        last = poll_once(db, sent.append, "demo", 0)
        ks.trigger(Mode.FREEZE, "max_drawdown")
        db.audit("exec", "close_history_missing", {})                  # noise: not alerted
        last = poll_once(db, sent.append, "demo", last)
        poll_once(db, sent.append, "demo", last)
        self.assertEqual(sent, ["[demo] STOPPED (FREEZE): max_drawdown"])

    def test_formats(self):
        e = {"event_type": "node_lost", "payload": json.dumps({"net": -12.5})}
        self.assertEqual(format_event(e), "LOSS -12.50")


class Server(unittest.TestCase):
    def serve(self, lan, supervisor=None, kill_mode=None, auth_verifier=None):
        import tempfile
        cfg = Config(db_path=os.path.join(tempfile.mkdtemp(), "s.db"))
        db = Database(cfg.db_path)
        if kill_mode:
            KillSwitch(db).trigger(Mode[kill_mode], "test", actor="test")
        db.close()
        srv = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            make_handler(
                cfg, "secret", lan=lan, supervisor=supervisor,
                auth_verifier=auth_verifier,
            ),
        )
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        return f"http://127.0.0.1:{srv.server_port}"

    def get(self, url, token=None, bearer=None):
        headers = {}
        if token:
            headers["X-Token"] = token
        if bearer:
            headers["Authorization"] = "Bearer " + bearer
        req = urllib.request.Request(url, headers=headers)
        try:
            return urllib.request.urlopen(req, timeout=5).status
        except urllib.error.HTTPError as e:
            return e.code

    def test_open_to_phone_requires_token_for_all_data(self):
        base = self.serve(lan=True)
        self.assertEqual(self.get(base + "/"), 200)                    # the page itself is public
        self.assertEqual(self.get(base + "/api/state"), 403)
        self.assertEqual(self.get(base + "/api/state", "wrong"), 403)
        self.assertEqual(self.get(base + "/api/state", "secret"), 200)
        self.assertEqual(self.get(base + "/api/state?t=secret"), 200)

    def test_supabase_user_can_read_but_not_control(self):
        verifier = lambda token: (
            {"id": "regular-user"} if token == "valid-user" else None
        )
        supervisor = self.FakeSupervisor()
        base = self.serve(
            lan=True, supervisor=supervisor, auth_verifier=verifier
        )

        self.assertEqual(
            self.get(base + "/api/state", bearer="valid-user"), 200
        )
        self.assertEqual(
            self.get(base + "/api/state", bearer="invalid-user"), 403
        )

        status, result = self.post(
            base + "/api/engine", {"action": "start"},
            token=None, bearer="valid-user",
        )
        self.assertEqual(status, 403)
        self.assertEqual(supervisor.state, "STOPPED")

    def test_supabase_regular_user_access_role(self):
        verifier = lambda token: {"id": "regular-user"} if token == "user-token" else None
        base = self.serve(lan=True, auth_verifier=verifier)

        self.assertEqual(self.get(base + "/api/access"), 403)
        self.assertEqual(self.get(base + "/api/access", bearer="invalid"), 403)

        req = urllib.request.Request(
            base + "/api/access",
            headers={"Authorization": "Bearer user-token"},
        )
        with urllib.request.urlopen(req, timeout=5) as response:
            result = json.loads(response.read().decode())

        self.assertTrue(result["authenticated"])
        self.assertFalse(result["admin"])

    def test_supabase_admin_access_role(self):
        with patch.dict(os.environ, {"TREEBOT_ADMIN_USER_IDS": "admin-user"}):
            verifier = lambda token: {"id": "admin-user"} if token == "admin-token" else None
            base = self.serve(lan=True, auth_verifier=verifier)

            req = urllib.request.Request(
                base + "/api/access",
                headers={"Authorization": "Bearer admin-token"},
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                result = json.loads(response.read().decode())

        self.assertTrue(result["authenticated"])
        self.assertTrue(result["admin"])

    def test_supabase_admin_can_control_engine(self):
        with patch.dict(os.environ, {"TREEBOT_ADMIN_USER_IDS": "admin-user"}):
            verifier = lambda token: (
                {"id": "admin-user"} if token == "admin-token" else None
            )
            supervisor = self.FakeSupervisor()
            base = self.serve(
                lan=True, supervisor=supervisor, auth_verifier=verifier
            )

            status, result = self.post(
                base + "/api/engine", {"action": "start"},
                token=None, bearer="admin-token",
            )

        self.assertEqual(status, 200)
        self.assertTrue(result["accepted"])
        self.assertEqual(supervisor.state, "RUNNING")

    def test_supabase_admin_can_activate_kill_switch(self):
        with patch.dict(os.environ, {"TREEBOT_ADMIN_USER_IDS": "admin-user"}):
            verifier = lambda token: (
                {"id": "admin-user"} if token == "admin-token" else None
            )
            base = self.serve(lan=True, auth_verifier=verifier)

            status, result = self.post(
                base + "/api/kill", {"action": "freeze"},
                token=None, bearer="admin-token",
            )

        self.assertEqual(status, 200)
        self.assertEqual(result["mode"], "FREEZE")

    def test_printed_token_link_opens_the_page(self):
        for lan in (False, True):
            base = self.serve(lan=lan)
            self.assertEqual(self.get(base + "/?t=secret"), 200)
            self.assertEqual(self.get(base + "/desktop?t=secret"), 200)

    def test_hub_token_link_opens_the_page(self):
        h = hub.Hub([], 0.06)
        srv = ThreadingHTTPServer(("127.0.0.1", 0), hub.handler(h, "hubtok"))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        self.assertEqual(self.get(f"http://127.0.0.1:{srv.server_port}/?t=hubtok"), 200)

    def post(self, url, payload, token="secret", bearer=None):
        data = json.dumps(payload).encode()
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Token"] = token
        if bearer:
            headers["Authorization"] = "Bearer " + bearer
        req = urllib.request.Request(
            url,
            data=data,
            headers=headers,
            method="POST",
        )
        try:
            response = urllib.request.urlopen(req, timeout=5)
            return response.status, json.loads(response.read().decode())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode())

    class FakeSupervisor:
        def __init__(self):
            self.state = "STOPPED"

        def status(self):
            return {"state": self.state, "alive": self.state == "RUNNING", "error": None}

        def start(self):
            if self.state == "RUNNING":
                return False, self.status()
            self.state = "RUNNING"
            return True, self.status()

        def stop(self):
            self.state = "STOPPED"
            return True, self.status()

    def test_engine_status_start_and_stop(self):
        supervisor = self.FakeSupervisor()
        base = self.serve(lan=True, supervisor=supervisor)

        status, result = self.get_json(base + "/api/engine", "secret")
        self.assertEqual(status, 200)
        self.assertEqual(result["state"], "STOPPED")

        status, result = self.post(base + "/api/engine", {"action": "start"})
        self.assertEqual(status, 200)
        self.assertTrue(result["accepted"])
        self.assertEqual(result["state"], "RUNNING")

        status, result = self.post(base + "/api/engine", {"action": "stop"})
        self.assertEqual(status, 200)
        self.assertTrue(result["stopped"])
        self.assertEqual(result["state"], "STOPPED")

    def test_engine_controls_reject_wrong_token(self):
        supervisor = self.FakeSupervisor()
        base = self.serve(lan=True, supervisor=supervisor)

        status, result = self.post(
            base + "/api/engine", {"action": "start"}, token="wrong"
        )
        self.assertEqual(status, 403)
        self.assertEqual(supervisor.state, "STOPPED")

    def test_engine_start_is_blocked_by_active_kill_switch(self):
        supervisor = self.FakeSupervisor()
        base = self.serve(lan=True, supervisor=supervisor, kill_mode="FREEZE")

        status, result = self.post(base + "/api/engine", {"action": "start"})
        self.assertEqual(status, 409)
        self.assertEqual(result["kill_mode"], "FREEZE")
        self.assertEqual(supervisor.state, "STOPPED")

    def get_json(self, url, token=None):
        req = urllib.request.Request(url, headers={"X-Token": token} if token else {})
        try:
            response = urllib.request.urlopen(req, timeout=5)
            return response.status, json.loads(response.read().decode())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode())

    def body(self, url):
        return urllib.request.urlopen(url, timeout=5).read().decode()

    def test_settings_api_requires_token_and_saves_when_stopped(self):
        supervisor = self.FakeSupervisor()
        base = self.serve(lan=True, supervisor=supervisor)

        self.assertEqual(self.get(base + "/api/settings"), 403)

        status, result = self.post(base + "/api/settings", {
            "profile": "small",
            "allocated_capital": 500,
            "risk_per_trade_amount": 5,
            "daily_loss_pct": 0.03,
            "max_open": 2,
        })
        self.assertEqual(status, 200)
        self.assertTrue(result["saved"])
        self.assertEqual(result["settings"]["profile"], "small")
        self.assertEqual(result["settings"]["allocated_capital"], 500)
        self.assertEqual(result["settings"]["risk_per_trade_amount"], 5)
        self.assertEqual(result["settings"]["max_open"], 2)

        status, result = self.get_json(base + "/api/settings", "secret")
        self.assertEqual(status, 200)
        self.assertEqual(result["allocated_capital"], 500)

    def test_settings_api_rejects_changes_while_engine_is_running(self):
        supervisor = self.FakeSupervisor()
        base = self.serve(lan=True, supervisor=supervisor)
        supervisor.state = "RUNNING"

        status, result = self.post(base + "/api/settings", {
            "allocated_capital": 900,
        })
        self.assertEqual(status, 409)
        self.assertIn("stop the engine", result["error"])

    def test_settings_api_rejects_invalid_values(self):
        supervisor = self.FakeSupervisor()
        base = self.serve(lan=True, supervisor=supervisor)

        for payload in (
            {"daily_loss_pct": 0.5},
            {"max_open": 6},
            {"allocated_capital": -10},
            {"profile": "unknown"},
        ):
            status, _ = self.post(base + "/api/settings", payload)
            self.assertEqual(status, 400)

    def test_settings_persist_and_restore_on_startup(self):
        import tempfile
        from tradingbot.server import load_settings, save_settings

        path = os.path.join(tempfile.mkdtemp(), "settings.db")
        cfg = Config(db_path=path)
        db = Database(path)
        supervisor = self.FakeSupervisor()

        try:
            status, result = save_settings(cfg, db, {
                "profile": "scalp",
                "allocated_capital": 750,
                "risk_per_trade_amount": 7.5,
                "daily_loss_pct": 0.04,
                "max_open": 3,
            }, supervisor)
            self.assertEqual(status, 200)
        finally:
            db.close()

        restored = Config(db_path=path)
        profile = load_settings(restored)

        self.assertEqual(profile, "scalp")
        self.assertEqual(restored.allocated_capital, 750)
        self.assertEqual(restored.risk_per_trade_amount, 7.5)
        self.assertEqual(restored.daily_loss_pct, 0.04)
        self.assertEqual(restored.max_open, 3)

    def test_a_fresh_bot_with_no_trades_sends_json_a_browser_can_parse(self):
        def strict(const):                                   # what a browser does: Infinity/NaN are errors
            raise ValueError(const)
        for lan in (False, True):
            base = self.serve(lan=lan)
            for path in ("/api/state", "/api/journal"):
                req = urllib.request.Request(base + path + "?t=secret")
                text = urllib.request.urlopen(req, timeout=5).read().decode()
                json.loads(text, parse_constant=strict)
                self.assertNotIn("Infinity", text)

    def test_non_finite_numbers_become_null(self):
        out = json.loads(safe_json({"pf": float("inf"), "x": [float("nan"), 1.5], "n": {"a": float("-inf")}}))
        self.assertEqual(out, {"pf": None, "x": [None, 1.5], "n": {"a": None}})

    def test_local_only_mode_serves_state_and_manifest(self):
        base = self.serve(lan=False)
        self.assertEqual(self.get(base + "/api/state"), 200)
        self.assertEqual(self.get(base + "/manifest.json"), 200)
        self.assertEqual(self.get(base + "/desktop"), 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
