import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tradingbot.analytics import summarize
from tradingbot.broker_sim import SimBroker
from tradingbot.config import Config
from tradingbot.database import Database
from tradingbot.kill_switch import KillSwitch
from tradingbot.models import Mode, Signal
from tradingbot.orchestrator import Bot
from tradingbot.risk_manager import RiskManager
from tradingbot.trade_scheduler import assign
from tradingbot.tree_manager import TreeManager


def make(strategy=lambda now, b: [], equity=10000.0, path=":memory:", seed=1, cfg=None):
    cfg = cfg or Config()
    broker = SimBroker(equity=equity, seed=seed)
    db = Database(path)
    return Bot(cfg, db, broker, strategy), broker, db


def one_shot(side="BUY", symbol="EURUSD"):
    fired = []

    def strat(now, broker):
        if fired:
            return []
        fired.append(1)
        return [Signal(symbol, side, 0.0020, now)]
    return strat


def random_strategy(seed=3):
    rng = random.Random(seed)

    def strat(now, broker):
        if rng.random() < 0.5:
            return [Signal(rng.choice(["EURUSD", "GBPUSD", "USDJPY"]),
                           rng.choice(["BUY", "SELL"]), 0.0020, now)]
        return []
    return strat


class TreeRules(unittest.TestCase):
    def test_child_budget_math(self):
        db, cfg = Database(), Config()
        tree = TreeManager(db, cfg)
        rid = tree.create_root(Signal("EURUSD", "BUY", 0.002, 0), 50.0, 0)
        kids = tree.on_closed(rid, 150.0, 0)            # a 3R win on $50 risk
        self.assertEqual(len(kids), 2)
        for k in kids:
            n = db.node(k)
            self.assertAlmostEqual(n["budget"], 25.0)        # 1/6 of profit
            self.assertAlmostEqual(n["planned_loss"], 12.5)  # half of that = risk/4
        self.assertAlmostEqual(float(db.kv_get("root_pool")), 15.0)   # 10% of 150

    def test_loss_kills_only_its_branch_and_is_idempotent(self):
        db = Database()
        tree = TreeManager(db, Config())
        rid = tree.create_root(Signal("EURUSD", "BUY", 0.002, 0), 50.0, 0)
        k1, k2 = tree.on_closed(rid, 150.0, 0)
        self.assertEqual(tree.on_closed(k1, -12.5, 1), [])
        self.assertEqual(db.node(k1)["state"], "LOST")
        self.assertEqual(db.node(k2)["state"], "QUEUED")          # sibling continues
        tree.on_closed(k1, +999.0, 2)                              # duplicate event ignored
        self.assertEqual(db.node(k1)["net_pnl"], -12.5)

    def test_cancel_descendants(self):
        db, tree = Database(), TreeManager(Database(), Config())
        tree.db = db
        p = db.add_node(level=0, state="OPEN", budget=1, planned_loss=1)
        c = db.add_node(parent_id=p, root_id=p, level=1, state="QUEUED", budget=1, planned_loss=1)
        g = db.add_node(parent_id=c, root_id=p, level=2, state="QUEUED", budget=1, planned_loss=1)
        self.assertCountEqual(tree.cancel_descendants(p), [c, g])
        self.assertEqual(db.node(g)["state"], "CANCELLED")

    def test_unused_budget_expires(self):
        db, cfg = Database(), Config()
        tree = TreeManager(db, cfg)
        rid = tree.create_root(Signal("EURUSD", "BUY", 0.002, 0), 50.0, 0)
        kids = tree.on_closed(rid, 150.0, 0)
        tree.expire(cfg.child_ttl_s + 1)
        self.assertTrue(all(db.node(k)["state"] == "EXPIRED" for k in kids))

    def test_scheduler_reserves_a_root_slot(self):
        cfg = Config()
        sigs = [Signal("EURUSD", "BUY", 0.002, 0)]
        kid = {"node_id": 9}
        self.assertEqual(assign(sigs, [kid], 2, 0, cfg), [])                 # full
        self.assertEqual(assign(sigs, [kid], 1, 1, cfg)[0][0], None)          # root, not 2nd child
        self.assertEqual(assign(sigs, [kid], 0, 0, cfg)[0][0], kid)           # child first


class RiskRules(unittest.TestCase):
    def setUp(self):
        self.bot, self.broker, self.db = make()
        self.spec = self.broker.spec("EURUSD")
        self.acct = self.broker.account()

    def ev(self, planned, sig=None, quote=None):
        sig = sig or Signal("EURUSD", "BUY", 0.0020, self.broker.now())
        return self.bot.risk.evaluate(planned, sig, self.spec, quote or self.broker.quote("EURUSD"),
                                      self.acct, self.broker.now())

    def test_volume_rounds_down_never_up(self):
        d = self.ev(12.5)                       # $200/lot -> 0.0625 lot -> 0.06
        self.assertTrue(d.approved)
        self.assertAlmostEqual(d.volume, 0.06)
        self.assertLessEqual(d.risk_amount, 12.5)

    def test_dust_below_minimum_lot_is_rejected_permanently(self):
        d = self.ev(1.5)                        # min lot risks $2 > $1.50
        self.assertFalse(d.approved)
        self.assertEqual(d.reason, "below_min_lot")
        self.assertTrue(d.permanent)

    def test_risk_manager_enforces_open_limit_on_its_own(self):
        for sym, side in (("EURUSD", "BUY"), ("USDJPY", "SELL")):
            self.db.add_node(level=0, state="OPEN", budget=1, planned_loss=1, symbol=sym,
                             side=side, risk_amount=1.0)
        self.assertEqual(self.ev(50).reason, "max_open_reached")

    def test_risk_manager_caps_total_open_risk(self):
        self.db.add_node(level=0, state="OPEN", budget=1, planned_loss=1, symbol="USDJPY",
                         side="SELL", risk_amount=149.0)        # $1 of headroom left: below one minimum lot
        d = self.bot.risk.evaluate(50, Signal("EURUSD", "BUY", 0.0020, self.broker.now()),
                                   self.spec, self.broker.quote("EURUSD"), self.acct,
                                   self.broker.now())
        self.assertFalse(d.approved)                            # headroom ($1) cannot fund a minimum lot ($2)
        self.assertEqual(d.reason, "no_risk_headroom")

    def test_stale_signal(self):
        old = Signal("EURUSD", "BUY", 0.0020, self.broker.now() - 10_000)
        self.assertEqual(self.ev(50, old).reason, "stale_signal")

    def test_wide_spread(self):
        self.assertEqual(self.ev(50, quote=(1.1000, 1.1010)).reason, "spread_too_wide")

    def test_correlated_exposure_blocked(self):
        self.db.add_node(level=0, state="OPEN", budget=1, planned_loss=1, symbol="EURUSD",
                         side="BUY", risk_amount=10.0)
        self.assertEqual(self.ev(50, Signal("GBPUSD", "BUY", 0.002, self.broker.now()),
                                 self.broker.quote("GBPUSD")).reason, "correlated_exposure")
        jpy = self.bot.risk.evaluate(50, Signal("USDJPY", "BUY", 0.20, self.broker.now()),
                                     self.broker.spec("USDJPY"), self.broker.quote("USDJPY"),
                                     self.acct, self.broker.now())
        self.assertTrue(jpy.approved)         # long USD does not overlap EUR-long / USD-short

    def test_daily_loss_pauses_and_drawdown_freezes(self):
        self.bot.tick()
        self.broker.balance = 9600              # -4% on the day
        self.bot.tick()
        self.assertEqual(self.bot.kill.mode, Mode.PAUSE)
        self.broker.balance = 8900              # -11% from peak
        self.bot.tick()
        self.assertEqual(self.bot.kill.mode, Mode.FREEZE)


class KillSwitchRules(unittest.TestCase):
    def test_persists_across_restart_and_needs_explicit_reset(self):
        path = os.path.join(tempfile.mkdtemp(), "k.db")
        k1 = KillSwitch(Database(path))
        self.assertTrue(k1.trigger(Mode.FREEZE, "test"))
        k2 = KillSwitch(Database(path))                      # "restart"
        self.assertEqual(k2.mode, Mode.FREEZE)
        self.assertFalse(k2.trigger(Mode.PAUSE, "weaker"))   # cannot downgrade
        self.assertFalse(k2.reset("op", confirm="yes"))
        self.assertEqual(k2.mode, Mode.FREEZE)
        self.assertTrue(k2.reset("op", confirm="RESET"))
        self.assertEqual(k2.mode, Mode.NONE)

    def test_paused_bot_sends_no_orders(self):
        bot, broker, db = make(random_strategy())
        bot.kill.trigger(Mode.PAUSE, "test")
        for _ in range(50):
            bot.tick()
            broker.step()
        self.assertEqual(broker.send_calls, 0)

    def test_liquidate_closes_everything(self):
        bot, broker, db = make(one_shot())
        bot.tick()
        self.assertEqual(len(broker.positions()), 1)
        bot.kill.trigger(Mode.LIQUIDATE, "drill")
        bot.tick()
        self.assertEqual(len(broker.positions()), 0)
        bot.tick()
        self.assertEqual(db.nodes("OPEN"), [])               # booked, nothing left open


class ExecutionSafety(unittest.TestCase):
    def test_lost_ack_does_not_duplicate_order(self):
        bot, broker, db = make(one_shot())
        broker.fail_next = "lost_ack"
        bot.tick()
        self.assertEqual(broker.send_calls, 1)
        self.assertEqual(len(broker.positions()), 1)
        self.assertEqual(len(db.nodes("OPEN")), 1)
        for _ in range(5):
            bot.tick()
        self.assertEqual(broker.send_calls, 1)

    def test_rejected_root_is_cancelled_not_retried(self):
        bot, broker, db = make(one_shot())
        broker.fail_next = "reject"
        bot.tick()
        self.assertEqual(db.nodes("CANCELLED")[0]["level"], 0)
        self.assertEqual(broker.send_calls, 1)

    def test_unverifiable_order_pauses_then_resolves_after_reconnect(self):
        bot, broker, db = make(one_shot())
        broker.fail_next = "lost_ack"
        real_find, calls = broker.find_position, []

        def flaky(cid):
            if not calls:
                calls.append(1)
                raise ConnectionError("still offline")
            return real_find(cid)
        broker.find_position = flaky
        bot.tick()
        self.assertEqual(db.nodes("SENDING")[0]["client_id"], "tm1a1")
        self.assertEqual(bot.kill.mode, Mode.PAUSE)
        bot.tick()                                           # reconcile finds the position
        self.assertEqual(len(db.nodes("OPEN")), 1)
        self.assertEqual(broker.send_calls, 1)
        self.assertEqual(bot.kill.mode, Mode.PAUSE)          # stays paused until a human resets

    def test_restart_recovers_without_resending(self):
        path = os.path.join(tempfile.mkdtemp(), "r.db")
        bot, broker, db = make(one_shot(), path=path)
        bot.tick()
        self.assertEqual(len(db.nodes("OPEN")), 1)
        bot2 = Bot(Config(), Database(path), broker, lambda now, b: [])   # new process
        bot2.startup()
        self.assertEqual(broker.send_calls, 1)
        for _ in range(300):
            broker.step()
            bot2.tick()
        self.assertEqual(bot2.db.nodes("OPEN", "SENDING"), [])
        self.assertGreaterEqual(len(bot2.db.nodes("WON", "LOST")), 1)

    def test_broker_offline_pauses(self):
        bot, broker, db = make(one_shot())
        broker.connected = False
        bot.tick()
        self.assertEqual(bot.kill.mode, Mode.PAUSE)


class FullSimulationInvariants(unittest.TestCase):
    def test_invariants_over_a_long_run(self):
        bot, broker, db = make(random_strategy(), seed=11)
        start = broker.balance
        for _ in range(3000):
            bot.tick()
            self.assertLessEqual(len(broker.positions()), 2)           # never more than 2 open
            self.assertLessEqual(len(db.nodes("OPEN", "SENDING")), 2)
            broker.step()
        bot.strategy = lambda now, b: []
        bot.tick()
        nodes = {n["node_id"]: n for n in db.nodes()}
        done = [n for n in nodes.values() if n["state"] in ("WON", "LOST")]
        self.assertGreater(len(done), 20)
        for n in nodes.values():
            if n["parent_id"]:
                self.assertEqual(nodes[n["parent_id"]]["state"], "WON")  # only winners spawn
            if n["state"] == "LOST":
                self.assertEqual(db.children_of(n["node_id"]), [])       # losers have no children
            if n["state"] in ("WON", "LOST", "OPEN") and n["risk_amount"]:
                self.assertLessEqual(n["risk_amount"], n["planned_loss"] + 1e-9)  # risk <= budget
        # the ledger must match the broker's actual balance change
        self.assertAlmostEqual(sum(n["net_pnl"] for n in done), broker.balance - start, places=6)
        s = summarize(db)
        self.assertEqual(s["trades"], len(done))


if __name__ == "__main__":
    unittest.main(verbosity=2)
