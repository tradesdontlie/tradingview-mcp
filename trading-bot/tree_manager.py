"""Parent/child ledger. Pure bookkeeping: it never talks to the broker.

Rules (defaults from the design document):
  * A trade WINS when its net P&L (after costs) is > 0.
  * A winner spawns `children_per_win` child nodes. Each child budget =
    child_profit_frac x net_profit / children_per_win, and its planned loss =
    child_loss_frac x budget. (Default: one-sixth of profit each; risks half of that.)
  * A root win also records root_pool_frac of its profit in the root pool.
  * A loser terminates its branch and cancels its unopened descendants.
    Sibling branches are unaffected.
  * Unused child budgets expire after child_ttl_s.
"""


class TreeManager:
    def __init__(self, db, cfg):
        self.db, self.cfg = db, cfg

    def create_root(self, signal, risk_amount: float, now: float) -> int:
        return self.db.add_node(
            parent_id=None, root_id=None, level=0, state="QUEUED",
            budget=risk_amount, planned_loss=risk_amount,
            symbol=signal.symbol, side=signal.side, created_ts=now)

    def on_closed(self, node_id: int, net_pnl: float, now: float) -> list:
        """Book a finished trade exactly once. Returns the ids of any new children."""
        node = self.db.node(node_id)
        if node is None or node["state"] in ("WON", "LOST"):
            return []                                     # idempotent
        if net_pnl > 0:
            self.db.update_node(node_id, state="WON", net_pnl=net_pnl, closed_ts=now)
            kids = self._spawn_children(node, net_pnl, now)
            if node["level"] == 0 and self.cfg.root_pool_frac > 0:
                pool = float(self.db.kv_get("root_pool", 0.0)) + self.cfg.root_pool_frac * net_pnl
                self.db.kv_set("root_pool", pool)
            self.db.audit("tree", "node_won", {"node": node_id, "net": net_pnl, "children": kids})
            return kids
        self.db.update_node(node_id, state="LOST", net_pnl=net_pnl, closed_ts=now)
        cancelled = self.cancel_descendants(node_id)
        self.db.audit("tree", "node_lost", {"node": node_id, "net": net_pnl,
                                            "cancelled": cancelled})
        return []

    def _spawn_children(self, node, net_pnl, now) -> list:
        c = self.cfg
        if node["level"] + 1 > c.max_depth:
            return []
        risk = node.get("risk_amount") or 0
        if getattr(c, "child_min_win_r", 0) and risk and net_pnl < c.child_min_win_r * risk:
            return []                    # a marginal win does not fund children
        budget = c.child_profit_frac * net_pnl / c.children_per_win
        planned = c.child_loss_frac * budget
        if planned <= 0:
            return []
        return [self.db.add_node(
            parent_id=node["node_id"], root_id=node["root_id"], level=node["level"] + 1,
            state="QUEUED", budget=budget, planned_loss=planned, created_ts=now,
            expires_ts=now + c.child_ttl_s) for _ in range(c.children_per_win)]

    def cancel_descendants(self, node_id: int) -> list:
        cancelled, frontier = [], [node_id]
        while frontier:
            for child in self.db.children_of(frontier.pop()):
                if child["state"] == "QUEUED":
                    self.db.update_node(child["node_id"], state="CANCELLED")
                    cancelled.append(child["node_id"])
                frontier.append(child["node_id"])
        return cancelled

    def expire(self, now: float) -> list:
        expired = [n["node_id"] for n in self.db.nodes("QUEUED")
                   if n["expires_ts"] is not None and n["expires_ts"] < now]
        for nid in expired:
            self.db.update_node(nid, state="EXPIRED")
            self.db.audit("tree", "budget_expired", {"node": nid})
        return expired

    def queued_children(self) -> list:
        kids = [n for n in self.db.nodes("QUEUED") if n["level"] > 0]
        return sorted(kids, key=lambda n: (-n["budget"], n["created_ts"]))

    def tree_net(self, root_id: int) -> float:
        row = self.db.conn.execute(
            "SELECT COALESCE(SUM(net_pnl), 0) FROM nodes WHERE root_id=?", (root_id,)).fetchone()
        return row[0]
