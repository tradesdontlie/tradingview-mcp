#!/usr/bin/env python3
"""Prove the contract gate actually fires.

    python3 tests/test_contract.py

Reads the last bake from public/api/, asserts it is clean, then injects one
breakage at a time and requires validate.py to catch each. A gate that never
fires is not a gate.
"""
import copy, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib"))
from validate import validate_all  # noqa: E402

ENDPOINTS = ["regime-gauge", "scorecard", "credit-stress", "vol-stress-radar", "macro",
             "smart-money", "analyst-research", "market-pulse", "backtest", "alerts",
             "summary", "freshness"]

CASES = [
    ("regime score out of range",
     lambda p: p["regime-gauge"].__setitem__("score", 142.0)),
    ("regime trend not an enum",
     lambda p: p["regime-gauge"].__setitem__("trend", "Rising")),
    ("null price with no gapReason",
     lambda p: p["scorecard"]["assets"][0].update(price=None, gapReason=None)),
    ("sparkline holds a null",
     lambda p: p["scorecard"]["assets"][0]["sparkline"].append(None)),
    ("credit stressLabel invalid",
     lambda p: p["credit-stress"].__setitem__("stressLabel", "Wider")),
    ("radar tier invalid",
     lambda p: p["vol-stress-radar"].__setitem__("tier", "RED")),
    ("radar tell missing weight",
     lambda p: p["vol-stress-radar"]["tells"][0].pop("weight")),
    ("tell with neither status nor gap",
     lambda p: p["vol-stress-radar"]["tells"][0].update(status=None, gapReason=None)),
    ("backtest claims data but has no curve",
     lambda p: p["backtest"]["results"][0].update(gapReason=None, curve=[])),
    ("backtest stat became a string",
     lambda p: p["backtest"]["results"][0]["strategy"].__setitem__("cagrPct", "8.4")),
    ("alert severity invalid",
     lambda p: p["alerts"]["alerts"].append(
         {"id": "x", "severity": "critical", "message": "m", "detectedAt": "t"})),
    ("duplicate alert ids",
     lambda p: p["alerts"]["alerts"].extend(
         [{"id": "dup", "severity": "info", "message": "m", "detectedAt": "t"}] * 2)),
    ("freshness level invalid",
     lambda p: p["freshness"]["sources"][0].__setitem__("level", "fresh")),
    ("summary sentence not a string",
     lambda p: p["summary"].__setitem__("sentence", 42)),
]


def main():
    api = os.path.join(ROOT, "public", "api")
    missing = [n for n in ENDPOINTS if not os.path.isfile(os.path.join(api, n))]
    if missing:
        print(f"no baked output to test against (missing {missing}) — run bake.py first")
        return 1

    good = {n: json.load(open(os.path.join(api, n), encoding="utf-8")) for n in ENDPOINTS}
    baseline = validate_all(good)
    if baseline:
        for err in baseline:
            print(f"  FAIL baseline: {err}")
        return 1
    print("  ok   baseline payloads are clean")

    failures = 0
    for name, break_it in CASES:
        probe = copy.deepcopy(good)
        try:
            break_it(probe)
            errs = validate_all(probe)
        except Exception as exc:  # noqa: BLE001 - a raise is also a catch
            errs = [f"raised {type(exc).__name__}"]
        if errs:
            print(f"  ok   caught: {name}")
        else:
            print(f"  FAIL missed: {name}")
            failures += 1

    print(f"\ntest_contract: {len(CASES) - failures}/{len(CASES)} breakages caught")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
