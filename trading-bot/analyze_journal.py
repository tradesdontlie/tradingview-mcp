"""Read the trade journal: what is working, what is not, and what the bot has learned.

    python analyze_journal.py                 # uses bot.db (demo) ; add --db sim.db for the simulator
"""
import argparse

from tradingbot.config import Config
from tradingbot.database import Database
from tradingbot.journal import Journal


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=Config().db_path)
    ap.add_argument("--min-n", type=int, default=10)
    a = ap.parse_args()
    j = Journal(Database(a.db), Config.improved())
    r = j.analyze(a.min_n)
    o = r["overall"]
    if not o.get("n"):
        raise SystemExit("No closed trades in the journal yet.")
    print(f"\nTrades {o['n']} | win rate {o['win_rate']:.1%} (95% range {o['win_lo']:.0%}-{o['win_hi']:.0%}) | "
          f"avg {o['avg_r']:+.2f}R | total {o['total_r']:+.1f}R | profit factor {o['profit_factor']:.2f}")
    print(f"Break-even win rate at this reward ratio, after assumed costs: {r['breakeven_win_rate']:.1%}\n")
    print(f"{'bucket':<26}{'n':>5}{'win%':>7}{'avgR':>8}{'win% range':>13}")
    for tag, s in sorted(r["by_tag"].items(), key=lambda kv: kv[1]["avg_r"]):
        print(f"{tag:<26}{s['n']:>5}{s['win_rate'] * 100:>7.1f}{s['avg_r']:>8.2f}"
              f"{s['win_lo'] * 100:>8.0f}-{s['win_hi'] * 100:.0f}%")
    print("\nBlocked by the learning gate:", ", ".join(sorted(j.blocked_buckets())) or "nothing yet "
          f"(needs {j.cfg.gate_min_n}+ trades and a win-rate range entirely below break-even)")
    print("\nRecent lessons:")
    for lesson in r["recent_lessons"]:
        print("  -", lesson)


if __name__ == "__main__":
    main()
