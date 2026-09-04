# Phase 2A — American Option Pricer Benchmark & Calibration

Status: **benchmark/calibration only** — `CRR_AMERICAN_V1` is NOT wired into
`options_analyze_directional`, `strategyScenarios.js`, ranking, or confidence
in this phase. Production repricing remains `LOCAL_GREEK_APPROXIMATION`.

## Modules

- `src/core/options/pricing/pricingTypes.js` — shared constants/validators,
  and the (unimplemented) `MarketRateInput` shape for a future rate/dividend
  provider.
- `src/core/options/pricing/blackScholes.js` — closed-form Black-Scholes-
  Merton EUROPEAN reference pricer. Reference/invariant-testing only, not a
  production model (US equity/ETF options are American-style).
- `src/core/options/pricing/crrAmerican.js` — Cox-Ross-Rubinstein binomial
  AMERICAN pricer, V1. Price only, no Greeks (Step 19). Continuous dividend
  yield only (Step 6).

No TradingView/CDP imports in either module; no QuantLib runtime dependency.

## Convergence study (`scripts/benchmark-crr-american.mjs`)

Three fixtures (ATM put no-div, ITM call div-bearing, OTM put div-bearing),
steps ∈ {50,100,200,400,800,1600}, error measured vs. the 1600-step price:

| Steps | ATM put diff | ITM call diff | OTM put diff | time (ATM put, ms) |
|---|---|---|---|---|
| 50 | 0.0233 | 0.0130 | 0.0054 | 0.65 |
| 100 | 0.0111 | 0.0103 | 0.0151 | 1.63 |
| 200 | 0.0052 | 0.0010 | 0.0073 | 1.32 |
| 400 | 0.0022 | 0.0009 | 0.0014 | 4.27 |
| 800 | 0.0007 | 0.0010 | 0.0027 | 15.61 |
| 1600 | 0.0000 | 0.0000 | 0.0000 | 62.90 |

200 steps keeps every fixture's convergence error under the $0.02 target
while running in ~0.6–1.3ms per price.

## Throughput

| Steps | 1 option | 100 options | 500 options |
|---|---|---|---|
| 100 | 0.23ms | 17.3ms (0.17ms/opt) | 81.4ms (0.16ms/opt) |
| 200 | 0.60ms | 62.2ms (0.62ms/opt) | 306.3ms (0.61ms/opt) |
| 400 | 2.45ms | 242.0ms (2.42ms/opt) | 1195.4ms (2.39ms/opt) |

At 200 steps, repricing 500 candidates × 3 scenarios × 2 legs (a plausible
upper bound for the current directional-analysis universe) is ≈1.8s —
acceptable for a synchronous MCP tool call, though this was not integrated
or load-tested end-to-end in Phase 2A.

## Live calibration — PANW (no/negligible dividend), 2026-08-29

Spot (quote_get): $371.59. Treasury rates used (Step 13, U.S. Treasury daily
par yield curve, observation date **2026-08-28**, most recent available):
2 Mo = 3.86%, 3 Mo = 3.90%, 6 Mo = 4.02%. Mapping: ≤45 DTE → 2 Mo, 46–105
DTE → 3 Mo (per spec's 46–105 bucket; no contract fell in the 106–225 or
>225 buckets here). `dividend_yield = 0` (PANW pays no cash dividend).
22 contracts (15 call, 7 put), DTE 20–83, `steps = 200`.

Full per-contract table: see `scripts/panw-calibration-output.txt` (raw
script output archived below in this doc's git history / reproducible via
`options_get_chain` + the script in this file's companion commit).

Summary:
- MAE: **$0.4926**
- Median: **$0.4327**
- P95: **$1.3475**
- Max: **$1.6503**
- CALL (n=15): MAE $0.2573
- PUT (n=7): MAE $0.9968
- ITM (n=7): MAE $0.7171 · ATM (n=5): MAE $0.2482 · OTM (n=10): MAE $0.4577
- ≤27 DTE (n=9): MAE $0.2558 · >27 DTE (n=13): MAE $0.6565

**Systematic bias found:** CRR_AMERICAN_V1 prices every put in this sample
*below* TradingView's `theoretical_price`, and the gap widens with DTE
(farther-dated contracts have ~2.6x the near-dated MAE). Calls are much
closer (MAE $0.26 vs $1.00 for puts). No IV was tuned to force agreement —
TradingView's per-contract IV was used as-is. Plausible causes (not
verified further in Phase 2A): TradingView's own theoretical-price model may
use a different discount rate curve/convention, a small implied borrow/carry
adjustment, or a different exercise-boundary approximation than a plain
200-step CRR tree; put-side American exercise premium is also inherently
harder to approximate at moderate step counts. Reported, not hidden or
tuned away (Step 17).

## Live calibration — AAPL (dividend-paying), 2026-08-29

Spot (`data_get_key_stats`): $319.70. `dividend_yield_pct` = 0.3338%
(TradingView-native field) → used as `dividend_yield = 0.0033778`, marked
**DIVIDEND_YIELD_APPROXIMATION** — this is an annualized continuous-yield
approximation, not a discrete ex-dividend-date model (Step 16). Same
Treasury-rate mapping. 10 contracts (5 call, 5 put), DTE 20–83, `steps = 200`.

Summary:
- MAE: **$0.2659**
- Median: **$0.2233**
- P95 / Max: **$0.7583** (single outlier: 83 DTE ITM-ish call, AAPL261120C305.0)

Errors are smaller and more evenly distributed between calls and puts than
the PANW sample; the one outlier is the farthest-dated (83 DTE) contract,
consistent with the DTE-correlated error growth also seen in PANW.

## Early-exercise validation (Step 18)

`priceCrrAmerican(..., { diagnostics: true })` exposes
`early_exercise_node_count` in test/debug mode only (never in the default
production-shaped output). Verified in `tests/pricing_crr_american.test.js`:
- A deep ITM American put (S=50, K=100) shows early-exercise nodes > 0.
- A deep ITM American call on a high-dividend-yield underlying (q=8%,
  S=150, K=90) shows early-exercise nodes > 0, and prices above the
  corresponding European call.
- A far-OTM, near-expiry call shows exactly 0 early-exercise nodes (sanity
  check that the diagnostic isn't spuriously firing).

## Limitations

- Continuous dividend yield only — no discrete dividend/ex-date model.
- Adjusted/non-standard option contracts are unsupported; V1 assumes
  standard US equity/ETF American-style exercise (Step 7) and does not
  itself detect or validate exercise style.
- The Treasury-rate DTE bucket mapping (Step 13) is a benchmark heuristic
  only, not integrated as a production rate source.
- TradingView's `theoretical_price` methodology (rate curve, dividend
  handling, tree/analytic method) is not fully documented to us — it is a
  useful external benchmark, not ground truth; discrepancies were reported,
  not tuned away.
- No CRR-derived Greeks yet (Step 19) — existing TradingView Greeks are
  untouched and remain the only Greeks source in production.
- Not integrated into the scenario engine, ranking, confidence, or
  `options_analyze_directional` in this phase (Step 20).
- No independently-sourced third-party published American-option price
  table was available offline; American-specific fixtures in
  `tests/pricing_crr_american.test.js` are validated via convergence and
  theoretical invariants (Hull-style put/call bounds, Merton's theorem for
  the non-dividend boundary case), not a third-party table — documented in
  that file's header comment.
