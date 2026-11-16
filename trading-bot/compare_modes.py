"""Controlled A/B on IDENTICAL simulated markets (same seed -> same price path).

  original         the first bot: random entries, original rules
  improved+random  same random entries, but every one must pass the checklist, with equity guard,
                   journal, one-trade-per-tree, and marginal wins no longer funding children
  improved+scanner the checklist's own setups (structure / sweep / order block / opening range)

    python compare_modes.py --market random --seeds 3        # no edge exists: nothing should win
    python compare_modes.py --market trend  --seeds 3        # built-in trends: tests the machinery

NOTE: 'trend' markets contain trends by construction, so a trend-aware checklist is EXPECTED to do
better there. That shows the logic works, not that real markets pay. Real data decides.
"""
import argparse
import random

from tradingbot.advanced_bot import AdvancedBot
from tradingbot.analytics import summarize
from tradingbot.broker_sim import SimBroker
from tradingbot.config import Config
from tradingbot.database import Database
from tradingbot.market_context import ContextCache
from tradingbot.models import Signal
from tradingbot.orchestrator import Bot
from tradingbot.setups import ScannerStrategy

T0 = 1_699_999_200
SYMS = ["EURUSD", "GBPUSD", "USDJPY"]


def random_signals(seed):
    rng = random.Random(seed)

    def strat(now, broker):
        if rng.random() < 0.3:
            sym = rng.choice(SYMS)
            sp = broker.spec(sym)
            return [Signal(sym, rng.choice(["BUY", "SELL"]), 20 * sp.tick_size * 10, now)]
        return []
    return strat


def run(mode, market, seed, bars, equity=10000.0):
    broker = SimBroker(equity=equity, seed=seed, t0=T0, sigma=0.0008, spread_pips=0.7,
                       trend=0.000002 if market == "trend" else 0.0)
    broker.warmup(700)
    db = Database()
    if mode == "original":
        bot = Bot(Config(), db, broker, random_signals(seed + 100))
    elif mode == "improved+random":
        bot = AdvancedBot(Config.improved(), db, broker, random_signals(seed + 100))
    else:
        cfg, cache = Config.improved(), ContextCache()
        bot = AdvancedBot(cfg, db, broker, ScannerStrategy(cfg, SYMS, cache), cache)
    bot.startup()
    for _ in range(bars):
        bot.tick()
        broker.step()
    bot.strategy = lambda now, b: []
    bot.tick()
    s = summarize(db)
    eq = [r[0] for r in db.conn.execute("SELECT equity FROM snapshots ORDER BY ts")]
    peak, mdd = equity, 0.0
    for e in eq:
        peak = max(peak, e)
        mdd = max(mdd, (peak - e) / peak)
    return {"trades": s["trades"], "win": s["win_rate"], "net": broker.balance - equity,
            "mdd": mdd * 100, "roots": s["roots"], "children": s["trades"] - s["roots"],
            "kill": bot.kill.mode.value}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", choices=["random", "trend"], default="random")
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--bars", type=int, default=1200)
    a = ap.parse_args()
    print(f"\nMarket: {a.market}   {a.bars} hourly bars after warm-up   start equity 10,000")
    print(f"{'mode':<18}{'seed':>5}{'trades':>8}{'win%':>7}{'net':>10}{'maxDD%':>8}{'roots':>7}{'child':>7}  kill")
    tot = {}
    for mode in ("original", "improved+random", "improved+scanner"):
        for seed in range(1, a.seeds + 1):
            r = run(mode, a.market, seed, a.bars)
            tot.setdefault(mode, []).append(r)
            print(f"{mode:<18}{seed:>5}{r['trades']:>8}{r['win'] * 100:>7.1f}{r['net']:>10.0f}{r['mdd']:>8.1f}"
                  f"{r['roots']:>7}{r['children']:>7}  {r['kill']}", flush=True)
    print("\nAVERAGE over seeds")
    for mode, rs in tot.items():
        k = len(rs)
        print(f"{mode:<18}  trades {sum(r['trades'] for r in rs) / k:6.1f}   "
              f"net {sum(r['net'] for r in rs) / k:8.0f}   maxDD {sum(r['mdd'] for r in rs) / k:5.1f}%")


if __name__ == "__main__":
    main()
