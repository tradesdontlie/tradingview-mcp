"""Persistent emergency control. Depends ONLY on the database, never on the strategy.

- Automatic triggers can only ESCALATE (PAUSE -> FREEZE -> LIQUIDATE), never relax.
- State lives in SQLite, so a process restart cannot clear it.
- Resuming requires an explicit authorised action: reset(actor, confirm="RESET").
"""
from .models import Mode, SEVERITY


class KillSwitch:
    def __init__(self, db):
        self.db = db

    @property
    def mode(self) -> Mode:
        return Mode(self.db.kv_get("kill_mode", Mode.NONE.value))

    @property
    def reason(self) -> str:
        return self.db.kv_get("kill_reason", "")

    def allows_new_entries(self) -> bool:
        return self.mode == Mode.NONE

    def trigger(self, mode: Mode, reason: str, actor: str = "auto") -> bool:
        if SEVERITY[mode] <= SEVERITY[self.mode]:
            return False                      # never downgrade or repeat
        self.db.kv_set("kill_mode", mode.value)
        self.db.kv_set("kill_reason", reason)
        self.db.kv_set("kill_ts", self.db.clock())
        self.db.audit(actor, "kill_switch_activated", {"mode": mode.value, "reason": reason})
        return True

    def reset(self, actor: str, confirm: str) -> bool:
        if confirm != "RESET":
            self.db.audit(actor, "kill_switch_reset_refused", {"mode": self.mode.value})
            return False
        previous = self.mode.value
        self.db.kv_set("kill_mode", Mode.NONE.value)
        self.db.kv_set("kill_reason", "")
        self.db.audit(actor, "kill_switch_reset", {"previous": previous})
        return True
