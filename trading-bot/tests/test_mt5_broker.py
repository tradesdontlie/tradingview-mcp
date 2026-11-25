import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tradingbot.broker_mt5 import MT5Broker, MAGIC
from tradingbot.config import Config
from tradingbot.models import Position


class FakeMT5(types.ModuleType):
    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_MARGIN_MODE_RETAIL_HEDGING = 2
    DEAL_ENTRY_IN = 0
    DEAL_ENTRY_OUT = 1
    RES_S_OK = 1

    def __init__(self):
        super().__init__("MetaTrader5")
        self.raw = SimpleNamespace(
            ticket=123, identifier=456, magic=MAGIC, comment="tm123",
            symbol="EURUSD", volume=0.10, profit=5.0, swap=0.20,
        )
        self.trade_mode = 0
        self.deals = [
            SimpleNamespace(entry=0, commission=-0.35, fee=0.0),
        ]

    def initialize(self):
        return True

    def account_info(self):
        return SimpleNamespace(
            trade_mode=self.trade_mode, balance=1000.0, equity=1000.0,
            margin_free=900.0, margin_mode=2, currency="USD",
        )

    def positions_get(self, ticket=None):
        return [self.raw] if ticket == 123 else []

    def history_deals_get(self, position=None):
        return self.deals

    def symbol_select(self, symbol, enabled):
        return True

    def symbol_info(self, symbol):
        return SimpleNamespace(
            volume_min=0.01, volume_step=0.01, volume_max=100.0,
            trade_tick_size=0.00001, trade_tick_value_loss=1.0,
            trade_tick_value=1.0, digits=5, trade_stops_level=0,
            point=0.00001,
        )


class MT5FloatingPnLTests(unittest.TestCase):
    def setUp(self):
        self.mt5 = FakeMT5()
        self.patch = patch.dict(sys.modules, {"MetaTrader5": self.mt5})
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.position = Position(
            123, "tm123", "EURUSD", "BUY", 0.10, 1.1, 1.09, 1.12, 1000
        )

    def test_account_allows_demo_mode(self):
        broker = MT5Broker(cfg=Config())
        self.assertTrue(broker.account().is_demo)

    def test_account_rejects_switch_to_real_mode(self):
        broker = MT5Broker(cfg=Config())
        self.mt5.trade_mode = 1
        with self.assertRaisesRegex(ConnectionError, "DEMO account requirement"):
            broker.account()

    def test_demo_broker_activates_risk_cap(self):
        cfg = Config()
        MT5Broker(cfg=cfg)
        self.assertEqual(cfg.demo_risk_cap_pct, 0.001)

    def test_demo_broker_preserves_stricter_cap(self):
        cfg = Config(demo_risk_cap_pct=0.0005)
        MT5Broker(cfg=cfg)
        self.assertEqual(cfg.demo_risk_cap_pct, 0.0005)

    def test_non_demo_broker_does_not_activate_demo_cap(self):
        cfg = Config()
        MT5Broker(require_demo=False, cfg=cfg)
        self.assertEqual(cfg.demo_risk_cap_pct, 0.0)

    def test_net_pnl_deducts_entry_and_remaining_costs(self):
        cfg = Config(commission_per_lot=7.0, slippage_price=0.00002)
        broker = MT5Broker(cfg=cfg)
        # 5.00 profit + 0.20 swap - 0.35 entry cost
        # - 0.35 remaining commission - 0.20 slippage.
        self.assertAlmostEqual(
            broker.floating_net_pnl(self.position), 4.30, places=6
        )

    def test_missing_history_fails_closed(self):
        broker = MT5Broker(cfg=Config(commission_per_lot=7.0))
        self.mt5.deals = None
        self.assertIsNone(broker.floating_net_pnl(self.position))

    def test_unconfigured_commission_fails_closed(self):
        broker = MT5Broker(cfg=Config())
        self.assertIsNone(broker.floating_net_pnl(self.position))

    def test_non_treebot_position_fails_closed(self):
        broker = MT5Broker(cfg=Config(commission_per_lot=7.0))
        self.mt5.raw.magic = 999
        self.assertIsNone(broker.floating_net_pnl(self.position))

    def test_position_with_exit_deal_fails_closed(self):
        broker = MT5Broker(cfg=Config(commission_per_lot=7.0))
        self.mt5.deals.append(
            SimpleNamespace(entry=1, commission=0.0, fee=0.0)
        )
        self.assertIsNone(broker.floating_net_pnl(self.position))


if __name__ == "__main__":
    unittest.main()
