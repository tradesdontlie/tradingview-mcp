import json
import os
import sys
import threading
import unittest
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
    def serve(self, lan):
        import tempfile
        cfg = Config(db_path=os.path.join(tempfile.mkdtemp(), "s.db"))
        Database(cfg.db_path)
        srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cfg, "secret", lan=lan))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        return f"http://127.0.0.1:{srv.server_port}"

    def get(self, url, token=None):
        req = urllib.request.Request(url, headers={"X-Token": token} if token else {})
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

    def body(self, url):
        return urllib.request.urlopen(url, timeout=5).read().decode()

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
