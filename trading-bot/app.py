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

from tradingbot.advanced_bot import AdvancedBot
from tradingbot.config import Config
from tradingbot.costs import affordability
from tradingbot.market_context import ContextCache
from tradingbot.database import Database
from tradingbot.models import Signal
from tradingbot.orchestrator import Bot
from tradingbot.setups import ScannerStrategy
from tradingbot.server import serve


def bot_loop(cfg, mode, speed, equity, interval, legacy=False):
    db = Database(cfg.db_path)
    rng = random.Random()
    if mode == "sim":
        from tradingbot.broker_sim import SimBroker
        broker = SimBroker(equity=equity, seed=rng.randint(1, 9999), t0=1_699_999_200, sigma=0.0008,
                           spread_pips=0.7, bar_minutes=5 if cfg.ctx_tf == "M5" else 60)
        broker.warmup(700)
    else:
        from tradingbot.broker_mt5 import MT5Broker
        broker = MT5Broker(require_demo=True)
        cfg.root_risk_pct = min(cfg.root_risk_pct, 0.001) if not cfg.regime_gating else cfg.root_risk_pct

    symbols = ["EURUSD", "GBPUSD", "USDJPY"]
    try:                                            # screen out symbols this account cannot afford at all
        from tradingbot.market_context import build_context
        eq = broker.account().equity
        keep = []
        for sym in symbols:
            ctx = build_context(broker.candles(sym, 450, cfg.ctx_tf), cfg.ctx_htf)
            spec, atr = broker.spec(sym), float(ctx["atr"].iloc[-1])
            a = affordability(spec, eq, cfg, cfg.ck_stop_atr_lo * atr)
            print(f"  {sym}: smallest trade risks {a['min_risk']:.2f}, budget {a['budget']:.2f}  ->  "
                  + ("OK" if a["ok"] else f"TOO BIG (needs a balance of about {a['needs_equity']:,.0f})"))
            if a["ok"]:
                keep.append(sym)
        if keep:
            symbols = keep
        else:
            print("  No symbol fits this balance: the bot will watch but cannot trade. Use a cent account "
                  "or a larger balance.")
    except Exception as e:
        print("  (affordability screen skipped:", repr(e)[:80], ")")

    def strat(now, b):                       # PLACEHOLDER: random entries, no edge
        if rng.random() > (0.3 if mode == "sim" else 0.02):
            return []
        sym = rng.choice(symbols)
        sp = b.spec(sym)
        pip = sp.tick_size * 10 if sp.digits in (3, 5) else sp.tick_size
        return [Signal(sym, rng.choice(["BUY", "SELL"]), 20 * pip, now, "random-placeholder")]

    if legacy:
        bot = Bot(cfg, db, broker, strat)                  # the original bot, random placeholder
    else:
        cache = ContextCache(tf=cfg.ctx_tf, htf=cfg.ctx_htf)
        bot = AdvancedBot(cfg, db, broker, ScannerStrategy(cfg, symbols, cache), cache)
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
    ap.add_argument("--db", help="database file: give EACH broker account its own (e.g. exness1.db)")
    ap.add_argument("--host", default="127.0.0.1", help="0.0.0.0 or a Tailscale IP to open it to your phone")
    ap.add_argument("--profile", choices=["standard", "small", "scalp"], default="standard",
                    help="small = H1, one trade at a time, strict costs (for $10-50 accounts); scalp = M5 (cost-bound, test first)")
    ap.add_argument("--legacy", action="store_true", help="original bot with random placeholder signals")
    a = ap.parse_args()

    cfg = (Config if a.legacy else Config.scalp if a.profile == "scalp" else Config.small if a.profile == "small" else Config.improved)(db_path=a.db or ("sim.db" if a.mode == "sim" else "bot.db"))
    if a.mode == "sim":
        for ext in ("", "-wal", "-shm"):
            if os.path.exists(cfg.db_path + ext):
                os.remove(cfg.db_path + ext)
    token = os.environ.get("DASHBOARD_TOKEN") or secrets.token_urlsafe(8)
    threading.Thread(target=bot_loop, args=(cfg, a.mode, a.speed, a.equity, a.interval, a.legacy),
                     daemon=True).start()
    tg, chat = os.environ.get("TELEGRAM_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if tg and chat:
        from tradingbot.alerts import alerts_loop, telegram_sender
        time.sleep(1)
        threading.Thread(target=alerts_loop, args=(cfg.db_path, telegram_sender(tg, chat), a.mode),
                         daemon=True).start()
        print("Telegram alerts: ON")
    print(f"\nOpen this link (token included, on your phone too):\n  http://{a.host}:{a.port}/?t={token}\n")
    serve(cfg, token, a.port, a.host)


if __name__ == "__main__":
    main()
