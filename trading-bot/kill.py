"""Independent kill-switch control. Talks only to the database, never to the strategy.

    python kill.py status
    python kill.py pause | freeze | liquidate [reason]
    python kill.py reset          (asks you to type RESET)
"""
import sys

from tradingbot.config import Config
from tradingbot.database import Database
from tradingbot.kill_switch import KillSwitch
from tradingbot.models import Mode


def main():
    cmd = sys.argv[1].lower() if len(sys.argv) > 1 else "status"
    ks = KillSwitch(Database(Config().db_path))
    if cmd == "status":
        print(ks.mode.value, ks.reason)
    elif cmd in ("pause", "freeze", "liquidate"):
        reason = " ".join(sys.argv[2:]) or "manual"
        ks.trigger(Mode[cmd.upper()], reason, actor="operator")
        print("Now:", ks.mode.value)
    elif cmd == "reset":
        ok = ks.reset("operator", input("Type RESET to resume trading: ").strip())
        print("Reset." if ok else "Not reset.")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
