# Phase 2A.1 — TradingView theoPrice Model Fingerprint & PANW Put-Bias Diagnosis

Status: **diagnostic only.** No change to `crrAmerican.js`'s mathematics. No
integration into `strategyScenarios.js`, ranking, or confidence.

Frozen snapshot: `docs/fixtures/panw-theoprice-fingerprint-20260829.json` (52
PANW contracts, retrieved 2026-08-29 07:50 UTC, spot $371.59 from both
`data_get_key_stats` and `quote_get`, dividend_yield=0). Analysis script:
`scripts/phase2a1-theoprice-fingerprint.mjs` (reproducible, diagnostic-only,
not wired into any tool).

## A — Frozen sample

52 contracts (28 call, 24 put), DTE 20–83, strikes $275–$570, spot $371.59.
Rate mapping per Phase 2A Step 13: ≤45 DTE → 3.86% (2 Mo Treasury,
2026-08-28), 46–105 DTE → 3.90% (3 Mo).

## B — Model errors (MAE, TV theo vs model, steps=200)

| Model | Call MAE | Put MAE | All MAE |
|---|---|---|---|
| TradingView vs BSM (European) | 0.2406 | 1.2524 | 0.7076 |
| TradingView vs CRR European (early exercise disabled) | 0.2529 | 1.2490 | 0.7126 |
| TradingView vs CRR American | 0.2529 | **0.7579** | 0.4860 |

Step 3 sanity check passed: BSM vs CRR European MAE = **0.0147** (max
0.0486) across all 52 contracts — the CRR European-mode tree converges to
the closed-form BSM value as expected at 200 steps; no discretization bug.

## C — Signed errors (model − TV theo)

| Model | Call signed mean | Put signed mean |
|---|---|---|
| BSM | +0.166 | **−1.252** |
| CRR European | +0.174 | **−1.249** |
| CRR American | +0.174 | **−0.758** |

**Explicit sign finding (Step 8):** put signed error is **negative** for
every model — our models consistently price PANW puts *below*
TradingView's theoretical_price, not above. This directly contradicts the
Phase 2A.1 prompt's stated hypothesis ("American puts may systematically
**exceed** TradingView theoretical_price"). The data shows the opposite
direction throughout.

## D — American early-exercise premium

- Call mean premium (CRR American − CRR European): **≈0.0000** (n=28) —
  correct: on a non-dividend underlying, calls should show ~zero early-
  exercise premium (Merton), and they do.
- Put mean premium: **+0.491** (n=24) — correct sign for an American put.

**Key diagnostic (Step 5), correctly interpreted:** the hypothesis under
test was "does the American premium explain the CRR-vs-TV put gap." If TV
theo ≈ CRR European (i.e., TV is European-style and simply omits the
premium), then `CRR_American − TV_theo` should ≈ `+premium` (same sign,
similar magnitude). Instead: `CRR_American − TV_theo` (put signed mean) =
**−0.758**, while `premium` = **+0.491** — **opposite sign**. The early-
exercise premium moves CRR American *toward* TV (reduces the gap from
−1.25 to −0.76) but does not explain it, and the raw correlation between
per-contract `(TV − CRR_American)` and `premium` is only **0.36** — weak.
**The early-exercise-premium hypothesis is not supported by this data.**

## E — Put-call parity (2026-10-09 / 41 DTE, 9 matched strike pairs)

| | mean \|residual\| | max \|residual\| |
|---|---|---|
| TV theo | **1.0848** | 1.1273 |
| BSM (self-consistent, tautological) | 0.0000 | 0.0000 |
| CRR American | 0.1317 | 0.2044 |

TradingView's own call/put theoretical prices do **not** satisfy simple
European put-call parity closely (~$1.08 residual, nearly constant across
strikes 350–400) — but this residual is smaller than the bid/ask spreads
on these contracts (~$4–8, several `WIDE_SPREAD`-flagged), so it is only
weak, noisy evidence and not a clean confirmation of any single hypothesis.
The near-constant-across-strikes shape (residual varies only ~$0.12 over a
$50 strike range) is inconsistent with a simple large flat risk-free-rate
error (which would scale roughly linearly with strike over that range) and
is more consistent with either measurement noise or a common small
additive factor (e.g., call/put marks not perfectly synchronized).

## F — Rate sensitivity

| Flat rate | CRR Am Call MAE | CRR Am Put MAE | BSM Call MAE | BSM Put MAE |
|---|---|---|---|---|
| 0% | 0.4409 | 0.3039 | 0.4488 | 0.3038 |
| 2% | 0.1678 | 0.3146 | 0.1695 | 0.5317 |
| 3.86% (Treasury proxy) | 0.2511 | 0.7530 | 0.2389 | 1.2422 |
| 5% | 0.4048 | 1.0010 | 0.3914 | 1.6752 |
| 6% | 0.5497 | 1.2063 | 0.5370 | 2.0533 |

Error is highly sensitive to the assumed rate and, critically, **puts and
calls are minimized at different rates** — puts prefer a much lower rate
than calls. Both are minimized well below the 3.86% Treasury proxy.

Qualitative rho check (Step 9): correlation between `|rho|` and
`|CRR_American − TV_theo|` (at the 3.86%/3.90% Treasury rate) is
**0.75 overall, 0.66 for puts alone** — contracts most sensitive to the
discount rate show the largest pricing gaps, consistent with *some*
rate/carry-convention mismatch being a real contributor (not proof of
TradingView's exact internal rate).

## G — Best common rate fit (0–10%, 0.1% grid, single flat rate for whole sample)

| Target | Best rate | MAE at best rate |
|---|---|---|
| BSM, calls only | 2.7% | 0.142 |
| BSM, puts only | 0.8% | 0.152 |
| CRR American, calls only | 2.6% | 0.144 |
| CRR American, puts only | 0.9% | 0.186 |
| BSM, whole sample | 1.0% | 0.228 |
| CRR American, whole sample | 1.5% | 0.212 |

All best-fit rates are **well below** the 3.86–3.90% Treasury proxy used in
Phase 2A, and fitting even a single flat rate per option type cuts MAE by
roughly 3–5x versus the Treasury rate (e.g. put MAE 1.25→0.15 for BSM).
This is strong, quantified evidence that the rate/carry convention used in
Phase 2A materially overstated the effective discount rate TradingView's
theoretical prices are consistent with — but calls (~2.6–2.7%) and puts
(~0.8–0.9%) do **not** converge to the same rate, so a single flat
risk-free-rate correction alone does not fully close the gap (residual MAE
≈$0.14–0.23, well above numerical noise). This split is consistent with an
un-modeled cost-of-carry/borrow component that affects synthetic-put
economics differently than calls — something this V1 model does not
capture (it only has a single scalar `dividend_yield`, currently 0 for
PANW).

## H — Time-to-expiry convention test

| Convention | CRR Am All MAE | CRR Am Put MAE |
|---|---|---|
| days / 365 | 0.4860 | 0.7579 |
| days / 365.25 | 0.4870 | 0.7646 |

Negligible impact (<0.01 MAE difference) — time convention is **not** a
meaningful contributor to the observed bias. (Trading-days/252 was not
tested per the prompt's guidance, since nothing in the evidence pointed
toward a trading-calendar convention.)

## I — Spot-source test

`data_get_key_stats.price` = $371.59, `quote_get.last` = $371.59 —
**identical**, retrieved within the same ~1-minute window. Spot-source
mismatch is ruled out as a factor for this symbol/session.

## J — IV / theoPrice consistency

For a thinned sample (every 6th contract), the BSM-implied volatility that
would reproduce TradingView's `theoretical_price` (given our spot/rate/time
assumptions) was compared to TradingView's own native `iv`:
mean `|diff|` = **1.76 vol points**, max **4.52** (one far-OTM call,
`PANW261009C275.0`, wide-spread-flagged). Most contracts are within ~0.5–3
points — plausibly explained by our rate assumption (Section G) rather than
a fundamental `iv`/`theoPrice` inconsistency, but the sample is small (9
contracts) and this was not exhaustively tested.

## K — Bid/ask sanity

All 52 contracts: `theoretical_price` fell strictly inside `[bid, ask]`
(52/52 inside, 0 below bid, 0 above ask). No evidence of stale/mistimed
`theoretical_price` relative to the same snapshot's quotes.

## L — AAPL cross-check

Same model-family comparison on the 10-contract AAPL sample from Phase 2A
(dividend_yield=0.003378, same rate mapping):

| Model | Call MAE | Put MAE |
|---|---|---|
| BSM | 0.2379 | 0.5017 |
| CRR American | 0.2394 | 0.2925 |

Same *direction* of pattern as PANW (put signed error negative; CRR
American reduces but doesn't eliminate the put-side gap; call MAE roughly
unaffected), at smaller absolute magnitude — consistent with the PANW
finding being a general phenomenon in this pipeline rather than a
PANW-specific data artifact.

## M — Independent CRR validation

No independently-implemented option-pricing library exists in
`node_modules` (checked; none found), and no new runtime or dev dependency
was added per the instruction not to introduce a new runtime dependency.
**No trustworthy independent third-party American-pricing benchmark was
available in this offline environment** — this is stated plainly rather
than fabricated. What Phase 2A.1 adds beyond Phase 2A's convergence/
invariant validation: (a) confirmation that the CRR tree's European mode
converges to the independently-implemented closed-form BSM formula to
<$0.05 across 52 real contracts (Section B/Step 3), and (b) the AAPL
cross-check (Section L) as a second, independent live dataset showing the
same qualitative pattern — neither is a substitute for a published
reference table.

## N — Root cause: evidence summary

- Early-exercise-premium hypothesis (A, as originally framed: "TV theo is
  European, gap = missing premium"): **rejected** — wrong sign in Section D.
- Time convention: **ruled out** (Section H, <$0.01 impact).
- Spot source: **ruled out** (Section I, identical spot from two sources).
- IV/theoPrice internal consistency: **not a primary driver** (Section J,
  small sample, differences plausibly explained by rate).
- Rate/carry convention: **strong, quantified, dominant factor** (Section
  F/G) — a single flat rate cuts MAE 3–5x, but a *different* best-fit rate
  for calls (~2.6–2.7%) vs puts (~0.8–0.9%) means a flat risk-free rate
  alone does not fully close the gap; residual error after best-fit-rate
  correction (~$0.14–0.23 MAE) exceeds what bid/ask-inside-spread noise
  alone (Section K) would suggest.
- Put-call parity on TV's own quotes (Section E): weakly informative,
  residual ~$1.08 is within the bid/ask noise band (~$4–8), so it neither
  confirms nor cleanly refutes a European-style hypothesis.

## O — Final root-cause classification

**G) MULTIPLE_FACTORS**

Primary, quantified driver: **rate/cost-of-carry convention mismatch**
between the Phase 2A Treasury-proxy rate and whatever discount/carry
TradingView's theoretical price is consistent with — evidenced by a 3–5x
MAE reduction under a best-fit flat rate (Section G) and a 0.66–0.75
correlation between `|rho|` and pricing error (Section F). This alone is
not sufficient: calls and puts fit best at different rates (2.6–2.7% vs
0.8–0.9%), pointing to a secondary, un-modeled cost-of-carry/borrow
asymmetry between calls and puts that this V1 model's single scalar
`dividend_yield=0` cannot represent. The original early-exercise-premium
hypothesis was tested directly and is **not** supported (Section D, wrong
sign). No evidence for spot-source or time-convention mismatch. This is
therefore genuinely multi-factor, not a single clean root cause — reported
as such rather than forcing a single-factor story the data doesn't support.

## P — CRR model status

**CRR_MATH_VALID**

Nothing in this diagnostic points to an implementation bug in
`crrAmerican.js`: (1) its European-mode variant converges to independently
implemented closed-form BSM to <$0.05 across 52 real contracts (Step 3 gate
passed), (2) it reproduces the textbook early-exercise sign and magnitude
pattern (zero premium for non-dividend calls, positive premium for puts),
and (3) per Phase 2A, all theoretical invariants (A–F) already pass. The
observed TV discrepancy is explained by input/convention factors (rate,
possible carry asymmetry), not by the tree's mathematics. Per Step 17, the
model was **not** modified.

## Q — Implication for production

**1) USE CRR AMERICAN FOR REAL SCENARIO PRICING; DO NOT CALIBRATE TO
TRADINGVIEW THEOPRICE** — with a caveat before actual integration: the
production market-input contract (`pricingTypes.js`'s `MarketRateInput`,
still unimplemented) should source a defensible risk-free rate and, ideally,
a borrow/cost-of-carry input, rather than assume the Phase 2A Treasury-DTE
proxy is correct as-is — this diagnostic shows that proxy runs ~2-3
points too high relative to what the market (TradingView's own theo/quotes)
is consistent with for this name. CRR's mathematics are validated; its
*inputs* are where the next work belongs. TradingView's `theoretical_price`
remains a useful sanity check, not a calibration target.

## R — Next phase recommendation

Before any integration into `strategyScenarios.js`:
1. Investigate a more defensible risk-free-rate source (e.g., is a
   SOFR-based curve or the option-implied forward rate a better proxy than
   the nominal Treasury curve for this use case?).
2. Consider whether a borrow/cost-of-carry input belongs in the
   `MarketRateInput` contract for hard-to-borrow names, to address the
   call/put rate-fit asymmetry found in Section G.
3. If a trustworthy independent American-pricing reference (library or
   published table) becomes available, use it to close the Section M gap
   before treating CRR American as validated ground truth rather than
   validated *machinery*.

**STOP. No integration into `strategyScenarios.js`. No change to
ranking/confidence.**
