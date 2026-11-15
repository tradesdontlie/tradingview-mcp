"""READ-ONLY health check for your MT5 terminal. Places no orders.

    python check_mt5.py
    python check_mt5.py --symbols EURUSD GBPUSD --stop-pips 20 --root-risk-pct 0.005

Shows: demo/real, hedging vs netting (netting breaks per-trade tracking), per-symbol
minimum-lot risk, and how many tree levels your account can actually fund.
"""
import argparse

from tradingbot.broker_mt5 import MT5Broker


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="+", default=["EURUSD", "GBPUSD", "USDJPY"])
    ap.add_argument("--stop-pips", type=float, default=20)
    ap.add_argument("--root-risk-pct", type=float, default=0.005)
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


if __name__ == "__main__":
    main()
