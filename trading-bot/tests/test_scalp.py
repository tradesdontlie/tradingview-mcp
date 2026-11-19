import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_advanced import good_row
from tradingbot.advanced_bot import AdvancedBot
from tradingbot.broker_sim import SimBroker
from tradingbot.checklist import market_checks
from tradingbot.config import Config
from tradingbot.costs import affordability, extra_cost_price
from tradingbot.database import Database
from tradingbot.market_context import ContextCache, build_context
from tradingbot.models import Signal, SymbolSpec
from tradingbot.setups import ScannerStrategy

T0 = 1_699_999_200
EUR = SymbolSpec("EURUSD", 0.01, 0.01, 100.0, 0.00001, 1.0, 5)


def m5_broker(seed=1, bars=900, trend=0.000002):
    b = SimBroker(seed=seed, t0=T0, bar_minutes=5, trend=trend, sigma=0.0008)
    b.warmup(bars)
    return b


class Profiles(unittest.TestCase):
    def test_scalp_profile_is_one_trade_at_a_time_and_original_is_untouched(self):
        s = Config.scalp()
        self.assertEqual((s.max_open, s.reserve_root_slots, s.ctx_tf, s.ctx_htf), (1, 0, "M5", "15min"))
        self.assertFalse(s.multi_slot_enabled)
        o = Config.improved()
        self.assertEqual((o.max_open, o.ctx_tf, o.regime_gating), (2, "H1", False))
        self.assertEqual(Config().ctx_tf, "H1")


    def test_small_account_profile_is_h1_one_trade_strict_costs(self):
        c = Config.small()
        self.assertEqual((c.ctx_tf, c.max_open, c.reserve_root_slots, c.max_depth), ("H1", 1, 0, 2))
        self.assertEqual((c.ck_spread_frac, c.max_trades_per_day), (0.10, 4))
        self.assertFalse(c.multi_slot_enabled)


class M5Context(unittest.TestCase):
    def test_no_lookahead_on_m5(self):
        df = m5_broker(bars=1100).candles("EURUSD", 1100)
        full = build_context(df, "15min")
        for cut in range(700, 860, 7):
            part = build_context(df.iloc[:cut], "15min")
            for col in part.columns:
                x = part[col].astype(float).values[-12:]
                y = full[col].astype(float).values[cut - 12:cut]
                self.assertTrue(np.allclose(x, y, equal_nan=True), f"look-ahead in {col} at cut {cut}")

    def test_opening_range_window_matches_the_timeframe(self):
        for minutes, htf, first in ((5, "15min", 450), (60, "4h", 480)):
            b = SimBroker(seed=2, t0=T0, bar_minutes=minutes, trend=0.000004, sigma=0.0008)
            b.warmup(3000 if minutes == 5 else 1500)
            ctx = build_context(b.candles("EURUSD", 3000 if minutes == 5 else 1500), htf)
            mod = ctx["hour"] * 60 + ctx.index.minute
            fired = mod[ctx["orb_up"] | ctx["orb_dn"]]
            self.assertTrue(len(fired) > 0, f"no opening-range breaks at {minutes}m to test")
            self.assertTrue(((fired >= first) & (fired < 960)).all())


def row_for(**kw):
    return {**good_row(), "er": 0.5, "near_ema": False, "ts": 1_700_000_000, **kw}


class Regime(unittest.TestCase):
    cfg = Config.scalp()

    def test_trend_setups_need_a_trend_regime(self):
        self.assertTrue(market_checks(row_for(), "BUY", 0.00005, self.cfg).passed)
        res = market_checks(row_for(er=0.1), "BUY", 0.00005, self.cfg)          # ranging: er low
        self.assertIn("regime", res.failed)
        self.assertEqual(market_checks(row_for(er=0.1), "BUY", 0.00005, Config.improved()).failed, [])

    def test_sweep_and_reclaim_in_a_range_needs_no_trend_or_structure(self):
        r = row_for(er=0.1, htf=0, bos_up_recent=False, reject_buy=False, sweep_low_recent=True)
        res = market_checks(r, "BUY", 0.00005, self.cfg)
        self.assertEqual(res.trigger, "sweep")
        self.assertTrue(res.passed, res.failed)
        self.assertIn("trend", market_checks(r, "BUY", 0.00005, Config.improved()).failed)   # standard profile still strict

    def test_pullback_trigger_is_recognised(self):
        self.assertEqual(market_checks(row_for(near_ema=True), "BUY", 0.00005, self.cfg).trigger, "pullback")


class News(unittest.TestCase):
    def test_blackout_window_blocks_entries(self):
        cfg = Config.scalp(news_blackouts=("2024-01-02 09:00-09:30",))
        inside = int((pd.Timestamp("2024-01-02 09:10") - pd.Timestamp("1970-01-01")) // pd.Timedelta("1s"))
        outside = inside + 3600
        self.assertIn("news", market_checks(row_for(ts=inside), "BUY", 0.00005, cfg).failed)
        self.assertNotIn("news", market_checks(row_for(ts=outside), "BUY", 0.00005, cfg).failed)


class Costs(unittest.TestCase):
    def test_small_balance_cannot_afford_a_standard_lot_size_but_a_bigger_one_can(self):
        cfg = Config.scalp()
        a = affordability(EUR, 10.0, cfg, 0.0005)                 # 5-pip stop: smallest trade risks 0.50
        self.assertFalse(a["ok"])
        self.assertAlmostEqual(a["min_risk"], 0.50)
        self.assertAlmostEqual(a["needs_equity"], 50.0)
        self.assertTrue(affordability(EUR, 100.0, cfg, 0.0002)["ok"])

    def test_cent_accounts_work_unchanged_because_everything_is_in_account_currency(self):
        cfg = Config.scalp()
        usd = affordability(EUR, 10.0, cfg, 0.0005)
        cent = affordability(SymbolSpec("EURUSD", 0.01, 0.01, 100.0, 0.00001, 100.0, 5), 1000.0, cfg, 0.0005)
        self.assertEqual(usd["ok"], cent["ok"])
        self.assertAlmostEqual(cent["needs_equity"], usd["needs_equity"] * 100)

    def test_commission_and_slippage_become_price_units(self):
        cfg = Config.scalp(commission_per_lot=7.0, slippage_price=0.00002)
        self.assertAlmostEqual(extra_cost_price(EUR, cfg), 7.0 / 100000 + 0.00002)
        self.assertEqual(extra_cost_price(EUR, Config.scalp()), 0.0)

    def test_large_all_in_cost_blocks_the_trade(self):
        cfg = Config.scalp()
        self.assertTrue(market_checks(row_for(), "BUY", 0.00002, cfg).passed)
        self.assertIn("spread_stop", market_checks(row_for(), "BUY", 0.0008, cfg).failed)


class Cap(unittest.TestCase):
    def test_daily_trade_cap(self):
        broker = SimBroker(t0=T0)
        db = Database()
        bot = AdvancedBot(Config.scalp(max_trades_per_day=2), db, broker, lambda n, b: [])
        now = broker.now()
        for _ in range(2):
            db.add_node(level=0, state="WON", budget=1, planned_loss=1, sent_ts=now - 60, net_pnl=1.0)
        sig = Signal("EURUSD", "BUY", 0.0020, now)
        d = bot.risk.evaluate(50.0, sig, broker.spec("EURUSD"), broker.quote("EURUSD"), broker.account(), now)
        self.assertEqual(d.reason, "daily_trade_cap")


class ScalpRun(unittest.TestCase):
    def test_full_scalp_run_keeps_every_invariant(self):
        cfg = Config.scalp()
        broker = m5_broker(seed=4, bars=700)
        db = Database()
        cache = ContextCache(tf=cfg.ctx_tf, htf=cfg.ctx_htf)
        bot = AdvancedBot(cfg, db, broker, ScannerStrategy(cfg, ["EURUSD"], cache), cache)
        start = broker.balance
        for _ in range(500):
            bot.tick()
            self.assertLessEqual(len(db.nodes("OPEN", "SENDING")), 1)         # one position at a time
            broker.step()
        bot.strategy = lambda now, b: []
        bot.tick()
        done = [n for n in db.nodes() if n["state"] in ("WON", "LOST")]
        self.assertAlmostEqual(sum(n["net_pnl"] for n in done), broker.balance - start, places=6)
        self.assertEqual(len(bot.journal.closed()), len(done))
        self.assertGreater(db.conn.execute("SELECT COUNT(*) FROM risk_decisions").fetchone()[0] + len(done), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
