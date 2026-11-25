"""Order submission and reconciliation with the broker.

Principle: never assume an order was accepted or rejected until broker state proves it.
  1. The intent is written to the database BEFORE the order is sent.
  2. Every order carries a unique client id ("tm<node>a<attempt>").
  3. On any ambiguous failure the engine looks the order up by client id instead of resending.
  4. reconcile() compares database and broker every tick, and after every restart.
"""
from .models import BrokerReject, Mode

PREFIX = "tm"


class ExecutionEngine:
    def __init__(self, db, broker, tree, kill, cfg):
        self.db, self.broker, self.tree, self.kill, self.cfg = db, broker, tree, kill, cfg

    # ---------------- submit ----------------
    def submit(self, node_id, sig, spec, volume, risk_amount, now) -> bool:
        node = self.db.node(node_id)
        attempts = (node["attempts"] or 0) + 1
        cid = f"{PREFIX}{node_id}a{attempts}"
        bid, ask = self.broker.quote(sig.symbol)
        entry = ask if sig.side == "BUY" else bid
        d = sig.stop_distance
        sgn = 1 if sig.side == "BUY" else -1
        sl = round(entry - sgn * d, spec.digits)
        tp = round(entry + sgn * self.cfg.rr * d, spec.digits)

        self.db.update_node(node_id, state="SENDING", client_id=cid, attempts=attempts,
                            symbol=sig.symbol, side=sig.side, volume=volume,
                            risk_amount=risk_amount, entry=entry, sl=sl, tp=tp, sent_ts=now)
        self.db.audit("exec", "order_intent", {"node": node_id, "cid": cid, "vol": volume})
        try:
            pos = self.broker.send_market(cid, sig.symbol, sig.side, volume, sl, tp)
        except BrokerReject as e:
            self._failed(node_id, f"rejected: {e}")
            return False
        except Exception as e:                       # ambiguous: do NOT assume anything
            self.db.audit("exec", "order_ambiguous", {"node": node_id, "cid": cid, "err": repr(e)})
            return self._resolve(node_id, cid, now)
        self.db.update_node(node_id, state="OPEN", ticket=pos.ticket, entry=pos.open_price,
                            opened_ts=now)
        return True

    def _resolve(self, node_id, cid, now) -> bool:
        try:
            pos = self.broker.find_position(cid)
            if pos:
                self.db.update_node(node_id, state="OPEN", ticket=pos.ticket,
                                    entry=pos.open_price, opened_ts=now)
                self.db.audit("exec", "ambiguous_resolved_open", {"node": node_id})
                return True
            closed = self.broker.closed_trade(cid)
            if closed:
                self.db.update_node(node_id, state="OPEN", opened_ts=now)
                self.tree.on_closed(node_id, closed.net_pnl, now)
                return True
            self._failed(node_id, "ambiguous_not_found")
            return False
        except Exception as e:                       # cannot verify -> stay SENDING and stop trading
            self.kill.trigger(Mode.PAUSE, "ambiguous_order_state")
            self.db.audit("exec", "ambiguous_unresolved", {"node": node_id, "err": repr(e)})
            return False

    def _failed(self, node_id, why):
        node = self.db.node(node_id)
        state = "CANCELLED" if node["level"] == 0 else "QUEUED"   # a child's budget is kept
        self.db.update_node(node_id, state=state)
        self.db.audit("exec", "order_failed", {"node": node_id, "why": why})

    # ---------------- reconcile ----------------
    def reconcile(self, now) -> list:
        try:
            live = self.broker.positions()
        except Exception as e:
            self.kill.trigger(Mode.PAUSE, "broker_unreachable")
            self.db.audit("exec", "reconcile_failed", {"err": repr(e)})
            return []

        # In capped demo mode, unmanaged positions make account-wide risk unknown.
        demo_cap = float(getattr(self.cfg, "demo_risk_cap_pct", 0.0) or 0.0)
        unmanaged = [p for p in live if not p.client_id.startswith(PREFIX)]
        if demo_cap > 0 and unmanaged:
            if self.kill.trigger(Mode.PAUSE, "unmanaged_position"):
                self.db.audit("risk", "unmanaged_positions_detected", {
                    "tickets": [p.ticket for p in unmanaged],
                    "symbols": [p.symbol for p in unmanaged],
                })

        tagged = {p.client_id: p for p in live if p.client_id.startswith(PREFIX)}
        closed_nodes = []

        for n in self.db.nodes("OPEN", "SENDING", "QUEUED", "CANCELLED"):
            cid, pos = n["client_id"], tagged.get(n["client_id"])
            if not cid:
                continue
            if n["state"] in ("QUEUED", "CANCELLED"):          # a late fill we had written off
                if pos:
                    self.db.update_node(n["node_id"], state="OPEN", ticket=pos.ticket,
                                        opened_ts=now)
                    self.db.audit("exec", "late_fill_adopted", {"node": n["node_id"]})
                continue
            if pos:
                if n["state"] == "SENDING":
                    self.db.update_node(n["node_id"], state="OPEN", ticket=pos.ticket,
                                        entry=pos.open_price, opened_ts=now)
                elif self.cfg.max_hold_s > 0 and now - (n["opened_ts"] or now) > self.cfg.max_hold_s:
                    self.db.audit("exec", "time_stop", {"node": n["node_id"]})
                    try:
                        self.broker.close_position(pos.ticket)
                    except Exception as e:
                        self.db.audit("exec", "time_stop_failed", {"err": repr(e)})
                continue
            # no live position: it closed (or never opened)
            try:
                ct = self.broker.closed_trade(cid, n["ticket"])
            except Exception:
                continue
            if ct:
                self.tree.on_closed(n["node_id"], ct.net_pnl, now)
                closed_nodes.append(n["node_id"])
            elif n["state"] == "SENDING" and now - (n["sent_ts"] or now) > self.cfg.send_grace_s:
                self._failed(n["node_id"], "never_confirmed")
            elif n["state"] == "OPEN":
                self.db.audit("exec", "close_history_missing", {"node": n["node_id"]})

        known = {n["client_id"] for n in self.db.nodes() if n["client_id"]}
        for cid in tagged:
            if cid not in known:
                self.kill.trigger(Mode.PAUSE, "orphan_position")
                self.db.audit("exec", "orphan_position", {"cid": cid})
        return closed_nodes
