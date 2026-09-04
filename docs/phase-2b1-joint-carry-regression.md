# Phase 2B.1 — Joint Discount Rate + Effective Carry Estimation

Status: **calibration/validation only.** Not wired into
`strategyScenarios.js`, ranking, confidence, or `options_analyze_directional`.

New module: `src/core/options/marketInputs/jointCarryRegression.js`. Tests:
`tests/joint_carry_regression.test.js` (18 tests). Live scripts:
`scripts/phase2b1-joint-carry-live.mjs` (reuses the Phase 2B fixture) —
see Section J for why a genuinely independent second snapshot could not be
obtained this session.

## B — Regression model

`fitRawParityJoint`: weighted OLS of `Y_i = C_mid − P_mid` on `X_i = strike`
per expiration (never pooled across expiries — Step 1), `B ≈ −DF`,
`A ≈ S·e^{-qT}`, `r = -ln(DF)/T`, `q = -ln(A/S)/T`. One round of MAD-based
outlier rejection + a single refit (never iterated to a desired answer).
Weights combine spread tightness and ATM-ness (`pairCalibrationWeight`),
capped at an 8x max ratio so no single pair dominates. Broad diagnostic
bounds (`r ∈ [-2%,15%]`, `q ∈ [-20%,20%]`) are enforced with an explicit
`ESTIMATOR_BOUND_HIT` flag rather than silent clamping-and-forgetting.

## C — American exercise correction

`europeanizePairs` computes each leg's CRR early-exercise premium
(American − CRR-European) under a provisional `(r,q)` and subtracts it
from the market mid (never mutating the original mid — unit-tested).
`fitAmericanCorrectedJointCarry` alternates: (1) Europeanize under current
`(r,q)`, (2) re-fit the joint regression on Europeanized mids, until
`|Δr|<1bp` and `|Δq|<1bp` or `maxIterations` (default 10) is reached.
Non-convergence is reported as `JOINT_ESTIMATOR_NOT_CONVERGED`, never
silently presented as a converged HIGH-confidence result.

## D — Synthetic recovery test

Generated 10 strikes' European call/put mids from Black-Scholes at known
**true r=4%, true q=1.5%** (tight $0.02 synthetic spread), then fit.

- True r: 4.000% → **Estimated r: 4.000%** (within 0.1bp, R²>0.999)
- True q: 1.500% → **Estimated q: 1.500%** (within 0.1bp)

A second fixture (deep-ITM American puts, CRR-generated) confirms the
American-exercise correction reduces `|r̂−r|+|q̂−q|` versus the raw-parity
fit, and converges. A dedicated non-convergence test (extreme starting
point, 1 iteration allowed, microscopic tolerance) confirms the estimator
correctly reports `converged:false` rather than fabricating a result.

## E — Calibration liquidity tiers

STRICT (≤5% leg spread) → STANDARD (≤10%) → DIAGNOSTIC (≤20%), tried in
that order, falling back only when the stricter tier lacks `minPairs`.
`selectCalibrationTier` never silently reports a tier tighter than what
actually qualified.

## F — PANW (term structure across 3 expiries, single live session)

| Expiry | DTE | Pairs | Tier | Implied r | Implied q | Confidence |
|---|---|---|---|---|---|---|
| 2026-09-25 | 27 | 2 | DIAGNOSTIC | 2.93% | −2.03% | LOW |
| 2026-10-09 | 41 | 1 | DIAGNOSTIC | — | — | **INSUFFICIENT_PAIRS** |
| 2026-10-16 | 48 | 10 (7 retained) | DIAGNOSTIC | **−2.00%** (bound hit) | −8.00% | LOW |

Every PANW expiration stayed at the DIAGNOSTIC tier (never reached STRICT
or STANDARD even with the wider strike window used here). The 48dte fit
hit the discount-rate lower bound exactly (−2.00%) — flagged, not hidden.
A `TERM_STRUCTURE_DISCONTINUITY` was flagged between 27dte and 48dte
(Δr≈493bp, Δq≈597bp) — far too large to reflect a real term structure;
this reads as estimation noise from tiny (2–10 pair) samples, not a
genuine market signal.

## G — NVDA

| Expiry | DTE | Pairs | Tier | Implied r | Implied q | Confidence |
|---|---|---|---|---|---|---|
| 2026-10-09 | 41 | 7 (5 retained) | **STANDARD** | **15.00%** (bound hit) | 14.90% | MEDIUM* |

NVDA reached STANDARD tier (best-conditioned name here, consistent with
Phase 2B) and nominally MEDIUM confidence — but the fitted rate landed
*exactly* on the 15% upper bound. `classifyJointConfidence`'s MEDIUM tier
does not require `!bound_hit` (only HIGH does, per the frozen Step 16
spec) — this is a real gap the thresholds allow: a bound-clamped fit can
still read MEDIUM. **This result should be treated with the same
skepticism as a LOW-confidence one**, and is flagged explicitly here
rather than presented as a clean win. Phase 2B's ~20bp parity/CRR-fit
agreement on NVDA did **not** repeat under the joint estimator on this
tiny 2-pair holdout.

## H — AAPL

| Expiry | DTE | Pairs | Tier | Implied r | Implied q | Confidence |
|---|---|---|---|---|---|---|
| 2026-10-09 | 41 | 8 (6 retained) | DIAGNOSTIC | 5.64% | −0.03% (raw fit hit both bounds first) | LOW |

The American-corrected fit did not converge within 10 iterations
(`converged:false`). Raw parity alone hit both bounds (`r=−2.00%`,
`q=−20.00%`) before correction. Joint estimation did **not** cleanly
resolve AAPL's Phase 2B negative-q_eff finding — it replaced one uncertain
negative number with a different, non-converged one.

## I — Holdout comparison (Model A vs Model C, same holdout contracts)

| Symbol/Expiry | Model | Call MAE | Put MAE | All MAE | C/P Ratio |
|---|---|---|---|---|---|
| PANW 27dte | A (Treasury, q=0) | 0.454 | 0.288 | 0.371 | 1.58 |
| | C (joint r,q) | 0.314 | 0.314 | **0.314** | **1.00** |
| PANW 48dte | A | 0.483 | 0.558 | **0.521** | 0.87 |
| | C | 0.549 | 0.810 | 0.679 (**worse**) | 0.68 |
| AAPL 41dte | A | 0.286 | 0.198 | 0.242 | 1.44 |
| | C | 0.217 | 0.249 | 0.233 (~4% better) | 0.87 |
| NVDA 41dte | A | 0.131 | 0.158 | **0.144** | 0.83 |
| | C | 0.466 | 0.101 | 0.679 (**much worse**) | **4.61** (bound-clamped fit) |

Model B (Treasury r + Phase 2B's separate CRR-fit q) is carried over
qualitatively from the Phase 2B report rather than re-run here, since
Phase 2B already showed it performs between A and C depending on sample.

**Every holdout set here has only 2–3 pairs (4–6 contracts)** — too small
to draw a statistically meaningful conclusion either way; this table is
reported for transparency, not as proof of anything.

## J — Multi-snapshot stability

**Not achieved as specified.** The plan called for ≥5 independent
snapshots per symbol. A fresh live pull was attempted today (2026-08-30)
for PANW's 2026-10-16 chain: bid/ask/IV/theoretical_price were **byte-for-
byte identical** to the 2026-08-29 snapshot (only `days_to_expiry` ticked
down by 1 and `retrieved_at_utc` advanced) — the underlying market session
had not actually advanced (weekend/no new trading) between the two pulls.
**Genuine snapshot-to-snapshot stability could not be tested this
session.** This is reported plainly rather than fabricating synthetic
"stability" numbers from a single underlying data point re-labeled as two
snapshots. Sections F–I above all derive from the **single** live market
session collected across Phase 2B and Phase 2B.1.

## K — Term structure

See Section F: one `TERM_STRUCTURE_DISCONTINUITY` flagged for PANW
(27dte→48dte, ~493bp Δr). With only 2–3 usable expiries and 1–10 pairs
each, this cannot yet be distinguished from small-sample estimation noise
versus a genuine funding/carry term structure.

## L — External rate comparison

| Symbol/expiry | option_implied_discount_rate (joint, American-corrected) | Treasury | SOFR | vs Treasury (bp) |
|---|---|---|---|---|
| PANW 27dte | 2.93% | 3.75% | 3.64% | −82 |
| PANW 48dte | −2.00%* | 3.76% | 3.64% | −576 |
| AAPL 41dte | 5.64%† | 3.76% | 3.64% | +188 |
| NVDA 41dte | 15.00%* | 3.76% | 3.64% | +1124 |

(*bound-clamped, †not converged — none of these four differences should
be read as a genuine funding-rate signal; per Step 17, `option_implied_
discount_rate` is a model-implied nuisance parameter, not the market's
real risk-free rate, and three of the four values here are flagged as
unreliable by the estimator's own diagnostics.)

## M — Discrete dividend diagnostic

No ex-dividend-date metadata is available anywhere in this project's
existing data sources (checked `data_get_key_stats` and the options chain
responses used throughout Phases 2A–2B.1 — neither exposes an ex-dividend
date field). Per Step 18: **unavailable, skipped, not invented.** AAPL and
NVDA's `DISCRETE_DIVIDEND_WINDOW` flag could not be evaluated.

## N — Confidence V2

Thresholds (frozen before this live run, Section E of the module):
HIGH requires ≥8 retained pairs, STRICT/STANDARD tier, R²≥0.95,
residual MAD≤0.05, converged, no bound hit. MEDIUM requires ≥5 retained
pairs, converged, MAD≤0.15. Observed today: **zero HIGH results**; one
MEDIUM (NVDA, but bound-clamped — see Section G caveat); everything else
LOW or INSUFFICIENT_PAIRS. The confidence system itself is behaving
correctly (it is *supposed* to stay LOW on 1–10-pair diagnostic-tier
fits) — the honest reading is that **today's live data simply doesn't
support a HIGH-confidence joint estimate for any symbol/expiry tested.**

## O — Limitations

- American parity remains a model-assisted approximation, even after the
  CRR correction (which itself depends on CRR's own IV/rate inputs).
- Fitted `option_implied_discount_rate` is **not** necessarily the true
  risk-free rate — see Section L, where three of four fits are flagged
  unreliable by the estimator's own diagnostics.
- `effective_carry_yield` is **not** a directly observed borrow/dividend
  rate (Step 17/21) — it is a nuisance parameter reconciling option prices
  under this model.
- Calibration uses bid/ask mid, not an executable price.
- Discrete dividends are not modeled; no ex-dividend metadata was even
  available to check the window diagnostic (Section M).
- No volume/OI dependency anywhere in this pipeline.
- **Sample liquidity severely limited estimation this session**: 1–10
  matched pairs per expiry, holdout sets of 2–3 pairs, and DIAGNOSTIC-tier
  results almost throughout.
- Multi-snapshot stability (Steps 11/12) could not be tested — only one
  live market session was available (Section J).
- No production integration.

## P — Verdict

**C) NOT RELIABLE** (for production-readiness / shadow-testing purposes,
by the pre-registered Step 15 criteria)

The Step 15 success criteria were fixed *before* viewing final results:
≥15% median holdout MAE improvement over Model A, call/put MAE ratio in
`[0.5, 2.0]`, no systematic one-sided degradation, convergence, ≥MEDIUM
confidence, and acceptable snapshot-to-snapshot stability — **all six
required together**. Checking against Section I: PANW 48dte's Model C is
*worse* than Model A (fails criterion 1); NVDA's Model C ratio is 4.61,
far outside `[0.5,2.0]` (fails criterion 2, and is additionally
bound-clamped); AAPL's improvement is ~4%, short of the 15% bar (fails
criterion 1); PANW 41dte couldn't even be fit (insufficient pairs); and
Section J shows criterion 6 (stability) is simply untested. **Not one
symbol/expiry combination met the full pre-registered bar.** This is not
a failure of the modeling machinery — the regression, correction,
bounds, and confidence code all behave exactly as designed and are fully
unit-tested (Section D's synthetic recovery is clean) — it is a genuine
finding that **today's realized option-chain liquidity is too thin to
support a trustworthy joint market-implied estimate** for any of the
three symbols tested.

## Q — Next phase

Recommend **abandoning option-implied joint (r,q) inputs as the primary
production discount/carry source** (Step 15/Q option C path) in favor of
external rate/dividend providers for the *discount rate* leg (Phase 2B's
Treasury-bill normalization remains sound and well-supported — keep it),
while treating the option-implied carry estimators (both Phase 2B's and
this phase's joint version) as a **secondary sanity-check/diagnostic**
only, not a primary input, until either (a) genuinely liquid names with
≥8 STRICT/STANDARD-tier pairs per expiry are found, or (b) multiple real
independent market sessions can be sampled to establish actual
snapshot-to-snapshot stability. Both are achievable in a future session
run during active market hours across several distinct days — this
session's single stale snapshot was the binding constraint, not a flaw in
the estimator design itself.
