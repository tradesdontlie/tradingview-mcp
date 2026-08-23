"""
Reconfigures every strategy in strategies/asian_failed_breakout and
strategies/ny_open_strategies for SWING-sized targets instead of their
original intraday-scale ones, and reports which strategy/condition
combination actually produces working swing trades.

Swing targets (points are symbol-agnostic — MNQ1! is used as the data
source for "NQ" and MGC1! for "GC" since that's what's collected; the point
target itself applies the same to the full-size contract, just scaled by a
different point_value):
    MNQ1! ("NQ"): target 100pt, stop capped at 30pt   (R ~3.3)
    MGC1! ("GC"): target 20pt,  stop capped at 10pt   (R ~2.0)

For the two state-machine strategies (asian_failed_breakout,
ny_liquidity_sweep_reversal) this is just RiskConfig.target_mode=
"fixed_price" + target_price_points + max_risk_points — no entry-detection
logic changes. For vwap_reversion / ma9_trend_following /
opening_range_breakout, same idea via each strategy's own target_mode field.
Entry/setup DETECTION windows are left at their original (short, ~15-bar)
scale on purpose: what's being tested is "does a structurally-identical
signal sometimes run 100/20 points before it runs 30/10 the other way," not
a redesign of how each strategy finds its entries.

Run as a module from the repo root:
    python -m strategies.swing_sweep
"""
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

SWING = {
    "MNQ1!": {"target_points": 100.0, "max_risk_points": 30.0},
    "MGC1!": {"target_points": 20.0, "max_risk_points": 10.0},
}


def swing_asian_cfg(target_points, max_risk_points) -> AsianConfig:
    cfg = AsianConfig()
    cfg.risk.target_mode = "fixed_price"
    cfg.risk.target_price_points = target_points
    cfg.risk.max_risk_points = max_risk_points
    return cfg


def run_all(symbol: str) -> dict:
    sw = SWING[symbol]
    results = {}

    cfg_asian = swing_asian_cfg(sw["target_points"], sw["max_risk_points"])
    df = run_asian(symbol, cfg_asian, days=None)
    results["asian_failed_breakout"] = summarize_asian(df)

    cfg_ny = swing_asian_cfg(sw["target_points"], sw["max_risk_points"])
    df_ny = ny_sweep.run_backtest(symbol, cfg_ny, days=None)
    results["ny_liquidity_sweep_reversal"] = ny_sweep.summarize(df_ny)

    vwap_cfg = vwap.VWAPReversionConfig(target_mode="fixed_price", target_price_points=sw["target_points"])
    vwap_cfg.risk.max_risk_points = sw["max_risk_points"]
    results["vwap_reversion"] = summarize_generic(vwap.run_backtest(symbol, vwap_cfg, days=None))

    ma9_cfg = ma9.MA9TrendConfig(target_mode="fixed_price", target_price_points=sw["target_points"])
    ma9_cfg.risk.max_risk_points = sw["max_risk_points"]
    results["ma9_trend_following"] = summarize_generic(ma9.run_backtest(symbol, ma9_cfg, days=None))

    orb_cfg = orb.ORBConfig(target_mode="fixed_price")
    orb_cfg.risk.max_risk_points = sw["max_risk_points"]
    orb_cfg.target_price_points = sw["target_points"]  # ORBConfig itself carries this field per its own module
    results["opening_range_breakout"] = summarize_generic(orb.run_backtest(symbol, orb_cfg, days=None))

    return results


def main():
    all_results = {}
    for symbol in SWING:
        all_results[symbol] = run_all(symbol)

    print(json.dumps(all_results, indent=2, default=str))

    print("\n=== Swing-target summary ===", file=sys.stderr)
    print(f"{'symbol':<8} {'strategy':<28} {'trades':>7} {'win%':>7} {'PF':>7} {'avgR':>7} {'total$':>10}", file=sys.stderr)
    for symbol, results in all_results.items():
        for name, r in results.items():
            n = r.get("n_trades_filled", 0)
            wr = f"{r.get('win_rate', 0) * 100:.1f}" if r.get("win_rate") is not None else "-"
            pf = f"{r.get('profit_factor'):.2f}" if r.get("profit_factor") is not None else "-"
            avgr = f"{r.get('avg_r_multiple'):.2f}" if r.get("avg_r_multiple") is not None else "-"
            total = f"{r.get('total_pnl_dollars'):.0f}" if r.get("total_pnl_dollars") is not None else "-"
            print(f"{symbol:<8} {name:<28} {n:>7} {wr:>7} {pf:>7} {avgr:>7} {total:>10}", file=sys.stderr)


if __name__ == "__main__":
    main()
