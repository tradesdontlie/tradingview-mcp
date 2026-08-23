"""
Compares every strategy across two dimensions: SESSION (asian vs ny) and
TARGET TIER (scalp vs swing), for a given symbol.

"Liquidity sweep" strategy per session uses whichever engine is actually
native to that session — strategies/asian_failed_breakout for Asian,
strategies/ny_open_strategies/liquidity_sweep_reversal for NY — since
those already ARE the session-specific variants of the same state machine,
rather than building a third redundant copy.

Run as a module from the repo root:
    python -m strategies.session_tier_sweep --symbol MNQ1! --scalp 30 10 --swing 100 30
    python -m strategies.session_tier_sweep --symbol MGC1! --scalp 10 5 --swing 20 10
"""
import argparse
import json
import sys

from .asian_failed_breakout.backtest import run_backtest as run_asian
from .asian_failed_breakout.backtest import summarize as summarize_asian
from .asian_failed_breakout.config import StrategyConfig as AsianConfig
from .ny_open_strategies import liquidity_sweep_reversal as ny_sweep
from .ny_open_strategies import ma9_trend_following as ma9
from .ny_open_strategies import opening_range_breakout as orb
from .ny_open_strategies import vwap_reversion as vwap
from .ny_open_strategies.common import summarize as summarize_generic


def sweep_asian_cfg(target_points, max_risk_points) -> AsianConfig:
    cfg = AsianConfig()
    cfg.risk.target_mode = "fixed_price"
    cfg.risk.target_price_points = target_points
    cfg.risk.max_risk_points = max_risk_points
    return cfg


def run_liquidity_sweep(symbol: str, session: str, tier: dict):
    cfg = sweep_asian_cfg(tier["target_points"], tier["max_risk_points"])
    if session == "asian":
        df = run_asian(symbol, cfg, days=None)
        return summarize_asian(df)
    else:
        df = ny_sweep.run_backtest(symbol, cfg, days=None)
        return ny_sweep.summarize(df)


def run_vwap(symbol: str, session: str, tier: dict):
    cfg = vwap.VWAPReversionConfig(target_mode="fixed_price", target_price_points=tier["target_points"])
    cfg.risk.max_risk_points = tier["max_risk_points"]
    return summarize_generic(vwap.run_backtest(symbol, cfg, days=None, session=session))


def run_ma9(symbol: str, session: str, tier: dict):
    cfg = ma9.MA9TrendConfig(target_mode="fixed_price", target_price_points=tier["target_points"])
    cfg.risk.max_risk_points = tier["max_risk_points"]
    return summarize_generic(ma9.run_backtest(symbol, cfg, days=None, session=session))


def run_orb(symbol: str, session: str, tier: dict):
    cfg = orb.ORBConfig(target_mode="fixed_price", target_price_points=tier["target_points"])
    cfg.risk.max_risk_points = tier["max_risk_points"]
    return summarize_generic(orb.run_backtest(symbol, cfg, days=None, session=session))


STRATEGIES = {
    "liquidity_sweep": run_liquidity_sweep,
    "vwap_reversion": run_vwap,
    "ma9_trend_following": run_ma9,
    "opening_range_breakout": run_orb,
}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="MNQ1!")
    parser.add_argument("--scalp", nargs=2, type=float, metavar=("TARGET_PTS", "MAX_RISK_PTS"), default=[30.0, 10.0])
    parser.add_argument("--swing", nargs=2, type=float, metavar=("TARGET_PTS", "MAX_RISK_PTS"), default=[100.0, 30.0])
    args = parser.parse_args()

    symbol = args.symbol
    tiers = {
        "scalp": {"target_points": args.scalp[0], "max_risk_points": args.scalp[1]},
        "swing": {"target_points": args.swing[0], "max_risk_points": args.swing[1]},
    }

    results = {}
    for strat_name, fn in STRATEGIES.items():
        for session in ("asian", "ny"):
            for tier_name, tier in tiers.items():
                key = f"{strat_name} | {session} | {tier_name}"
                results[key] = fn(symbol, session, tier)

    print(json.dumps(results, indent=2, default=str))

    print(f"\n=== {symbol} — strategy x session x tier "
          f"(scalp={tiers['scalp']['target_points']:.0f}pt/{tiers['scalp']['max_risk_points']:.0f}pt, "
          f"swing={tiers['swing']['target_points']:.0f}pt/{tiers['swing']['max_risk_points']:.0f}pt) ===", file=sys.stderr)
    print(f"{'strategy':<24} {'session':<7} {'tier':<7} {'trades':>7} {'win%':>7} {'PF':>7} {'avgR':>7} {'total$':>10}",
          file=sys.stderr)
    for key, r in results.items():
        strat, session, tier = [s.strip() for s in key.split("|")]
        n = r.get("n_trades_filled", 0)
        wr = f"{r.get('win_rate', 0) * 100:.1f}" if r.get("win_rate") is not None else "-"
        pf = f"{r.get('profit_factor'):.2f}" if r.get("profit_factor") is not None else "-"
        avgr = f"{r.get('avg_r_multiple'):.2f}" if r.get("avg_r_multiple") is not None else "-"
        total = f"{r.get('total_pnl_dollars'):.0f}" if r.get("total_pnl_dollars") is not None else "-"
        print(f"{strat:<24} {session:<7} {tier:<7} {n:>7} {wr:>7} {pf:>7} {avgr:>7} {total:>10}", file=sys.stderr)


if __name__ == "__main__":
    main()
