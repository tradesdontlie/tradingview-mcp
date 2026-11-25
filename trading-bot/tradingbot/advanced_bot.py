"""AdvancedBot: the original Bot plus checklist, journal, equity guard and multi-slot logic.
The original Bot is untouched; this class only adds steps around the same components."""
from dataclasses import replace
import math

from .checklist import market_checks, multi_timeframe_checks
from .costs import extra_cost_price
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
        self.cache = ctx_cache or ContextCache(tf=cfg.ctx_tf, htf=cfg.ctx_htf)

    def _min_risk_for_signal(self, sig):
        """Actual minimum-lot risk for this candidate signal and its broker symbol."""
        try:
            spec = self.broker.spec(sig.symbol)
            loss_per_lot = sig.stop_distance / spec.tick_size * spec.tick_value
            return spec.volume_min * loss_per_lot
        except Exception:
            return None

    def _same_symbol_pyramid_check(self, sig, acct, contexts, now):
        """Allow only verified, profitable same-direction TreeBot add-ons."""
        nodes = [
            n for n in self.db.nodes("OPEN", "SENDING")
            if n["symbol"] == sig.symbol
        ]
        if not nodes:
            try:
                live = [
                    p for p in self.broker.positions()
                    if p.symbol == sig.symbol
                ]
            except Exception:
                return False, "pyramiding_positions_unavailable", True
            if live:
                return False, "pyramiding_untracked_position", True
            return False, "", False

        def reject(reason):
            return False, reason, True

        cfg = self.cfg
        if not getattr(cfg, "pyramiding_enabled", False):
            return reject("pyramiding_disabled")
        if not acct.hedging:
            return reject("pyramiding_requires_hedging")
        if any(n["state"] != "OPEN" for n in nodes):
            return reject("pyramiding_position_pending")
        if now - sig.created_at < 0 or now - sig.created_at > cfg.signal_max_age_s:
            return reject("pyramiding_stale_signal")

        if not isinstance(contexts, dict) or not {"M1", "M5"}.issubset(contexts):
            return reject("pyramiding_missing_m1_m5")

        try:
            m1, m5 = contexts["M1"], contexts["M5"]
            if len(m1) < 1 or len(m5) < 2:
                return reject("pyramiding_insufficient_candles")

            m1row = m1.iloc[-1]
            latest, previous = m5.iloc[-1], m5.iloc[-2]
            direction = 1 if sig.side == "BUY" else -1

            m1_open, m1_close = float(m1row["open"]), float(m1row["close"])
            m1_direction = int(m1row["direction"])
            m1_ok = (
                m1_direction == direction
                and (m1_close > m1_open if direction == 1 else m1_close < m1_open)
            )

            m5_open, m5_close = float(latest["open"]), float(latest["close"])
            previous_close = float(previous["close"])
            m5_direction = int(latest["direction"])
            m5_ok = (
                m5_direction == direction
                and (m5_close > m5_open if direction == 1 else m5_close < m5_open)
                and (m5_close > previous_close if direction == 1 else m5_close < previous_close)
            )
            if not m1_ok:
                return reject("pyramiding_m1_not_confirmed")
            if not m5_ok:
                return reject("pyramiding_m5_not_continuing")
        except (KeyError, TypeError, ValueError, IndexError):
            return reject("pyramiding_invalid_candle_data")

        try:
            live = [
                p for p in self.broker.positions()
                if p.symbol == sig.symbol
            ]
        except Exception:
            return reject("pyramiding_positions_unavailable")

        if len(live) != len(nodes):
            return reject("pyramiding_position_reconciliation")

        by_client = {}
        for pos in live:
            if not pos.client_id or pos.client_id in by_client:
                return reject("pyramiding_duplicate_live_position")
            by_client[pos.client_id] = pos

        total_net = 0.0
        for node in nodes:
            cid = node["client_id"]
            pos = by_client.get(cid)
            if (
                not cid or pos is None
                or pos.ticket != node["ticket"]
                or pos.side != sig.side
                or node["side"] != sig.side
            ):
                return reject("pyramiding_position_mismatch")

            # Each existing entry must retain its own protective SL and TP.
            if (
                pos.sl <= 0 or pos.tp <= 0
                or (pos.side == "BUY" and not (pos.sl < pos.open_price < pos.tp))
                or (pos.side == "SELL" and not (pos.tp < pos.open_price < pos.sl))
            ):
                return reject("pyramiding_protection_missing")

            try:
                pnl = self.broker.floating_net_pnl(pos)
                if pnl is None or not math.isfinite(float(pnl)):
                    return reject("pyramiding_costs_unverified")
                total_net += float(pnl)
            except Exception:
                return reject("pyramiding_pnl_unavailable")

        if total_net <= 0:
            return reject("pyramiding_group_not_profitable")

        return True, "pyramiding_approved", True

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

        if self.cache is not None:
            self.cache.begin_cycle()
        signals = self.strategy(now, self.broker)
        open_nodes = db.nodes("OPEN", "SENDING")
        plan = assign(
            signals, self.tree.queued_children(), len(self.broker.positions()),
            sum(1 for n in open_nodes if n["level"] > 0), cfg,
            min_risk_fn=self._min_risk_for_signal, db=db,
        )
        blocked = self.journal.blocked_buckets() if self.journal else set()

        for node, sig in plan:
            nid = node["node_id"] if node else None
            spec, quote = self.broker.spec(sig.symbol), self.broker.quote(sig.symbol)
            spread = quote[1] - quote[0] + extra_cost_price(spec, cfg)      # spread + commission + slippage
            row = result = est = None
            ctx = None
            setup, high_conf = sig.strategy, False

            if cfg.checklist_enabled:
                ctx = self.cache.get(self.broker, sig.symbol)
                if ctx is None:
                    db.decision(nid, False, "checklist:no_history", 0, 0)
                    continue
                if isinstance(ctx, dict):
                    row, result = multi_timeframe_checks(ctx, sig.side, spread, cfg)
                    if row is None:
                        db.decision(nid, False, "checklist:timeframes", 0, 0)
                        continue
                else:
                    row = ctx.iloc[-1].to_dict()
                    result = market_checks(row, sig.side, spread, cfg)
                if not result.passed:
                    db.decision(nid, False, "checklist:" + ",".join(result.failed), 0, 0)
                    continue
                setup = result.trigger
                hit = {f"setup:{setup}", f"session:{session_name(int(row['hour']))}",
                       f"pair:{sig.symbol}", f"level:{node['level'] if node else 0}"} & blocked
                if hit:
                    db.decision(nid, False, "journal_blocked:" + ",".join(sorted(hit)), 0, 0)
                    continue
                sig = replace(sig, stop_distance=result.stop)
                if cfg.multi_slot_enabled and self.journal:
                    est = self.journal.win_prob_lcb(setup, cfg.extra_slot_min_trades)
                    high_conf = est is not None and est >= cfg.extra_slot_min_prob

            allow_same_symbol, pyramid_reason, has_same_symbol = (
                self._same_symbol_pyramid_check(sig, acct, ctx, now)
            )
            if has_same_symbol and not allow_same_symbol:
                db.decision(nid, False, pyramid_reason, 0, 0)
                db.audit("risk", "pyramiding_rejected", {
                    "symbol": sig.symbol, "reason": pyramid_reason,
                })
                continue

            allocation = float(getattr(cfg, "allocated_capital", 0.0) or 0.0)
            risk_equity = min(acct.equity, allocation) if allocation > 0 else acct.equity
            risk_amount = float(getattr(cfg, "risk_per_trade_amount", 0.0) or 0.0)
            planned = node["planned_loss"] if node else (risk_amount if risk_amount > 0 else cfg.root_risk_pct * risk_equity)
            d = self.risk.evaluate(
                planned, sig, spec, quote, acct, now, nid,
                high_conf=high_conf,
                root_id=node["root_id"] if node else None,
                allow_same_symbol=allow_same_symbol,
            )
            if not d.approved:
                if node and d.permanent and not cfg.merge_small_children:
                    db.update_node(nid, state="DUST")
                    db.audit("tree", "node_dust", {"node": nid, "budget": node["budget"]})
                continue
            if node is None:
                nid = self.tree.create_root(sig, d.risk_amount, now)
                if nid is None:
                    db.audit("scanner", "duplicate_signal", {"signal_id": sig.signal_id})
                    continue
            self.exec.submit(nid, sig, spec, d.volume, d.risk_amount, now)
            placed = db.node(nid)
            if self.journal and result is not None and placed["state"] in ("OPEN", "SENDING"):
                self.journal.record_entry(nid, now, sig, placed["level"], placed["root_id"], setup,
                                          row, result, est, high_conf, d.risk_amount, cfg.rr, spread)
