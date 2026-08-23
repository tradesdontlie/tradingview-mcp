"""
Runs the Fabio strategy across symbol x session x tier and prints one
comparison table (overall metrics only — the full segmented breakdown for
any individual run is available via backtest.py directly / the CSV logs).

Run as a module from the repo root:
    python -m strategies.fabio_strategy.compare
"""
import json
import sys

from .backtest import SESSION_GROUPS, TIER_MAX_RISK, run_backtest, segmented_metrics
from .config import FabioConfig

SYMBOLS = ("MNQ1!", "MGC1!")
SESSIONS = ("asia", "ny")
TIERS = ("scalp", "swing")


def main():
    rows = []
    all_results = {}
    for symbol in SYMBOLS:
        for session in SESSIONS:
            for tier in TIERS:
                cfg = FabioConfig()
                cfg.risk.rr_ratio = 2.0
                cfg.risk.max_risk_points = TIER_MAX_RISK[symbol][tier]
                df = run_backtest(symbol, cfg, days=None, session_filter=SESSION_GROUPS[session])
                metrics = segmented_metrics(df)
                key = f"{symbol} | {session} | {tier}"
                all_results[key] = metrics
                overall = metrics.get("overall", {})
                rows.append((symbol, session, tier, overall))

    print(json.dumps(all_results, indent=2, default=str))

    print("\n=== Fabio strategy — symbol x session x tier (RR=2.0) ===", file=sys.stderr)
    print(f"{'symbol':<8} {'session':<7} {'tier':<7} {'n':>5} {'win%':>7} {'PF':>7} {'avgR':>7} {'exp$':>8}", file=sys.stderr)
    for symbol, session, tier, o in rows:
        n = o.get("n", 0)
        wr = f"{o.get('win_rate', 0) * 100:.1f}" if o.get("win_rate") is not None else "-"
        pf = f"{o.get('profit_factor'):.2f}" if o.get("profit_factor") is not None else "-"
        avgr = f"{o.get('avg_r'):.2f}" if o.get("avg_r") is not None else "-"
        exp = f"{o.get('expectancy_dollars'):.2f}" if o.get("expectancy_dollars") is not None else "-"
        print(f"{symbol:<8} {session:<7} {tier:<7} {n:>5} {wr:>7} {pf:>7} {avgr:>7} {exp:>8}", file=sys.stderr)


if __name__ == "__main__":
    main()
