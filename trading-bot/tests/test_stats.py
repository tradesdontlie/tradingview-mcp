import math
import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import portfolio_research as pr
from tradingbot.stats import dsr, expected_max_sharpe, max_drawdown, psr, sharpe


class Stats(unittest.TestCase):
    def test_psr_is_half_when_sharpe_equals_benchmark(self):
        r = np.random.default_rng(1).normal(0, 0.01, 1000)
        r = r - r.mean()                                   # exactly zero Sharpe
        self.assertAlmostEqual(psr(r, 0.0), 0.5, places=6)

    def test_more_trials_raise_the_bar(self):
        r = np.random.default_rng(2).normal(0.0006, 0.01, 2500)
        self.assertGreater(dsr(r, 2), dsr(r, 200))
        self.assertGreater(expected_max_sharpe(200, 0.0004), expected_max_sharpe(2, 0.0004))

    def test_max_drawdown_known_answer(self):
        self.assertAlmostEqual(max_drawdown([0.10, -0.50, 0.10]), -0.5)

    def test_sharpe_sign(self):
        self.assertGreater(sharpe(np.random.default_rng(3).normal(0.001, 0.01, 1000)), 0)


class Engine(unittest.TestCase):
    def setUp(self):
        idx = pd.bdate_range("2010-01-01", periods=2000)
        r = np.random.default_rng(0).normal(0.0008, 0.006, (len(idx), 3))
        self.prices = pd.DataFrame(100 * np.exp(np.cumsum(r, axis=0)), index=idx,
                                   columns=["EURUSD", "GBPUSD", "XAUUSD"])
        self.rets = self.prices.pct_change(fill_method=None)
        self.zero = pd.Series(0.0, index=self.prices.columns)
        self.long = pd.DataFrame(1.0, index=idx, columns=self.prices.columns)

    def run_w(self, w, spreads=None):
        return pr.run_weights(w, self.rets, self.prices, 0.10, 6.0, 5, 1.0,
                              self.zero if spreads is None else spreads)

    def test_volatility_target_is_hit(self):
        vol = self.run_w(self.long).std() * math.sqrt(252)
        self.assertTrue(0.08 < vol < 0.12)

    def test_zero_weights_make_nothing(self):
        self.assertEqual(float(self.run_w(self.long * 0).abs().sum()), 0.0)

    def test_costs_reduce_returns(self):
        big = pd.Series(1.0, index=self.prices.columns)
        self.assertLess(sharpe(self.run_w(self.long, big)), sharpe(self.run_w(self.long)))

    def test_random_walk_markets_are_rejected(self):
        for seed in (1, 2, 3):
            prices = pr.synthetic_universe("random", seed=seed)
            rets = prices.pct_change(fill_method=None)
            sp = pd.Series({s: pr.COSTS.get(s, prices[s].mean() * 2e-4) for s in prices.columns})
            w = pr.tsmom_weights(prices, [21, 63, 252])
            n1 = pr.run_weights(w, rets, prices, 0.10, 6.0, 5, 1.0, sp)
            n2 = pr.run_weights(w, rets, prices, 0.10, 6.0, 5, 2.0, sp)
            self.assertFalse(pr.evaluate("x", n1, n2, 20, None)["pass"])

    def test_real_trends_are_found(self):
        prices = pr.synthetic_universe("trend", seed=3)
        rets = prices.pct_change(fill_method=None)
        sp = pd.Series({s: pr.COSTS.get(s, prices[s].mean() * 2e-4) for s in prices.columns})
        w = pr.tsmom_weights(prices, [21, 63, 252])
        n1 = pr.run_weights(w, rets, prices, 0.10, 6.0, 5, 1.0, sp)
        n2 = pr.run_weights(w, rets, prices, 0.10, 6.0, 5, 2.0, sp)
        self.assertTrue(pr.evaluate("x", n1, n2, 20, None)["pass"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
