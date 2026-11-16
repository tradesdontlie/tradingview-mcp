"""AdvancedBot: the original Bot plus checklist, journal, equity guard and multi-slot logic.
The original Bot is untouched; this class only adds steps around the same components."""
from dataclasses import replace

from .checklist import market_checks
from .equity_guard import EquityGuard
from .execution_engine import ExecutionEngine
from .journal import Journal
from .kill_switch import KillSwitch
from .market_context import ContextCache, session_name
from .models import Mode
from .orchestrator import Bot
from .risk_manager import RiskManager
from .trade_scheduler import assign
from .tree_manager import TreeManager


class JournalingTreeManager(TreeManager):
    """Same ledger, but every finished trade is journaled and fed to the equity guard."""

    def __init__(self, db, cfg, journal=None, guard=None):
        super().__init__(db, cfg)
        self.journal, self.guard = journal, guard

    def on_closed(self, node_id, net_pnl, now):
        node = self.db.node(node_id)
        fresh = node is not None and node["state"] not in ("WON", "LOST")
        kids = super().on_closed(node_id, net_pnl, now)
        if fresh:
            if self.journal:
                self.journal.record_exit(node_id, now, net_pnl)
            if self.guard:
                self.guard.on_trade_closed(net_pnl, now)
        return kids


class AdvancedBot(Bot):
    def __init__(self, cfg, db, broker, strategy, ctx_cache=None):
        self.cfg, self.db, self.broker, self.strategy = cfg, db, broker, strategy
        db.clock = broker.now
        self.kill = KillSwitch(db)
        self.guard = EquityGuard(db, cfg, self.kill) if cfg.equity_guard_enabled else None
        self.journal = Journal(db, cfg) if cfg.journal_enabled else None
        self.risk = RiskManager(db, cfg, self.kill, guard=self.guard)
        self.tree = JournalingTreeManager(db, cfg, self.journal, self.guard)
        self.exec = ExecutionEngine(db, broker, self.tree, self.kill, cfg)
        self.cache = ctx_cache or ContextCache()

    def tick(self):
        now, cfg, db = self.broker.now(), self.cfg, self.db
        try:
            acct = self.broker.account()
        except Exception as e:
            self.kill.trigger(Mode.PAUSE, "broker_unreachable")
            db.audit("bot", "account_unavailable", {"err": repr(e)})
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
        open_nodes = db.nodes("OPEN", "SENDING")
        plan = assign(signals, self.tree.queued_children(), len(self.broker.positions()),
                      sum(1 for n in open_nodes if n["level"] > 0), cfg)
        blocked = self.journal.blocked_buckets() if self.journal else set()

        for node, sig in plan:
            nid = node["node_id"] if node else None
            spec, quote = self.broker.spec(sig.symbol), self.broker.quote(sig.symbol)
            spread = quote[1] - quote[0]
            row = result = est = None
            setup, high_conf = sig.strategy, False

            if cfg.checklist_enabled:
                ctx = self.cache.get(self.broker, sig.symbol)
                if ctx is None:
                    db.decision(nid, False, "checklist:no_history", 0, 0)
                    continue
                row = ctx.iloc[-1].to_dict()
                result = market_checks(row, sig.side, spread, cfg)
                if not result.passed:
                    db.decision(nid, False, "checklist:" + ",".join(result.failed), 0, 0)
                    continue
                setup = result.trigger
                hit = {f"setup:{setup}", f"session:{session_name(int(row['hour']))}",
                       f"pair:{sig.symbol}"} & blocked
                if hit:
                    db.decision(nid, False, "journal_blocked:" + ",".join(sorted(hit)), 0, 0)
                    continue
                sig = replace(sig, stop_distance=result.stop)
                if cfg.multi_slot_enabled and self.journal:
                    est = self.journal.win_prob_lcb(setup, cfg.extra_slot_min_trades)
                    high_conf = est is not None and est >= cfg.extra_slot_min_prob

            planned = node["planned_loss"] if node else cfg.root_risk_pct * acct.equity
            d = self.risk.evaluate(planned, sig, spec, quote, acct, now, nid, high_conf=high_conf,
                                   root_id=node["root_id"] if node else None)
            if not d.approved:
                if node and d.permanent:
                    db.update_node(nid, state="DUST")
                    db.audit("tree", "node_dust", {"node": nid, "budget": node["budget"]})
                continue
            if node is None:
                nid = self.tree.create_root(sig, d.risk_amount, now)
            self.exec.submit(nid, sig, spec, d.volume, d.risk_amount, now)
            placed = db.node(nid)
            if self.journal and result is not None and placed["state"] in ("OPEN", "SENDING"):
                self.journal.record_entry(nid, now, sig, placed["level"], placed["root_id"], setup,
                                          row, result, est, high_conf, d.risk_amount, cfg.rr, spread)
