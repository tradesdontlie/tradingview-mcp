import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import hub
from tradingbot.advanced_bot import AdvancedBot
from tradingbot.broker_sim import SimBroker
from tradingbot.config import Config
from tradingbot.database import Database
from tradingbot.models import Mode, Signal
from tradingbot.server import build_state
from tradingbot.tree_manager import TreeManager

T0 = 1_699_999_200


def won(tree, db, risk=50.0, net=150.0):
    rid = tree.create_root(Signal("EURUSD", "BUY", 0.002, 0), risk, 0)
    db.update_node(rid, risk_amount=risk, entry=1.1, sl=1.098, symbol="EURUSD")
    return tree.on_closed(rid, net, 1)


class Children(unittest.TestCase):
    def tree(self, **kw):
        db = Database()
        t = TreeManager(db, Config.improved(**kw))
        return db, t

    def test_original_rules_unchanged_without_a_minimum_lot_hint(self):
        db, t = self.tree()
        self.assertEqual(len(won(t, db)), 2)

    def test_children_that_can_afford_a_minimum_lot_stay_two(self):
        db, t = self.tree()
        t.min_risk_fn = lambda node: 20.0              # each half budget (25) can risk up to 25
        kids = won(t, db)
        self.assertEqual(len(kids), 2)
        self.assertAlmostEqual(db.node(kids[0])["planned_loss"], 20.0)   # raised just enough for one lot

    def test_small_budgets_merge_into_one_fundable_child(self):
        db, t = self.tree()
        t.min_risk_fn = lambda node: 40.0              # halves (25 each) cannot fund it; combined (50) can
        kids = won(t, db)
        self.assertEqual(len(kids), 1)
        self.assertAlmostEqual(db.node(kids[0])["budget"], 50.0)
        self.assertAlmostEqual(db.node(kids[0])["planned_loss"], 40.0)

    def test_unfundable_children_are_never_created(self):
        db, t = self.tree()
        t.min_risk_fn = lambda node: 500.0
        self.assertEqual(won(t, db), [])                # profit is banked, no dust records
        self.assertEqual(db.nodes("DUST", "EXPIRED"), [])

    def test_queue_is_capped(self):
        db, t = self.tree(max_queued_children=2)
        self.assertEqual(len(won(t, db)), 2)
        self.assertEqual(won(t, db), [])                # queue already full


class Risk(unittest.TestCase):
    def setUp(self):
        self.broker = SimBroker(t0=T0)
        self.db = Database()
        self.cfg = Config.improved(daily_loss_pct=0.5, weekly_loss_pct=0.04)
        self.bot = AdvancedBot(self.cfg, self.db, self.broker, lambda n, b: [])
        self.now = self.broker.now()

    def test_overlapping_trade_is_allowed_at_half_risk(self):
        self.db.add_node(level=0, state="OPEN", budget=1, planned_loss=1, symbol="EURUSD", side="BUY", risk_amount=5.0)
        sig = Signal("GBPUSD", "BUY", 0.0020, self.now)            # also short USD: overlaps
        d = self.bot.risk.evaluate(50.0, sig, self.broker.spec("GBPUSD"), self.broker.quote("GBPUSD"),
                                   self.broker.account(), self.now)
        self.assertTrue(d.approved)
        self.assertLessEqual(d.risk_amount, 25.0)

    def test_weekly_loss_limit_pauses(self):
        acct = self.broker.account()
        self.bot.risk.check_account(acct, self.now)
        self.broker.balance *= 0.955                                 # -4.5%: past weekly 4%, short of the 5% lockout
        self.bot.risk.check_account(self.broker.account(), self.now + 3600)
        self.assertEqual(self.bot.kill.mode, Mode.PAUSE)
        self.assertEqual(self.bot.kill.reason, "weekly_loss_limit")


class Today(unittest.TestCase):
    def test_counts_wins_losses_and_percentages(self):
        db = Database()
        db.snapshot(1000, 1000, 1000)
        now = db.clock()
        for i, net in enumerate((30.0, -10.0, -10.0, 30.0, -10.0)):
            db.add_node(level=0, state="WON" if net > 0 else "LOST", budget=1, planned_loss=1,
                        net_pnl=net, opened_ts=now - 60, closed_ts=now - 30)
        db.add_node(level=0, state="LOST", budget=1, planned_loss=1, net_pnl=-99, opened_ts=now - 400000,
                    closed_ts=now - 400000)                                    # old trade: not today
        t = build_state(db, Config())["today"]
        self.assertEqual((t["closed"], t["wins"], t["losses"]), (5, 2, 3))
        self.assertAlmostEqual(t["win_pct"], 40.0)
        self.assertAlmostEqual(t["loss_pct"], 60.0)
        self.assertAlmostEqual(t["net"], 30.0)

    def test_hub_adds_up_accounts(self):
        s = lambda w, l: {"account": {"equity": 1, "day_pnl": 0, "drawdown_pct": 0}, "kill": {"mode": "NONE", "reason": ""},
                          "run_mode": "d", "heartbeat": 1.0, "now": 2.0, "nodes": [], "audit": [],
                          "stats": {"trades": 0, "win_rate": 0, "net_pnl": 0},
                          "today": {"opened": w + l, "closed": w + l, "wins": w, "losses": l, "net": w * 3 - l}}
        m = hub.merge([("a", s(1, 1)), ("b", s(2, 0))])
        self.assertEqual((m["today"]["wins"], m["today"]["losses"]), (3, 1))
        self.assertAlmostEqual(m["today"]["win_pct"], 75.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
