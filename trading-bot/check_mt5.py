"""READ-ONLY health check for your MT5 terminal. Places no orders.

    python check_mt5.py
    python check_mt5.py --symbols EURUSD GBPUSD --stop-pips 20 --root-risk-pct 0.005

Shows: demo/real, hedging vs netting (netting breaks per-trade tracking), per-symbol
minimum-lot risk, and how many tree levels your account can actually fund.
"""
import argparse

from tradingbot.broker_mt5 import MT5Broker
from tradingbot.config import Config
from tradingbot.costs import affordability
from tradingbot.market_context import build_context


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="+", default=["EURUSD", "GBPUSD", "USDJPY"])
    ap.add_argument("--stop-pips", type=float, default=20)
    ap.add_argument("--root-risk-pct", type=float, default=0.005)
    ap.add_argument("--profile", choices=["standard", "small", "scalp"], default="small",
                    help="which profile's stops to test (small/standard = H1, scalp = M5)")
    args = ap.parse_args()

    b = MT5Broker(require_demo=False)
    a = b.account()
    print(f"\nAccount: {'DEMO' if a.is_demo else 'REAL'} | equity {a.equity:,.2f} | "
          f"{'HEDGING (good)' if a.hedging else 'NETTING (BAD: positions on one symbol merge)'}")

    root_risk = args.root_risk_pct * a.equity
    print(f"Root risk at {args.root_risk_pct:.2%} of equity = {root_risk:,.2f}\n")
    for sym in args.symbols:
        try:
            s = b.spec(sym)
            bid, ask = b.quote(sym)
        except Exception as e:
            print(f"{sym}: unavailable ({e})")
            continue
        pip = s.tick_size * 10 if s.digits in (3, 5) else s.tick_size
        stop = args.stop_pips * pip
        per_lot = stop / s.tick_size * s.tick_value
        min_risk = s.volume_min * per_lot
        print(f"{sym}: min lot {s.volume_min}, step {s.volume_step}, spread {(ask - bid) / pip:.1f} pips, "
              f"risk at min lot with a {args.stop_pips:g}-pip stop = {min_risk:,.2f}")
        for level in range(5):
            r = root_risk / 4 ** level            # each child risks 1/4 of its parent (default rules)
            ok = "tradable" if r >= min_risk else "DUST - cannot fund a minimum lot"
            print(f"    tree level {level}: planned risk {r:8.2f}  -> {ok}")
        print()
    print("Levels marked DUST can never trade. If level 1 is DUST, your tree is root-only.")
    cfg = {"scalp": Config.scalp, "small": Config.small}.get(args.profile, Config.improved)()
    print(f"\nCAN THIS BALANCE TRADE? ({args.profile} profile: {cfg.ctx_tf} stops of at least "
          f"{cfg.ck_stop_atr_lo:g} x ATR, risk {cfg.root_risk_pct:.1%} of equity)")
    for sym in args.symbols:
        try:
            spec, (bid, ask) = b.spec(sym), b.quote(sym)
            atr = float(build_context(b.candles(sym, 450, cfg.ctx_tf), cfg.ctx_htf)["atr"].iloc[-1])
            r = affordability(spec, a.equity, cfg, cfg.ck_stop_atr_lo * atr, ask - bid)
        except Exception as e:
            print(f"  {sym}: could not check ({e})")
            continue
        verdict = "YES" if r["ok"] else f"NO - needs a balance of about {r['needs_equity']:,.0f}"
        print(f"  {sym}: smallest trade risks {r['min_risk']:.2f} vs budget {r['budget']:.2f}; "
              f"spread eats {r['cost_r']:.0%} of the stop  ->  {verdict}")
    print("If every line says NO, use a cent account or a bigger balance. Raising risk or leverage is not the fix.")


if __name__ == "__main__":
    main()
