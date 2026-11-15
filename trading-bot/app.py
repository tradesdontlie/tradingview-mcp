"""One command: bot + web console.

    python app.py --mode sim                 # simulated broker, any OS, opens http://127.0.0.1:8765
    python app.py --mode demo                # MT5 DEMO account (Windows), random placeholder signals
Environment: DASHBOARD_TOKEN to choose the control token (otherwise a random one is printed).
"""
import argparse
import os
import random
import secrets
import threading
import time

from tradingbot.config import Config
from tradingbot.database import Database
from tradingbot.models import Signal
from tradingbot.orchestrator import Bot
from tradingbot.server import serve


def bot_loop(cfg, mode, speed, equity, interval):
    db = Database(cfg.db_path)
    rng = random.Random()
    if mode == "sim":
        from tradingbot.broker_sim import SimBroker
        broker = SimBroker(equity=equity, seed=rng.randint(1, 9999))
    else:
        from tradingbot.broker_mt5 import MT5Broker
        broker = MT5Broker(require_demo=True)
        cfg.root_risk_pct = 0.001

    symbols = ["EURUSD", "GBPUSD", "USDJPY"]

    def strat(now, b):                       # PLACEHOLDER: random entries, no edge
        if rng.random() > (0.3 if mode == "sim" else 0.02):
            return []
        sym = rng.choice(symbols)
        sp = b.spec(sym)
        pip = sp.tick_size * 10 if sp.digits in (3, 5) else sp.tick_size
        return [Signal(sym, rng.choice(["BUY", "SELL"]), 20 * pip, now, "random-placeholder")]

    bot = Bot(cfg, db, broker, strat)
    db.kv_set("run_mode", mode)
    bot.startup()
    while True:
        bot.tick()
        db.kv_set("heartbeat", time.time())
        if mode == "sim":
            broker.step()
            time.sleep(speed)
        else:
            time.sleep(interval)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["sim", "demo"], default="sim")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--speed", type=float, default=0.15, help="sim: seconds per simulated hour")
    ap.add_argument("--equity", type=float, default=10000)
    ap.add_argument("--interval", type=float, default=60, help="demo: seconds between ticks")
    a = ap.parse_args()

    cfg = Config(db_path="sim.db" if a.mode == "sim" else "bot.db")
    if a.mode == "sim":
        for ext in ("", "-wal", "-shm"):
            if os.path.exists(cfg.db_path + ext):
                os.remove(cfg.db_path + ext)
    token = os.environ.get("DASHBOARD_TOKEN") or secrets.token_urlsafe(8)
    threading.Thread(target=bot_loop, args=(cfg, a.mode, a.speed, a.equity, a.interval),
                     daemon=True).start()
    print(f"\nConsole:  http://127.0.0.1:{a.port}\nControl token (paste into the page): {token}\n")
    serve(cfg, token, a.port)


if __name__ == "__main__":
    main()
