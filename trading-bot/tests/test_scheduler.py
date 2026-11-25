import unittest

from tradingbot.config import Config
from tradingbot.database import Database
from tradingbot.models import Signal
from tradingbot.trade_scheduler import assign


class CandidateAwareScheduler(unittest.TestCase):
    def setUp(self):
        self.cfg = Config.improved(merge_small_children=True, dust_use_full_budget=True)
        self.db = Database()
        self.parent = self.db.add_node(level=0, state="WON", budget=100, planned_loss=100)
        self.root = self.parent

    def child(self, budget, planned):
        nid = self.db.add_node(
            parent_id=self.parent, root_id=self.root, level=1,
            state="QUEUED", budget=budget, planned_loss=planned,
            created_ts=1,
        )
        return self.db.node(nid)

    def signal(self, symbol="GBPUSD"):
        return Signal(symbol, "BUY", 0.001, 10, quality_score=80, root_id=self.root)

    def test_uses_actual_candidate_minimum_risk(self):
        small = self.child(10, 5)
        large = self.child(30, 15)
        plan = assign(
            [self.signal()], [small, large], 0, 0, self.cfg,
            min_risk_fn=lambda sig: 12, db=self.db,
        )
        self.assertEqual(plan[0][0]["node_id"], large["node_id"])
        self.assertEqual(self.db.node(small["node_id"])["state"], "QUEUED")

    def test_merges_only_siblings_when_combined_budget_is_enough(self):
        first = self.child(10, 5)
        second = self.child(12, 6)
        plan = assign(
            [self.signal()], [first, second], 0, 0, self.cfg,
            min_risk_fn=lambda sig: 18, db=self.db,
        )
        self.assertEqual(plan[0][0]["budget"], 22)
        self.assertEqual(plan[0][0]["planned_loss"], 18)
        self.assertEqual(self.db.node(second["node_id"])["state"], "MERGED")

    def test_unlinked_signal_does_not_consume_existing_child(self):
        child = self.child(30, 15)
        plan = assign(
            [Signal("GBPUSD", "BUY", 0.001, 10)],
            [child], 0, 0, self.cfg,
            min_risk_fn=lambda sig: 12, db=self.db,
        )
        self.assertIsNone(plan[0][0])
        self.assertEqual(self.db.node(child["node_id"])["state"], "QUEUED")

    def test_does_not_assign_unaffordable_child(self):
        child = self.child(10, 5)
        plan = assign(
            [self.signal()], [child], 0, 0, self.cfg,
            min_risk_fn=lambda sig: 20, db=self.db,
        )
        self.assertIsNone(plan[0][0])
        self.assertEqual(self.db.node(child["node_id"])["state"], "QUEUED")


if __name__ == "__main__":
    unittest.main()
