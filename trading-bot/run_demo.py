"""Plumbing test on an MT5 DEMO account using a RANDOM placeholder signal.

    python run_demo.py --interval 60

This proves orders, stops, reconciliation, the tree ledger and the kill switch work against
your real terminal. It is NOT a trading strategy and has no edge. It refuses real accounts.
Stop it any time with Ctrl+C; positions keep their server-side stops.
Emergency control from another window:
    python kill.py freeze      /      python kill.py reset
"""
import argparse
import random
import time

from tradingbot.broker_mt5 import MT5Broker
from tradingbot.config import Config
from tradingbot.database import Database
from tradingbot.models import Signal
from tradingbot.orchestrator import Bot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, default=60, help="seconds between ticks")
    ap.add_argument("--symbols", nargs="+", default=["EURUSD", "GBPUSD", "USDJPY"])
    ap.add_argument("--signal-prob", type=float, default=0.02)
    args = ap.parse_args()

    cfg = Config(root_risk_pct=0.001)                      # tiny risk for the plumbing test
    broker = MT5Broker(require_demo=True)
    rng = random.Random()

    def strat(now, b):
        if rng.random() > args.signal_prob:
            return []
        sym = rng.choice(args.symbols)
        spec = b.spec(sym)
        pip = spec.tick_size * 10 if spec.digits in (3, 5) else spec.tick_size
        return [Signal(sym, rng.choice(["BUY", "SELL"]), 20 * pip, now, "random-demo")]

    bot = Bot(cfg, Database(cfg.db_path), broker, strat)
    bot.startup()
    print(f"Running on DEMO. Kill switch: {bot.kill.mode.value}. Ctrl+C to stop.")
    while True:
        bot.tick()
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
