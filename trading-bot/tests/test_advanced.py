import json
import os
import random
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tradingbot.advanced_bot import AdvancedBot
from tradingbot.broker_sim import SimBroker
from tradingbot.checklist import market_checks
from tradingbot.config import Config
from tradingbot.database import Database
from tradingbot.equity_guard import EquityGuard
from tradingbot.journal import Journal
from tradingbot.kill_switch import KillSwitch
from tradingbot.market_context import build_context
from tradingbot.models import Mode, Signal
from tradingbot.stats import breakeven_win_rate, wilson
from tradingbot.tree_manager import TreeManager

T0 = 1_699_999_200            # on the hour, so sessions line up


def trending_broker(seed=1, bars=900):
    b = SimBroker(seed=seed, t0=T0, trend=0.000004)
    b.warmup(bars)
    return b


class Context(unittest.TestCase):
    def test_no_lookahead(self):
        """Features at bar t must not change when FUTURE bars are added. Checked at many cut
        points, because 4h bars are only partially formed at some cuts and not others."""
        df = trending_broker(bars=1000).candles("EURUSD", 1000)
        full = build_context(df)
        for cut in range(600, 760, 5):
            part = build_context(df.iloc[:cut])
            for col in part.columns:
                x = part[col].astype(float).values[-12:]
                y = full[col].astype(float).values[cut - 12:cut]
                self.assertTrue(np.allclose(x, y, equal_nan=True), f"look-ahead in {col} at cut {cut}")


    def test_4h_trend_ignores_the_unfinished_4h_bar(self):
        """A crash inside the current 4h window must not rewrite trend values already shown."""
        import pandas as pd
        n = 600
        idx = pd.date_range("2024-01-01 00:00", periods=n + 1, freq="h")
        close = 1.0 + 0.0005 * np.arange(n + 1)                 # steady uptrend: trend flag is +1
        df = pd.DataFrame({"open": close - 0.0002, "high": close + 0.0003,
                           "low": close - 0.0003, "close": close}, index=idx)
        cut = next(i for i in range(500, n) if idx[i].hour % 4 == 2)    # prefix ends mid-4h-window
        prefix = df.iloc[:cut].copy()
        crashed = df.iloc[:cut + 1].copy()
        crashed.iloc[-1] = [0.5, 0.5, 0.4, 0.5]                          # next hour, same 4h window
        a = build_context(prefix)["htf"].values
        b = build_context(crashed)["htf"].values[:cut]
        self.assertEqual(int(a[-1]), 1)
        self.assertTrue((a == b).all(), "4h trend used a bar that had not finished")


def good_row(side="BUY"):
    s = 1 if side == "BUY" else -1
    r = dict(open=1.1000, high=1.1010, low=1.0980, close=1.1005, atr=0.0010, atr_ratio=1.0, dist_ma=-0.5 * s,
             low5=1.0985, high5=1.1025, swing_high=1.1100, swing_low=1.0900, htf=s, zone=-s,
             bos_up_recent=True, bos_dn_recent=True, sweep_low_recent=False, sweep_high_recent=False,
             ob_buy_tap=False, ob_sell_tap=False, orb_up=False, orb_dn=False,
             reject_buy=True, reject_sell=True, hour=9, dow=2)
    if side == "SELL":
        r.update(close=1.0995, low5=1.0975, high5=1.1015)
    return r


class Checklist(unittest.TestCase):
    cfg = Config()

    def test_clean_setup_passes_both_sides(self):
        for side in ("BUY", "SELL"):
            res = market_checks(good_row(side), side, 0.00005, self.cfg)
            self.assertTrue(res.passed, (side, res.failed))
            self.assertEqual(res.trigger, "rejection")

    def test_each_item_can_veto(self):
        cases = {"trend": dict(htf=-1), "structure": dict(bos_up_recent=False),
                 "location": dict(zone=1), "trigger": dict(reject_buy=False),
                 "not_chasing": dict(dist_ma=3.0), "volatility": dict(atr_ratio=2.5),
                 "session": dict(hour=3), "room": dict(swing_high=1.1012)}
        for name, change in cases.items():
            row = {**good_row(), **change}
            self.assertIn(name, market_checks(row, "BUY", 0.00005, self.cfg).failed, name)
        self.assertIn("spread_stop", market_checks(good_row(), "BUY", 0.0005, self.cfg).failed)
        self.assertIn("session", market_checks({**good_row(), "dow": 4, "hour": 19}, "BUY", 0.00005,
                                               self.cfg).failed)

    def test_missing_data_fails_safe(self):
        row = {**good_row(), "atr": float("nan")}
        self.assertEqual(market_checks(row, "BUY", 0.0, self.cfg).failed, ["data"])


class Learning(unittest.TestCase):
    def setUp(self):
        self.db, self.cfg = Database(), Config.improved()
        self.j = Journal(self.db, self.cfg)

    def add(self, i, setup, session, net, risk=10.0):
        res = market_checks(good_row(), "BUY", 0.00005, self.cfg)
        row = {**good_row(), "hour": 9 if session == "london" else 3}
        self.j.record_entry(i, i, Signal("EURUSD", "BUY", 0.001, i), 0, i, setup, row, res, None, False,
                            risk, 3.0, 0.00005)
        self.j.record_exit(i, i + 1, net)

    def test_r_multiple_tags_and_lesson(self):
        self.add(1, "sweep", "london", -10.0)
        row = self.j.closed()[0]
        self.assertAlmostEqual(row["r_multiple"], -1.0)
        self.assertEqual(row["exit_reason"], "SL")
        self.assertIn("setup:sweep", json.loads(row["tags"]))
        self.assertTrue(row["lesson"].startswith("LOSS -1.00R"))

    def test_small_samples_never_block(self):
        for i in range(10):
            self.add(i, "ob", "london", -10.0)
        self.assertEqual(self.j.blocked_buckets(), set())          # 10 < gate_min_n

    def test_proven_loser_is_blocked_proven_winner_is_not(self):
        for i in range(40):
            self.add(i, "orb", "london", -10.0)                     # 0/40 wins
            self.add(100 + i, "sweep", "london", 30.0 if i % 3 == 0 else -10.0)   # 33% wins
        blocked = self.j.blocked_buckets()
        self.assertIn("setup:orb", blocked)
        self.assertNotIn("setup:sweep", blocked)

    def test_win_prob_needs_evidence(self):
        for i in range(10):
            self.add(i, "sweep", "london", 30.0)
        self.assertIsNone(self.j.win_prob_lcb("sweep", 30))
        for i in range(10, 40):
            self.add(i, "sweep", "london", 30.0)
        self.assertGreater(self.j.win_prob_lcb("sweep", 30), 0.85)

    def test_wilson_and_breakeven(self):
        lo, hi = wilson(30, 100)
        self.assertTrue(lo < 0.30 < hi)
        self.assertAlmostEqual(breakeven_win_rate(3.0, 0.0), 0.25)


class Guard(unittest.TestCase):
    def setUp(self):
        self.db, self.cfg = Database(), Config.improved()
        self.kill = KillSwitch(self.db)
        self.g = EquityGuard(self.db, self.cfg, self.kill)

    def test_profit_lock_ratchets_and_trips(self):
        self.g.update(10000, 0)
        self.g.update(10200, 1)                      # +2%: lock not armed yet
        self.assertEqual(self.g.state()["floor"], 0.0)
        self.g.update(11000, 2)                      # peak +10% -> floor protects half the gain
        self.assertAlmostEqual(self.g.state()["floor"], 10500)
        self.g.update(10600, 3)
        self.assertEqual(self.kill.mode, Mode.NONE)
        self.g.update(10450, 4)                      # below the floor
        self.assertEqual(self.kill.mode, Mode.PAUSE)
        self.assertEqual(self.kill.reason, "profit_lock_floor")

    def test_rearms_after_operator_reset(self):
        for i, e in enumerate((10000, 11000, 10400)):
            self.g.update(e, i)
        self.assertEqual(self.kill.mode, Mode.PAUSE)
        self.kill.reset("op", "RESET")
        self.g.update(10400, 10)
        self.assertEqual(self.kill.mode, Mode.NONE)
        self.assertEqual(self.g.state()["floor"], 0.0)          # re-armed from here

    def test_drawdown_ladder_shrinks_risk_then_locks_out(self):
        self.g.update(10000, 0)
        self.assertEqual(self.g.risk_scale(), 1.0)
        self.g.update(9850, 1)
        self.assertEqual(self.g.risk_scale(), 0.75)
        self.g.update(9690, 2)
        self.assertEqual(self.g.risk_scale(), 0.25)
        self.g.update(9490, 3)
        self.assertEqual(self.kill.reason, "drawdown_lockout")

    def test_loss_streak_cooldown_and_win_resets(self):
        for i in range(3):
            self.g.on_trade_closed(-10, 100 + i)
        self.assertFalse(self.g.entries_allowed(200)[0])
        self.assertTrue(self.g.entries_allowed(100 + self.cfg.streak_cooldown_s + 5)[0])
        self.g.on_trade_closed(-10, 1)
        self.g.on_trade_closed(+30, 2)
        self.assertEqual(self.g.state()["streak"], 0)


class RiskIntegration(unittest.TestCase):
    def setUp(self):
        self.cfg = Config.improved()
        self.broker = SimBroker(t0=T0)
        self.db = Database()
        self.bot = AdvancedBot(self.cfg, self.db, self.broker, lambda n, b: [])
        self.acct, self.spec = self.broker.account(), self.broker.spec("EURUSD")
        self.now = self.broker.now()

    def open_node(self, sym, side, root=None):
        i = self.db.add_node(level=0, state="OPEN", budget=1, planned_loss=1, symbol=sym, side=side,
                             risk_amount=5.0, root_id=root)
        return i

    def ev(self, sym="GBPCHF", side="BUY", high_conf=False, root=None, planned=50.0):
        sig = Signal(sym, side, 0.0020, self.now)
        return self.bot.risk.evaluate(planned, sig, self.spec, self.broker.quote("EURUSD"), self.acct,
                                      self.now, None, high_conf=high_conf, root_id=root)

    def test_extra_slots_only_for_high_confidence_and_capped(self):
        self.open_node("EURUSD", "BUY"); self.open_node("AUDJPY", "BUY")
        self.assertEqual(self.ev().reason, "max_open_reached")               # normal: capped at 2
        self.assertTrue(self.ev(high_conf=True).approved)                    # proven: 3rd slot
        self.open_node("NZDCAD", "BUY"); self.open_node("USDSEK", "BUY")
        self.assertEqual(self.ev(high_conf=True).reason, "max_open_reached")  # hard cap of 4

    def test_never_two_open_from_the_same_tree(self):
        self.open_node("EURUSD", "BUY", root=7)
        self.assertEqual(self.ev(root=7).reason, "same_tree_open")
        self.assertTrue(self.ev(root=8).approved)

    def test_drawdown_ladder_scales_planned_risk(self):
        self.bot.guard.update(10000, 0)
        self.bot.guard.update(9750, 1)                                       # -2.5% -> 50% risk
        d = self.ev(planned=50.0)
        self.assertTrue(d.approved)
        self.assertLessEqual(d.risk_amount, 25.0)

    def test_marginal_wins_do_not_fund_children(self):
        tree = TreeManager(self.db, self.cfg)
        rid = tree.create_root(Signal("EURUSD", "BUY", 0.002, 0), 50.0, 0)
        self.db.update_node(rid, risk_amount=50.0)
        self.assertEqual(tree.on_closed(rid, 20.0, 1), [])                   # 0.4R: below 1R
        rid2 = tree.create_root(Signal("EURUSD", "BUY", 0.002, 0), 50.0, 0)
        self.db.update_node(rid2, risk_amount=50.0)
        self.assertEqual(len(tree.on_closed(rid2, 150.0, 1)), 2)             # 3R: children


class FullRun(unittest.TestCase):
    def test_invariants_with_everything_on(self):
        cfg = Config.improved()
        broker = SimBroker(seed=5, t0=T0, trend=0.000004)
        broker.warmup(700)
        rng = random.Random(9)

        def strat(now, b):
            return [Signal("EURUSD", rng.choice(["BUY", "SELL"]), 0.002, now)] if rng.random() < 0.6 else []
        db = Database()
        bot = AdvancedBot(cfg, db, broker, strat)
        start = broker.balance
        for _ in range(700):
            bot.tick()
            op = db.nodes("OPEN", "SENDING")
            self.assertLessEqual(len(op), cfg.max_open)                       # no proven edge yet -> 2
            roots = [n["root_id"] for n in op]
            self.assertEqual(len(roots), len(set(roots)))                     # one per tree
            broker.step()
        bot.strategy = lambda now, b: []
        bot.tick()
        rejects = db.conn.execute("SELECT COUNT(*) FROM risk_decisions WHERE reason LIKE 'checklist:%'").fetchone()[0]
        self.assertGreater(rejects, 0)                                        # the checklist is filtering
        done = [n for n in db.nodes() if n["state"] in ("WON", "LOST")]
        journal = bot.journal.closed()
        self.assertEqual(len(journal), len(done))                             # every trade recorded
        self.assertAlmostEqual(sum(n["net_pnl"] for n in done), broker.balance - start, places=6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
