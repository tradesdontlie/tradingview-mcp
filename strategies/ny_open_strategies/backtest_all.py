"""
Runs all four NY-session strategies (VWAP reversion, MA9 trend-following,
opening range breakout, liquidity-sweep reversal) plus the Asian
failed-breakout strategy over the same symbol/window and prints one
comparison table — so results are read side by side rather than as four
separate JSON blobs.

Run as a module from the repo root:
    python -m strategies.ny_open_strategies.backtest_all --symbol MGC1! --days 30
"""
import argparse
import json
import sys

from ..asian_failed_breakout.backtest import run_backtest as run_asian
from ..asian_failed_breakout.backtest import summarize as summarize_asian
from ..asian_failed_breakout.config import StrategyConfig as AsianConfig
from . import liquidity_sweep_reversal as ny_sweep
from . import ma9_trend_following as ma9
from . import opening_range_breakout as orb
from . import vwap_reversion as vwap
from .common import summarize as summarize_generic


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="MGC1!")
    parser.add_argument("--days", type=int, default=None)
    parser.add_argument("--skip-asian", action="store_true", help="skip the Asian failed-breakout strategy")
    args = parser.parse_args()

    results = {}

    if not args.skip_asian:
        df = run_asian(args.symbol, AsianConfig(), args.days)
        results["asian_failed_breakout"] = summarize_asian(df)

    df_ny = ny_sweep.run_backtest(args.symbol, AsianConfig(), args.days)
    results["ny_liquidity_sweep_reversal"] = ny_sweep.summarize(df_ny)

    results["vwap_reversion"] = summarize_generic(vwap.run_backtest(args.symbol, vwap.VWAPReversionConfig(), args.days))
    results["ma9_trend_following"] = summarize_generic(ma9.run_backtest(args.symbol, ma9.MA9TrendConfig(), args.days))
    results["opening_range_breakout"] = summarize_generic(orb.run_backtest(args.symbol, orb.ORBConfig(), args.days))

    print(json.dumps(results, indent=2, default=str))

    print("\n=== Summary ===", file=sys.stderr)
    print(f"{'strategy':<28} {'trades':>7} {'win%':>7} {'PF':>7} {'avgR':>7} {'total$':>10}", file=sys.stderr)
    for name, r in results.items():
        n = r.get("n_trades_filled", 0)
        wr = f"{r.get('win_rate', 0) * 100:.1f}" if r.get("win_rate") is not None else "-"
        pf = f"{r.get('profit_factor'):.2f}" if r.get("profit_factor") is not None else "-"
        avgr = f"{r.get('avg_r_multiple'):.2f}" if r.get("avg_r_multiple") is not None else "-"
        total = f"{r.get('total_pnl_dollars'):.0f}" if r.get("total_pnl_dollars") is not None else "-"
        print(f"{name:<28} {n:>7} {wr:>7} {pf:>7} {avgr:>7} {total:>10}", file=sys.stderr)


if __name__ == "__main__":
    main()
