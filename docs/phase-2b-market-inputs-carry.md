# Phase 2B — Market Inputs & Implied Equity Carry Calibration

Status: **calibration/validation only.** Not wired into
`strategyScenarios.js`, ranking, or confidence.

Modules: `src/core/options/marketInputs/{marketInputTypes,rateNormalization,
impliedForward,impliedCarry}.js`. Tests: `tests/market_inputs.test.js` (26
tests). Live-data script: `scripts/phase2b-carry-calibration.mjs`. Frozen
fixture: `docs/fixtures/phase2b-market-inputs-20260829.json`.

## B — Discount sources

**Treasury**: U.S. Treasury `daily_treasury_bill_rates` CSV, **coupon-
equivalent** column (not bank-discount), observation date **2026-08-28**:
4wk 3.75%, 6wk 3.77%, 8wk 3.79%, 13wk 3.83%, 17wk 3.90%, 26wk 3.98%,
52wk 4.14%. Converted to continuous compounding via
`r_cc = ln(1 + CE·T)/T` (`rateNormalization.js`).

**SOFR**: NY Fed public API (`markets.newyorkfed.org/api/rates/secured/
sofr/last/5.json`), latest fixing **3.64%** (2026-08-27), labeled
`SOFR_OVERNIGHT_ANCHOR` — explicitly **not** treated as a term curve.
SOFR Averages endpoint returned no data in this environment (tried,
documented, not fabricated) — only the overnight fixing was used.

## C — Rate normalization

Treasury bill maturity bucket selected by nearest-maturity DTE midpoint
(e.g. 41 DTE → 6-week bill, nearest to 42 days). Both sources normalized to
continuously compounded decimals with full provenance
(`discount_rate_source`, `discount_rate_as_of`, `diagnostics`).

## D — Implied forward model

`syntheticForwardEstimate`: `F ≈ K + e^(rT)·(C_mid − P_mid)`, always
labeled `AMERICAN_OPTIONS_SYNTHETIC_FORWARD_ESTIMATE` with an
`AMERICAN_PARITY_APPROXIMATION` warning — American options don't obey
exact parity, so this is explicitly an approximation, never "true_forward."

## E — Carry estimators

**PARITY_IMPLIED_CARRY**: `q_eff = r − ln(F/S)/T` from the synthetic
forward, aggregated across matched strikes via a robust median (+ weighted
mean, MAD, IQR) — `robustCrossStrikeCarry`.

**CRR_IMPLIED_CARRY_FIT**: one common `effective_carry_yield` per
expiration, fit by golden-section search to minimize CRR_AMERICAN_V1
pricing SSE across a calibration set of call+put mids (IV/strike/rate held
fixed) — `fitCrrImpliedCarry`. Verified via a self-consistency unit test:
recovers a known synthetic `q=1.5%` to within 0.1bp from CRR-generated
mids.

## F — PANW results

| Expiry | DTE | r (Treasury) | Pairs (5%/20%) | Parity q (median) | CRR-fit q | Confidence |
|---|---|---|---|---|---|---|
| 2026-09-25 | 27 | 3.745% | 0 / 1 | −0.95% | −1.95% | LOW |
| 2026-10-09 | 41 | 3.762% | 0 / 1 | +3.42% | +2.31% | LOW |
| 2026-10-16 | 48 | 3.762% | 0 / 9 | +0.75% | −0.89% | MEDIUM |

**Critical finding, not anticipated in the plan:** at the spec's default
`max_spread_pct=5`, PANW yields **zero** qualifying matched pairs at every
expiration tested — real PANW option markets have spreads mostly in the
10–30% range (consistent with Phase 2A.1's findings). All PANW numbers
above use a widened, explicitly-diagnostic 20% threshold to have any data
to analyze at all — this is stated plainly, not hidden, and is itself the
single most actionable finding of this phase (Section O/P).

## G — PANW holdout error (MAE, $/contract, on held-out strikes only)

| Expiry | Model | Call MAE | Put MAE | All MAE |
|---|---|---|---|---|
| 27dte (n=1 calib/1 holdout — LOW conf) | q=0 | 0.726 | 0.406 | 0.566 |
| | parity q | 0.582 | 0.509 | 0.546 |
| | CRR-fit q | 0.431 | 0.616 | 0.524 |
| 41dte (n=1/1 — LOW conf) | q=0 | 0.589 | 1.917 | 1.253 |
| | parity q | 1.364 | 1.352 | 1.358 |
| | CRR-fit q | 1.121 | 1.538 | 1.330 |
| 48dte (n=5/4 — MEDIUM conf) | q=0 | 0.544 | 0.559 | 0.552 |
| | parity q | 0.710 | 0.397 | 0.553 |
| | CRR-fit q | 0.404 | 0.750 | 0.577 |

**Honest result: on PANW, neither carry estimator reliably beats `q=0` on
holdout MAE.** At 41dte (only 1 calibration pair — LOW confidence by
design), both fitted-q models are *worse* than the naive `q=0` baseline —
a textbook overfitting symptom the calibration/holdout split (Step 13) was
built specifically to catch, and it caught it. Only at 48dte (9 pairs,
MEDIUM confidence) is there enough data for the fit to be minimally
meaningful, and even there results are mixed (parity q ties q=0 on
all-MAE; CRR-fit q shifts error between call/put without net improvement).

## H — Call/put asymmetry (Step 18 key criterion)

| Symbol/expiry | Before (q=0) call/put MAE ratio | After (CRR-fit q) ratio |
|---|---|---|
| PANW 41dte | 0.31 (put >> call) | 0.73 |
| PANW 48dte | 0.97 (balanced already) | 0.54 (asymmetry *increased*) |
| AAPL 41dte | 1.28 | 1.99 (asymmetry increased) |
| NVDA 41dte | 0.32 (put >> call) | 0.78 (**asymmetry shrank materially**) |

Mixed: NVDA (7 pairs, MEDIUM confidence, the best-conditioned sample here)
shows the call/put gap shrinking substantially in the direction Phase 2A.1
hoped for. PANW 41dte also improves but off a 1-pair calibration set (not
trustworthy). PANW 48dte and AAPL show the opposite — asymmetry widening.
**No clean, unconditional win on Step 18's success criterion** — it holds
for the best-sampled case and not consistently elsewhere.

## I — AAPL results

DTE 41, 7 pairs (20% threshold; 0 at 5%), confidence MEDIUM. Parity q
**−0.54%**, CRR-fit q **−1.19%** (65bps apart, no `CARRY_ESTIMATORS_DISAGREE`
flag). For interpretation only: AAPL's known `dividend_yield_pct` ≈0.334%
(TradingView-native) — the fitted q_eff is *negative* and does not match
this, consistent with the spec's own expectation that q_eff need not equal
a plain dividend yield (it may embed carry/borrow/parity-wedge effects the
V1 model can't decompose). All-MAE improves modestly under CRR-fit q
(0.310→0.256) versus q=0.

## J — NVDA results

DTE 41, 7 pairs (20% threshold; 3 pairs even pass the strict 5% default —
the tightest market of the three symbols), confidence MEDIUM. Parity q
**+0.92%**, CRR-fit q **+0.72%** (only 20bps apart — the best agreement
between the two estimators of any symbol/expiry tested). This is also the
case with the clearest call/put-asymmetry improvement (Section H).

## K — Rate-source sensitivity

PANW 41dte: Treasury rate 3.762% → median q 3.42%; SOFR-anchor rate 3.640%
→ median q 3.30% — only **12bps** apart in the resulting q_eff. Because
q_eff absorbs the rate choice through the same forward equation, switching
discount-rate sources here barely moved the final carry estimate. This is
a reassuring, if single-sample, signal that the pipeline's *output* is not
dangerously sensitive to which of these two rate sources is chosen —
though this was only tested on one expiry/symbol and should not be
over-generalized.

## L — Carry estimator agreement

`CARRY_ESTIMATORS_DISAGREE` (>100bps) fired for **PANW 41dte** (111bps)
and **PANW 48dte** (164bps), but not for AAPL (65bps) or NVDA (20bps). The
disagreement correlates with pair count/confidence: the two lowest-pair-
count, LOWEST-confidence PANW expirations show the largest estimator
disagreement, and the best-sampled case (NVDA) shows the tightest
agreement — internally consistent evidence that more matched pairs produce
more trustworthy, mutually-consistent carry estimates, as the confidence
design intends.

## M — Market input snapshot design

Implemented as documentation only in `marketInputTypes.js`
(`MarketInputSnapshot` typedef) per Step 22's shape — `{ symbol, spot,
as_of_utc, discount_curve_source, discount_rate_by_expiry,
effective_carry_by_expiry: [...] }`. No provider populates this in Phase
2B.

## N — Limitations

- `effective_carry_yield` is **not** an observed borrow fee — it is what
  the option chain implies under an approximate American-parity model; no
  securities-lending feed was consulted (Step 21).
- American put-call parity is approximate for American-style contracts;
  every synthetic-forward output carries `AMERICAN_PARITY_APPROXIMATION`.
- Calibration mids are `CALIBRATION_MARK_MID` — a diagnostic mark, not an
  executable fill; unrelated to Phase 0A's execution-price assumptions.
- Discrete dividend timing/ex-dates are not modeled; carry is a single
  flat continuous yield per expiration.
- SOFR overnight is not a genuine term curve; it is used only as an anchor.
- Treasury bill coupon-equivalent rates are a proxy, not a proof of the
  market's actual funding/discount convention.
- No external securities-lending data source was integrated.
- **Sample sizes achieved here were small** (1–9 matched pairs per
  expiration after quality filters) — not enough to draw firm conclusions
  about estimator reliability; results should be treated as directional,
  not definitive.
- No production scenario-engine integration in this phase.

## O — Verdict

**B) MARKET INPUT MODEL PROMISING BUT NEEDS MORE CALIBRATION**

The machinery (rate normalization, matched-pair extraction, both carry
estimators, robust aggregation, confidence classification, calibration/
holdout evaluation) all work correctly and are unit-tested. But the live
results are genuinely mixed: the call/put asymmetry improvement Phase 2A.1
hoped to see held clearly only for the best-sampled symbol (NVDA); PANW
mostly failed to produce enough qualifying pairs at the spec's own 5%
default spread threshold to calibrate reliably at all, and where it did
(48dte, still only 9 pairs), the fit did not clearly beat the naive
`q=0` baseline on holdout. This is not a failure of the approach — it is
the calibration/holdout discipline (Step 13) doing exactly its job of
preventing a false "it works" claim from an overfit 1-pair sample.

## P — Recommended production inputs

- **Discount-rate source**: Treasury bill coupon-equivalent (Section B),
  continuous-compounding normalized — SOFR-overnight-anchor as a fallback/
  cross-check only (Section K shows they agree closely, so either is
  defensible, but Treasury bills better match the term structure of
  typical option DTEs).
- **Carry estimator**: neither `PARITY_IMPLIED_CARRY` nor
  `CRR_IMPLIED_CARRY_FIT` alone should be trusted below `MEDIUM`
  confidence (Section L shows disagreement concentrates exactly there).
  When both are `MEDIUM`+ confidence and agree within the 100bps threshold
  (Section E's `compareCarryEstimators`), prefer `CRR_IMPLIED_CARRY_FIT`
  since it directly targets the pricer that will consume it.
- **Fallback behavior**: below `MEDIUM` confidence or on
  `INSUFFICIENT_PAIRS`/`CARRY_ESTIMATORS_DISAGREE`, fall back to `q=0`
  (the Phase 2A default) rather than trusting a low-confidence fit — this
  phase's own PANW 41dte result shows a 1-pair fit can be *worse* than
  `q=0`.
- **Confidence requirement for any future production use**: require
  `HIGH` or `MEDIUM` per Section 11's thresholds, and widen the strike/
  delta window and pool multiple nearby expirations before treating a
  fitted q as reliable — Section N's small samples are the main blocker to
  calling this "ready."
