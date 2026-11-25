"""Monte Carlo of the tree sizing rules, in units of ROOT RISK (R = 1).

Rules simulated (from the design doc):
  - a winning node's NET profit P spawns two children
  - each child budget = P / 3 / 2  (one-third of profit, split two ways)
  - each child's planned loss = 50% of its budget, target = rr x planned loss
  - a losing node dies, and so do its unopened descendants
  - cost = round-trip trading cost as a fraction of each trade's risk

Usage:  python tree_sim.py
        python tree_sim.py --cost 0.15 --min-risk 0.2
"""
import argparse

import numpy as np


def run_tree(p, rr, cost, min_risk, rng):
    """Returns (net pnl of whole tree, trades taken, deepest level reached)."""
    pnl, trades, deepest = 0.0, 0, 0
    stack = [(1.0, 0)]                      # (risk of node, depth)
    while stack:
        risk, depth = stack.pop()
        if risk < min_risk:                 # below minimum lot: cannot be traded
            continue
        trades += 1
        deepest = max(deepest, depth)
        if rng.random() < p:
            net = (rr - cost) * risk
            pnl += net
            if net > 0:
                child_risk = 0.5 * (net / 3 / 2)
                stack += [(child_risk, depth + 1)] * 2
        else:
            pnl -= (1 + cost) * risk
    return pnl, trades, deepest


def analytic(p, rr, cost):
    root_ev = p * (rr - cost) - (1 - p) * (1 + cost)
    k = (rr - cost) / 12                    # child risk as a fraction of parent risk
    return root_ev, root_ev / (1 - 2 * p * k)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rr", type=float, default=3.0)
    ap.add_argument("--cost", type=float, default=0.10)
    ap.add_argument("--min-risk", type=float, default=0.0)
    ap.add_argument("--trees", type=int, default=100000)
    args = ap.parse_args()
    rng = np.random.default_rng(42)

    print(f"rr=1:{args.rr:g}  cost={args.cost:g}R per trade  min_risk={args.min_risk:g}R  "
          f"trees={args.trees}\n")
    print(f"{'win rate':>8} | {'root-only EV':>12} {'tree EV (sim)':>14} {'tree EV (math)':>15}"
          f" | {'avg trades':>10} {'P(tree>0)':>9} {'P(depth>=2)':>11} {'worst':>7}")
    print("-" * 100)
    for p in (0.20, 0.25, 0.30, 0.35, 0.40):
        res = [run_tree(p, args.rr, args.cost, args.min_risk, rng) for _ in range(args.trees)]
        pnl = np.array([r[0] for r in res])
        trades = np.array([r[1] for r in res])
        deep = np.array([r[2] for r in res])
        root_ev, tree_ev = analytic(p, args.rr, args.cost)
        print(f"{p:8.0%} | {root_ev:+12.3f} {pnl.mean():+14.3f} {tree_ev:+15.3f}"
              f" | {trades.mean():10.2f} {(pnl > 0).mean():9.1%} {(deep >= 2).mean():11.1%}"
              f" {pnl.min():+7.2f}")
    print("\nEV is in units of the root trade's risk (R). Break-even win rate "
          f"= (1+cost)/(rr+1) = {(1 + args.cost) / (args.rr + 1):.1%}")


if __name__ == "__main__":
    main()
