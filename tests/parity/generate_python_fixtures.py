"""Generate Python-side numerical fixtures for tradingview-mcp parity tests.

USAGE (manual, one-time per Python implementation change in siyolah-v3):

    python C:\\Users\\User\\tradingview-mcp\\tests\\parity\\generate_python_fixtures.py

Requires:
  - siyolah-v3 checked out at C:\\Users\\User\\siyolah-v3 (override via env SIYOLAH_ROOT)
  - Python with numpy, scipy, statsmodels installed (siyolah-v3's own env works)

Writes:
    tests/parity/fixtures/pbo.json
    tests/parity/fixtures/hac.json
    tests/parity/fixtures/dsr.json

After regenerating, run `npm run test:parity` from the tradingview-mcp root.
"""
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
from scipy.stats import norm, skew as sp_skew, kurtosis as sp_kurt

HERE = Path(__file__).resolve().parent
FIXTURES_DIR = HERE / "fixtures"
SIYOLAH_ROOT = Path(os.environ.get("SIYOLAH_ROOT", r"C:\Users\User\siyolah-v3"))


def main() -> int:
    if not SIYOLAH_ROOT.exists():
        sys.exit(f"siyolah-v3 not found at {SIYOLAH_ROOT}; set SIYOLAH_ROOT env or check out the repo.")
    sys.path.insert(0, str(SIYOLAH_ROOT))
    try:
        from scripts.inference_upgrades import pbo_cscv, newey_west_se, deflated_sharpe_ratio
    except ImportError as e:
        sys.exit(f"Could not import from siyolah-v3 scripts.inference_upgrades: {e}\n"
                 f"Make sure SIYOLAH_ROOT={SIYOLAH_ROOT} is correct and dependencies are installed.")

    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed=42)

    # ── PBO/CSCV ──────────────────────────────────────────────────────────
    T, N = 200, 8
    pnl = rng.normal(loc=0.0002, scale=0.01, size=(T, N))
    pbo_value = pbo_cscv(pnl, n_slices=8)
    with (FIXTURES_DIR / "pbo.json").open("w", encoding="utf-8") as f:
        json.dump({
            "input": {"n_slices": 8, "pnl_matrix": pnl.tolist()},
            "expected": {"pbo": float(pbo_value)},
            "tolerance": 1e-12,
            "note": "pbo_cscv from siyolah-v3 scripts/inference_upgrades.py, seed=42.",
        }, f)

    # ── HAC (intercept-only Newey-West) ───────────────────────────────────
    n = 120
    e = rng.normal(loc=0.0, scale=0.02, size=n)
    r = np.zeros(n)
    r[0] = 0.005 + e[0]
    for t in range(1, n):
        r[t] = 0.005 + 0.3 * r[t - 1] + e[t]
    X = np.ones((n, 1))
    hac = newey_west_se(X, r)
    coef = float(hac["params"][0])
    se = float(hac["se"][0])
    tz = float(hac["tstat"][0])
    breakeven = 0.001
    t_be = (coef - breakeven) / se
    p_zero = float(1.0 - norm.cdf(tz))
    p_be = float(1.0 - norm.cdf(t_be))
    with (FIXTURES_DIR / "hac.json").open("w", encoding="utf-8") as f:
        json.dump({
            "input": {
                "returns": r.tolist(),
                "breakeven": breakeven,
                "maxlags": int(hac["bandwidth"]),
            },
            "expected": {
                "mean": coef,
                "hac_se": se,
                "t_zero": tz,
                "t_breakeven": float(t_be),
                "p_one_sided_zero": p_zero,
                "p_one_sided_breakeven": p_be,
                "lag_used": int(hac["bandwidth"]),
            },
            # Mean/SE/t-stat are pure arithmetic — tight tolerance.
            # P-values depend on norm.cdf which JS approximates via A&S 7.1.26.
            "tolerance_arith": 1e-10,
            "tolerance_cdf": 1e-6,
            "note": "newey_west_se on intercept-only X for AR(1) returns, seed=42.",
        }, f)

    # ── DSR (canonical) ────────────────────────────────────────────────────
    n_trials = 80
    sr_variance = 0.005
    skew_v = float(sp_skew(r, bias=False))
    kurt_v = float(sp_kurt(r, fisher=False, bias=False))
    dsr_value = deflated_sharpe_ratio(r, n_trials=n_trials, sr_variance=sr_variance,
                                       skew=skew_v, kurt=kurt_v)
    sd = float(np.std(r, ddof=1))
    sharpe = float(np.mean(r) / sd)
    EULER = 0.5772156649015329
    z1 = float(norm.ppf(1.0 - 1.0 / n_trials))
    z2 = float(norm.ppf(1.0 - 1.0 / (n_trials * math.e)))
    sr0 = math.sqrt(sr_variance) * ((1.0 - EULER) * z1 + EULER * z2)
    with (FIXTURES_DIR / "dsr.json").open("w", encoding="utf-8") as f:
        json.dump({
            "input": {
                "returns": r.tolist(),
                "n_trials": n_trials,
                "sr_variance": sr_variance,
                "skew": skew_v,
                "kurt": kurt_v,
            },
            "expected": {
                "dsr": float(dsr_value),
                "sharpe": sharpe,
                "expected_max_sharpe_under_null": float(sr0),
                "skew_used": skew_v,
                "kurt_used": kurt_v,
                "sr_variance_used": sr_variance,
            },
            # Cumulative error from Acklam probit (~1.15e-9 × 2) + A&S norm.cdf (~7.5e-8).
            "tolerance": 1e-6,
            "note": "deflated_sharpe_ratio with sr_variance > 0 (no PSR fallback). Same AR(1) returns as hac.json.",
        }, f)

    print(f"Wrote fixtures to {FIXTURES_DIR}")
    for name in ("pbo.json", "hac.json", "dsr.json"):
        print(f"  {name}: {(FIXTURES_DIR / name).stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
