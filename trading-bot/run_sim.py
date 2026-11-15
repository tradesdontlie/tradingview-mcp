"""Run the whole bot against the simulated broker (no MT5, no money, any OS).

    python run_sim.py                       # 5,000 hourly bars, random-entry placeholder strategy
    python run_sim.py --equity 1000         # see what a small account does to the tree
    python run_sim.py --bars 20000 --seed 5

The placeholder strategy enters at RANDOM. It has no edge, so expect small losses from
spread and commission. The purpose is to prove the plumbing: tree rules, risk gates,
slot limit, kill switch, reconciliation. It says nothing about profitability.
"""
import argparse
import random

from tradingbot.analytics import summarize
from tradingbot.broker_sim import SimBroker
from tradingbot.config import Config
from tradingbot.database import Database
from tradingbot.models import Signal
from tradingbot.orchestrator import Bot


def random_strategy(seed, p=0.3, stop=0.0020):
    rng = random.Random(seed)

    def strat(now, broker):
        if rng.random() < p:
            return [Signal(rng.choice(["EURUSD", "GBPUSD", "USDJPY"]),
                           rng.choice(["BUY", "SELL"]),
                           stop, now)]
        return []
    return strat


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bars", type=int, default=5000)
    ap.add_argument("--equity", type=float, default=10000.0)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    cfg = Config()
    broker = SimBroker(equity=args.equity, seed=args.seed)
    bot = Bot(cfg, Database(), broker, random_strategy(args.seed + 100))
    bot.startup()
    max_open = 0
    for _ in range(args.bars):
        bot.tick()
        max_open = max(max_open, len(broker.positions()))
        broker.step()
    bot.strategy = lambda now, b: []
    bot.tick()

    s = summarize(bot.db)
    print(f"\nSimulated {args.bars} bars, start equity {args.equity:,.0f}, "
          f"end balance {broker.balance:,.2f}")
    print(f"max positions open at once: {max_open} (limit {cfg.max_open})")
    print(f"kill switch: {bot.kill.mode.value} {bot.kill.reason}")
    print(f"trades {s['trades']}  win rate {s['win_rate']:.1%}  net {s['net_pnl']:+.2f}  "
          f"profit factor {s['profit_factor']:.2f}  max drawdown {s['max_drawdown']:.2f}")
    print(f"roots {s['roots']}  trades per root {s['trades_per_root']:.2f}  "
          f"root pool {s['root_pool']:.2f}")
    print("node states:", s["states"])
    print("by tree level:", {k: {"trades": v["trades"], "net": round(v["net"], 2)}
                              for k, v in sorted(s["by_level"].items())})


if __name__ == "__main__":
    main()
