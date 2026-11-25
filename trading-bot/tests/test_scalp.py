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
from tradingbot.checklist import market_checks, multi_timeframe_checks
from tradingbot.config import Config
from tradingbot.costs import affordability, extra_cost_price
from tradingbot.database import Database
from tradingbot.market_context import (
    ContextCache, MultiTimeframeContextCache, build_context,
    directional_room_levels,
)
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
        self.assertFalse(s.one_open_per_symbol)
        o = Config.improved()
        self.assertEqual((o.max_open, o.ctx_tf, o.regime_gating), (2, "H1", False))
        self.assertEqual(Config().ctx_tf, "H1")


    def test_small_account_profile_is_h1_one_trade_strict_costs(self):
        c = Config.small()
        self.assertEqual((c.ctx_tf, c.max_open, c.reserve_root_slots, c.max_depth), ("H1", 1, 0, 2))
        self.assertEqual((c.ck_spread_frac, c.max_trades_per_day), (0.10, 4))
        self.assertFalse(c.multi_slot_enabled)


class M5Context(unittest.TestCase):
    def test_context_cache_fetches_each_symbol_once_per_cycle(self):
        broker = m5_broker(bars=700)
        cache = ContextCache(tf="M5", htf="15min")
        original = broker.candles
        calls = []

        def counted_candles(symbol, n, tf="H1"):
            calls.append((symbol, tf))
            return original(symbol, n, tf)

        broker.candles = counted_candles

        cache.begin_cycle()
        first = cache.get(broker, "EURUSD")
        second = cache.get(broker, "EURUSD")

        self.assertIsNotNone(first)
        self.assertIs(first, second)
        self.assertEqual(calls, [("EURUSD", "M5")])

        cache.get(broker, "GBPUSD")
        self.assertEqual(calls.count(("GBPUSD", "M5")), 1)

        # A fresh analysis cycle before the next completed bar reuses context.
        cache.begin_cycle()
        cache.get(broker, "EURUSD")
        self.assertEqual(calls.count(("EURUSD", "M5")), 1)

        # Advancing the simulator creates the next completed M5 candle.
        broker.step()
        cache.begin_cycle()
        cache.get(broker, "EURUSD")
        self.assertEqual(calls.count(("EURUSD", "M5")), 2)

    def test_context_cache_refreshes_on_new_m15_bar(self):
        broker = SimBroker(seed=3, t0=T0, bar_minutes=15, trend=0.000002)
        broker.warmup(700)
        cache = ContextCache(tf="M15", htf="1h")
        original = broker.candles
        calls = []

        def counted_candles(symbol, n, tf="H1"):
            calls.append((symbol, tf))
            return original(symbol, n, tf)

        broker.candles = counted_candles
        cache.begin_cycle()
        first = cache.get(broker, "EURUSD")
        self.assertIsNotNone(first)
        self.assertEqual(len(calls), 1)

        cache.begin_cycle()
        cache.get(broker, "EURUSD")
        self.assertEqual(len(calls), 1)

        broker.step()
        cache.begin_cycle()
        cache.get(broker, "EURUSD")
        self.assertEqual(len(calls), 2)

    def test_context_cache_retries_delayed_candle_after_15_seconds(self):
        broker = m5_broker(bars=700)
        clock = [broker.now()]
        original = broker.candles
        calls = []

        def counted_candles(symbol, n, tf="H1"):
            calls.append(symbol)
            return original(symbol, n, tf)

        broker.candles = counted_candles
        broker.now = lambda: clock[0]
        cache = ContextCache(tf="M5", htf="15min", retry_seconds=15)

        cache.begin_cycle()
        first = cache.get(broker, "EURUSD")
        self.assertIsNotNone(first)
        self.assertEqual(len(calls), 1)

        last_bar = original("EURUSD", 450, "M5").index[-1]
        clock[0] = int(last_bar.timestamp()) + 600
        cache.begin_cycle()
        cache.get(broker, "EURUSD")
        self.assertEqual(len(calls), 2)

        clock[0] += 10
        cache.begin_cycle()
        cache.get(broker, "EURUSD")
        self.assertEqual(len(calls), 2)

        clock[0] += 6
        cache.begin_cycle()
        cache.get(broker, "EURUSD")
        self.assertEqual(len(calls), 3)

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


class MultiTimeframeSimulation(unittest.TestCase):
    def test_m1_simulator_aggregates_completed_timeframes(self):
        import pandas as pd

        broker = SimBroker(seed=7, bar_minutes=1)
        broker.warmup(8000)

        expected = {"M1": 1, "M5": 5, "M15": 15, "H1": 60}
        for tf, minutes in expected.items():
            with self.subTest(timeframe=tf):
                df = broker.candles("EURUSD", 500, tf)
                self.assertGreater(len(df), 0)
                self.assertTrue(
                    (df.index.to_series().diff().dropna()
                     == pd.Timedelta(minutes=minutes)).all()
                )
                self.assertLessEqual(
                    df.index[-1] + pd.Timedelta(minutes=minutes),
                    pd.to_datetime(broker.t, unit="s"),
                )

    def test_higher_timeframe_ohlc_aggregation(self):
        broker = SimBroker(seed=11, bar_minutes=1)
        broker.warmup(1200)

        m1 = broker.candles("EURUSD", 1200, "M1")
        m5 = broker.candles("EURUSD", 240, "M5")
        first = m1.loc[
            (m1.index >= m5.index[0])
            & (m1.index < m5.index[0] + pd.Timedelta(minutes=5))
        ]

        self.assertEqual(m5.iloc[0]["open"], first.iloc[0]["open"])
        self.assertEqual(m5.iloc[0]["high"], first["high"].max())
        self.assertEqual(m5.iloc[0]["low"], first["low"].min())
        self.assertEqual(m5.iloc[0]["close"], first.iloc[-1]["close"])


class MultiTimeframeCacheTests(unittest.TestCase):
    def test_fetches_and_returns_four_independent_contexts(self):
        class FakeBroker:
            def __init__(self):
                self.calls = []
                self.frames = {}
                self.clock = int(pd.Timestamp("2024-01-20").timestamp())
                for tf, freq, seconds in (
                    ("M1", "1min", 60), ("M5", "5min", 300),
                    ("M15", "15min", 900), ("H1", "1h", 3600),
                ):
                    end = pd.to_datetime(self.clock - seconds, unit="s")
                    idx = pd.date_range(end=end, periods=450, freq=freq)
                    close = 1.1 + np.arange(450) * 0.00001
                    self.frames[tf] = pd.DataFrame({
                        "open": close - 0.00001,
                        "high": close + 0.00005,
                        "low": close - 0.00005,
                        "close": close,
                    }, index=idx)

            def now(self):
                return self.clock

            def candles(self, symbol, n, tf="H1"):
                self.calls.append((symbol, tf))
                return self.frames[tf].tail(n)

        broker = FakeBroker()
        cache = MultiTimeframeContextCache()
        cache.begin_cycle()
        result = cache.get(broker, "EURUSD")

        self.assertIsNotNone(result)
        self.assertEqual(set(result), {"M1", "M5", "M15", "H1"})
        self.assertTrue(all(len(ctx) >= 260 for ctx in result.values()))
        self.assertEqual(
            broker.calls,
            [("EURUSD", "M1"), ("EURUSD", "M5"),
             ("EURUSD", "M15"), ("EURUSD", "H1")],
        )

        cache.begin_cycle()
        again = cache.get(broker, "EURUSD")
        self.assertIs(again["M1"], result["M1"])
        self.assertEqual(len(broker.calls), 4)

        broker.clock += 3 * 3600
        cache.begin_cycle()
        self.assertIsNone(cache.get(broker, "EURUSD"))


class MultiTimeframeChecklistTests(unittest.TestCase):
    def contexts(self, h1=1, m15=1, m1=1, bullish=True):
        m5 = row_for(htf=1, er=0.5)
        m1_open = 1.1000
        m1_close = 1.1002 if bullish else 1.0998
        return {
            "M1": pd.DataFrame([{
                "direction": m1,
                "open": m1_open,
                "close": m1_close,
            }]),
            "M5": pd.DataFrame([m5]),
            "M15": pd.DataFrame([{"direction": m15, "er": 0.5}]),
            "H1": pd.DataFrame([{"direction": h1}]),
        }

    def test_aligned_four_timeframe_buy_passes(self):
        row, result = multi_timeframe_checks(
            self.contexts(), "BUY", 0.00005, Config.scalp()
        )
        self.assertIsNotNone(row)
        self.assertTrue(result.passed, result.failed)

    def test_bearish_m1_candle_blocks_buy(self):
        _, result = multi_timeframe_checks(
            self.contexts(bullish=False), "BUY", 0.00005, Config.scalp()
        )
        self.assertIn("m1_confirmation", result.failed)

    def test_opposing_m15_direction_blocks_buy(self):
        _, result = multi_timeframe_checks(
            self.contexts(m15=-1), "BUY", 0.00005, Config.scalp()
        )
        self.assertIn("m15_direction", result.failed)

    def test_opposing_h1_bias_blocks_buy(self):
        _, result = multi_timeframe_checks(
            self.contexts(h1=-1), "BUY", 0.00005, Config.scalp()
        )
        self.assertIn("trend", result.failed)

    def test_missing_timeframe_context_blocks_entry(self):
        contexts = self.contexts()
        del contexts["H1"]
        row, result = multi_timeframe_checks(
            contexts, "BUY", 0.00005, Config.scalp()
        )
        self.assertIsNone(row)
        self.assertIn("timeframes", result.failed)


class DirectionalRoomLevels(unittest.TestCase):
    def test_selects_nearest_confirmed_levels(self):
        resistance, support = directional_room_levels(
            [10, 11, 9, 12],
            [12, 13, 11, 14],
            [8, 9, 7, 10],
        )
        np.testing.assert_allclose(resistance, [12, 12, 11, 13])
        np.testing.assert_allclose(support, [8, 9, 8, 9])

    def test_ignores_levels_behind_price(self):
        resistance, support = directional_room_levels(
            [10, 11, 12], [10, 11, 14], [13, 12, 8]
        )
        self.assertEqual(resistance[-1], 14)
        self.assertEqual(support[-1], 8)

    def test_broken_resistance_stays_invalid_after_retrace(self):
        resistance, _ = directional_room_levels(
            [10, 13, 11], [12, np.nan, np.nan],
            [8, np.nan, np.nan],
        )
        self.assertTrue(np.isnan(resistance[-1]))

    def test_broken_support_stays_invalid_after_retrace(self):
        _, support = directional_room_levels(
            [10, 7, 9], [12, np.nan, np.nan],
            [8, np.nan, np.nan],
        )
        self.assertTrue(np.isnan(support[-1]))

    def test_missing_levels_remain_nan(self):
        resistance, support = directional_room_levels(
            [12, 12], [10, 11], [13, 14]
        )
        self.assertTrue(np.isnan(resistance[-1]))
        self.assertTrue(np.isnan(support[-1]))



class RoomFilter(unittest.TestCase):
    def test_buy_uses_room_level_when_latest_swing_is_broken(self):
        cfg = Config.scalp()
        row = row_for(swing_high=1.0990)
        stop = min(
            max((row["close"] - row["low5"]) + 0.2 * row["atr"],
                cfg.ck_stop_atr_lo * row["atr"]),
            cfg.ck_stop_atr_hi * row["atr"],
        )
        row["room_high"] = row["close"] + 3 * stop
        result = market_checks(row, "BUY", 0.00005, cfg)
        self.assertNotIn("room", result.failed)

    def test_missing_room_level_fails_safe(self):
        row = row_for(room_high=float("nan"))
        result = market_checks(row, "BUY", 0.00005, Config.scalp())
        self.assertIn("room", result.failed)

    def test_buy_rejects_opposing_swing_at_or_below_entry(self):
        row = row_for(swing_high=1.0999)
        result = market_checks(row, "BUY", 0.00005, Config.scalp())
        self.assertIn("room", result.failed)

    def test_sell_rejects_opposing_swing_at_or_above_entry(self):
        row = row_for(swing_low=1.1001)
        result = market_checks(row, "SELL", 0.00005, Config.scalp())
        self.assertIn("room", result.failed)

    def test_scalp_requires_room_for_its_actual_two_r_target(self):
        cfg = Config.scalp()
        row = row_for()
        stop = min(
            max((row["close"] - row["low5"]) + 0.2 * row["atr"],
                cfg.ck_stop_atr_lo * row["atr"]),
            cfg.ck_stop_atr_hi * row["atr"],
        )
        row["swing_high"] = row["close"] + 1.8 * stop
        result = market_checks(row, "BUY", 0.00005, cfg)
        self.assertIn("room", result.failed)

    def test_improved_profile_requires_room_for_three_r_target(self):
        cfg = Config.improved()
        row = row_for()
        stop = min(
            max((row["close"] - row["low5"]) + 0.2 * row["atr"],
                cfg.ck_stop_atr_lo * row["atr"]),
            cfg.ck_stop_atr_hi * row["atr"],
        )
        row["swing_high"] = row["close"] + 2.5 * stop
        result = market_checks(row, "BUY", 0.00005, cfg)
        self.assertIn("room", result.failed)


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
    def test_daily_trade_count_does_not_block_valid_entry(self):
        broker = SimBroker(t0=T0)
        db = Database()
        bot = AdvancedBot(Config.scalp(max_trades_per_day=2), db, broker, lambda n, b: [])
        now = broker.now()
        for _ in range(2):
            db.add_node(level=0, state="WON", budget=1, planned_loss=1, sent_ts=now - 60, net_pnl=1.0)
        sig = Signal("EURUSD", "BUY", 0.0020, now)
        d = bot.risk.evaluate(50.0, sig, broker.spec("EURUSD"), broker.quote("EURUSD"), broker.account(), now)
        self.assertTrue(d.approved)


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
            open_nodes = db.nodes("OPEN", "SENDING")
            open_risk = sum(float(n["risk_amount"] or 0) for n in open_nodes)
            # Use initial balance as a stable simulation reference.
            # Newly opened positions immediately include spread in floating P&L,
            # which can slightly reduce marked equity after risk approval.
            risk_equity = cfg.allocated_capital or start
            self.assertLessEqual(
                open_risk,
                cfg.max_open_risk_pct * risk_equity + 1e-6,
            )
            broker.step()
        bot.strategy = lambda now, b: []
        bot.tick()
        done = [n for n in db.nodes() if n["state"] in ("WON", "LOST")]
        self.assertAlmostEqual(sum(n["net_pnl"] for n in done), broker.balance - start, places=6)
        self.assertEqual(len(bot.journal.closed()), len(done))
        self.assertGreaterEqual(db.conn.execute("SELECT COUNT(*) FROM risk_decisions").fetchone()[0], len(done))


class GoldSimulator(unittest.TestCase):
    def test_floating_net_pnl_uses_close_price_and_commission_once(self):
        broker = SimBroker(seed=1, commission_per_lot=7.0)
        pos = broker.send_market("floating-test", "EURUSD", "BUY", 0.10, 1.09, 1.12)
        broker.mid["EURUSD"] += 0.001
        self.assertAlmostEqual(broker.floating_net_pnl(pos), 8.3, places=6)

    def test_floating_net_pnl_requires_connection(self):
        broker = SimBroker(seed=1)
        pos = broker.send_market("floating-test", "EURUSD", "BUY", 0.10, 1.09, 1.12)
        broker.shutdown()
        with self.assertRaises(ConnectionError):
            broker.floating_net_pnl(pos)

    def test_gold_uses_price_unit_spread(self):
        broker = SimBroker(seed=1)
        bid, ask = broker.quote("XAUUSD")
        self.assertAlmostEqual(ask - bid, 0.30)
        self.assertEqual(broker.spec("XAUUSD").tick_size, 0.01)

    def test_gold_volatility_can_be_disabled_independently(self):
        broker = SimBroker(seed=7, sigma_by_symbol={"XAUUSD": 0.0})
        start = broker.mid["XAUUSD"]
        broker.step()
        self.assertEqual(broker.mid["XAUUSD"], start)

    def test_gold_pnl_uses_its_tick_value_and_volume(self):
        broker = SimBroker(seed=1, commission_per_lot=0.0)
        pos = broker.send_market("gold-test", "XAUUSD", "BUY", 0.01, 1990, 2010)
        broker.mid["XAUUSD"] += 0.40
        broker.close_position(pos.ticket)
        self.assertAlmostEqual(broker.balance, 10000.10, places=6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
