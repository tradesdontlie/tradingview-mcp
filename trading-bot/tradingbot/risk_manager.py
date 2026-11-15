"""Approval authority. Every order must pass here. Independent of the strategy engine.

Volume is always ROUNDED DOWN to the broker's step. If even the minimum lot would risk
more than the allowed amount, the trade is rejected (never rounded up).
"""
import math
import time
from dataclasses import dataclass

from .models import Mode


@dataclass
class Decision:
    approved: bool
    reason: str = ""
    volume: float = 0.0
    risk_amount: float = 0.0
    permanent: bool = False      # True: this node's budget can never fund a minimum lot


def floor_step(x: float, step: float) -> float:
    return round(math.floor(x / step + 1e-9) * step, 8)


def _ccy(symbol: str, side: str) -> dict:
    s = 1 if side == "BUY" else -1
    if len(symbol) >= 6:
        return {symbol[:3]: s, symbol[3:6]: -s}
    return {symbol: s}


class RiskManager:
    def __init__(self, db, cfg, kill):
        self.db, self.cfg, self.kill = db, cfg, kill

    # ---- account-level watch: run every tick ----
    def check_account(self, acct, now: float) -> None:
        self.db.snapshot(acct.balance, acct.equity, acct.margin_free)
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        if self.db.kv_get("day_key") != day:
            self.db.kv_set("day_key", day)
            self.db.kv_set("day_start_equity", acct.equity)
        day_start = float(self.db.kv_get("day_start_equity", acct.equity))
        peak = max(float(self.db.kv_get("peak_equity", acct.equity)), acct.equity)
        self.db.kv_set("peak_equity", peak)

        if day_start > 0 and (day_start - acct.equity) / day_start >= self.cfg.daily_loss_pct:
            self.kill.trigger(Mode.PAUSE, "daily_loss_limit")
        if peak > 0 and (peak - acct.equity) / peak >= self.cfg.max_drawdown_pct:
            self.kill.trigger(Mode.FREEZE, "max_drawdown")

    # ---- per-trade approval ----
    def evaluate(self, planned_loss, sig, spec, quote, acct, now, node_id=None) -> Decision:
        c = self.cfg

        def reject(reason, permanent=False):
            self.db.decision(node_id, False, reason, 0.0, 0.0)
            return Decision(False, reason, permanent=permanent)

        mode = self.kill.mode
        if mode != Mode.NONE:
            return reject(f"kill_switch_{mode.value}")
        open_nodes = self.db.nodes("OPEN", "SENDING")
        if len(open_nodes) >= c.max_open:
            return reject("max_open_reached")
        if now - sig.created_at > c.signal_max_age_s:
            return reject("stale_signal")
        if sig.stop_distance < spec.min_stop_distance:
            return reject("stop_too_close")
        bid, ask = quote
        if ask - bid > c.max_spread_frac_of_stop * sig.stop_distance:
            return reject("spread_too_wide")
        if acct.margin_free < c.min_free_margin_pct * acct.equity:
            return reject("low_free_margin")

        loss_per_lot = sig.stop_distance / spec.tick_size * spec.tick_value
        if loss_per_lot <= 0:
            return reject("bad_symbol_spec")

        # 1) can this node's own budget fund a minimum lot at all?
        budget_cap = min(planned_loss, c.max_trade_risk_pct * acct.equity)
        if floor_step(budget_cap / loss_per_lot, spec.volume_step) < spec.volume_min - 1e-12:
            return reject("below_min_lot", permanent=True)

        # 2) does the account have risk headroom right now?
        headroom = c.max_open_risk_pct * acct.equity - sum(n["risk_amount"] or 0 for n in open_nodes)
        cap = min(budget_cap, headroom)
        vol = floor_step(cap / loss_per_lot, spec.volume_step)
        if vol < spec.volume_min - 1e-12:
            return reject("no_risk_headroom")
        vol = min(vol, spec.volume_max)

        if c.block_correlated:
            new = _ccy(sig.symbol, sig.side)
            for n in open_nodes:
                for ccy, s in _ccy(n["symbol"], n["side"]).items():
                    if new.get(ccy) == s:
                        return reject("correlated_exposure")

        risk = vol * loss_per_lot
        self.db.decision(node_id, True, "ok", risk, vol)
        return Decision(True, "ok", vol, risk)
