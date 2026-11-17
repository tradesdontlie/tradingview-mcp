"""Protects gains and limits give-backs. Three independent layers:

1. PROFIT LOCK  Once equity is `lock_activate` (3%) above its starting level, a floor ratchets up
                behind it, always protecting `lock_frac` (50%) of the gains. Falling through the
                floor pauses trading for review. Re-arms from the current equity after a reset.
2. DRAWDOWN LADDER  Risk per trade shrinks as equity falls away from its peak
                (-1% -> 75%, -2% -> 50%, -3% -> 25%) and trading pauses at -5%.
3. LOSS-STREAK COOLDOWN  After `streak_n` consecutive losing trades, no new entries for a day.
Depends only on the database and the kill switch, never on the strategy.
"""
from .models import Mode


class EquityGuard:
    def __init__(self, db, cfg, kill):
        self.db, self.cfg, self.kill = db, cfg, kill

    def _f(self, k, default=0.0):
        return float(self.db.kv_get(k, default) or default)

    def _trip(self, reason):
        self.db.kv_set("guard_tripped", 1)
        self.kill.trigger(Mode.PAUSE, reason)

    def update(self, equity: float, now: float) -> None:
        d, c = self.db, self.cfg
        if d.kv_get("guard_tripped") == "1" and self.kill.mode == Mode.NONE:
            d.kv_set("guard_tripped", 0)                  # operator reset: re-arm from here
            d.kv_set("g_start", equity)
            d.kv_set("g_peak", equity)
            d.kv_set("g_floor", 0.0)
            d.audit("guard", "guard_rearmed", {"equity": equity})
        if d.kv_get("g_start") is None:
            d.kv_set("g_start", equity)
        start = self._f("g_start", equity)
        peak = max(self._f("g_peak", equity), equity)
        floor = self._f("g_floor", 0.0)
        if peak >= start * (1 + c.lock_activate):
            floor = max(floor, start + c.lock_frac * (peak - start))
        d.kv_set("g_peak", peak)
        d.kv_set("g_floor", floor)
        dd = (peak - equity) / peak if peak > 0 else 0.0
        d.kv_set("g_dd", dd)
        if floor > 0 and equity < floor:
            self._trip("profit_lock_floor")
        elif dd >= c.lockout_dd:
            self._trip("drawdown_lockout")

    def risk_scale(self) -> float:
        dd, scale = self._f("g_dd"), 1.0
        for thr, mult in self.cfg.dd_ladder:
            if dd >= thr:
                scale = mult
        return scale

    def entries_allowed(self, now: float):
        until = self._f("g_cooldown_until")
        if now < until:
            return False, "loss_streak_cooldown"
        return True, ""

    def on_trade_closed(self, net_pnl: float, now: float) -> None:
        streak = int(self._f("g_streak"))
        streak = 0 if net_pnl > 0 else streak + 1
        self.db.kv_set("g_streak", streak)
        if streak >= self.cfg.streak_n:
            self.db.kv_set("g_cooldown_until", now + self.cfg.streak_cooldown_s)
            self.db.kv_set("g_streak", 0)
            self.db.audit("guard", "loss_streak_cooldown", {"until": now + self.cfg.streak_cooldown_s})

    def state(self) -> dict:
        return {"peak": self._f("g_peak"), "floor": self._f("g_floor"), "drawdown": self._f("g_dd"),
                "risk_scale": self.risk_scale(), "streak": int(self._f("g_streak"))}
