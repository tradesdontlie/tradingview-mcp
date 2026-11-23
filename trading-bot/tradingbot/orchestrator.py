"""Main loop: reconcile -> protect -> (maybe) trade. One call to tick() per bar."""
from .execution_engine import ExecutionEngine
from .kill_switch import KillSwitch
from .models import Mode
from .risk_manager import RiskManager
from .trade_scheduler import assign
from .tree_manager import TreeManager


class Bot:
    def __init__(self, cfg, db, broker, strategy):
        self.cfg, self.db, self.broker, self.strategy = cfg, db, broker, strategy
        db.clock = broker.now
        self.kill = KillSwitch(db)
        self.tree = TreeManager(db, cfg)
        self.risk = RiskManager(db, cfg, self.kill)
        self.exec = ExecutionEngine(db, broker, self.tree, self.kill, cfg)

    def startup(self):
        """Restart recovery: reconcile with the broker BEFORE anything else."""
        self.db.audit("bot", "startup", {"kill_mode": self.kill.mode.value})
        self.exec.reconcile(self.broker.now())

    def tick(self):
        now = self.broker.now()
        try:
            acct = self.broker.account()
        except Exception as e:
            self.kill.trigger(Mode.PAUSE, "broker_unreachable")
            self.db.audit("bot", "account_unavailable", {"err": repr(e)})
            return
        self.risk.check_account(acct, now)
        self.exec.reconcile(now)
        self.tree.expire(now)

        mode = self.kill.mode
        if mode == Mode.LIQUIDATE:
            self.broker.close_all()
            return
        if mode == Mode.FREEZE:
            self.broker.cancel_pending()
            return
        if mode == Mode.PAUSE:
            return

        signals = self.strategy(now, self.broker)
        open_nodes = self.db.nodes("OPEN", "SENDING")
        plan = assign(signals, self.tree.queued_children(), len(self.broker.positions()),
                      sum(1 for n in open_nodes if n["level"] > 0), self.cfg)
        for node, sig in plan:
            spec, quote = self.broker.spec(sig.symbol), self.broker.quote(sig.symbol)
            allocation = float(getattr(self.cfg, "allocated_capital", 0.0) or 0.0)
            risk_equity = min(acct.equity, allocation) if allocation > 0 else acct.equity
            risk_amount = float(getattr(self.cfg, "risk_per_trade_amount", 0.0) or 0.0)
            planned = node["planned_loss"] if node else (risk_amount if risk_amount > 0 else self.cfg.root_risk_pct * risk_equity)
            nid = node["node_id"] if node else None
            d = self.risk.evaluate(planned, sig, spec, quote, acct, now, nid)
            if not d.approved:
                if node and d.permanent:
                    self.db.update_node(nid, state="DUST")
                    self.db.audit("tree", "node_dust", {"node": nid, "budget": node["budget"]})
                continue
            if node is None:
                nid = self.tree.create_root(sig, d.risk_amount, now)
            self.exec.submit(nid, sig, spec, d.volume, d.risk_amount, now)
