# Phase 2C — External Market Inputs + American CRR Shadow Scenario Engine

Status: **shadow/diagnostic only.** `LOCAL_GREEK_APPROXIMATION` remains the
sole pricing model wired into `strategyScenarios.js`, ranking, confidence,
and `options_analyze_directional`.

New modules: `src/core/options/marketInputs/{productionMarketInputs,
dividendProviders,borrowProviders,crrShadowScenario}.js`,
`src/core/options/pricing/crrShadowRepricer.js`. Tests:
`tests/market_conventions_and_shadow.test.js` (30 tests). Live script:
`scripts/phase2c-crr-shadow-live.mjs`. Fixture:
`docs/fixtures/phase2c-live-chains-20260830.json`.

## B — Production market input contract

Normalized per-expiration record (`buildMarketInputRecord`):
`discount_rate` (+ source/as-of), `dividend_input` (mode/yield/source/
confidence), `borrow_input` (fee/source/confidence/availability),
`effective_carry_yield`, `mode` (FULL/PARTIAL/UNAVAILABLE),
`overall_confidence`, `warnings`. Explicitly does **not** reuse Phase
2B.1's option-implied joint r/q (verdict: NOT_RELIABLE).

## C — Live data providers

**Treasury**: same validated coupon-equivalent normalization as Phase
2B/2B.1 — `AVAILABLE` (2026-08-28 observation, still the latest published
data as of this run).
**Dividend**: `TRADINGVIEW_KEY_STATS_TRAILING_YIELD` — the only dividend
data actually reachable in this environment (`data_get_key_stats`).
Labeled `TRAILING_DIVIDEND_YIELD_APPROXIMATION` (confidence LOW) for
NVDA (0.1287%) and AAPL (0.3338%); PANW used `ZERO_DIVIDEND_CONFIRMED`
(confidence HIGH, documented no-dividend name).
**Borrow**: **`NOT_CONNECTED`** for all three symbols — no IBKR or other
securities-lending session exists in this environment. `borrow_fee_rate`
stayed `null` throughout; every market-input record fell to
`PARTIAL_EXTERNAL_INPUTS` with confidence capped at MEDIUM (and further
reduced to LOW wherever the dividend leg was itself LOW-confidence
trailing-yield, i.e. NVDA/AAPL). The `ibkrBorrowProviderAdapter` interface
is implemented and ready for dependency injection but was never exercised
against a real connection.

## D — Carry convention

`effective_carry_yield = dividend_yield_component + borrow_fee_rate`
(additive, same sign). Justified and unit-tested: higher dividend yield
lowers call value / raises put value (standard); the composed carry
(dividend + borrow, same sign) lowers call value further than dividend
alone, and a fee-only carry produces an *identical* CRR price to a
dividend-only carry of the same magnitude — confirming the two components
are economically fungible in this model, as intended. No sign
inconsistency was found (Step 7's "STOP and report" trigger was not hit).

## E — Shadow pricing pipeline

`repriceOptionCrrShadow` mirrors `repriceOptionLocalGreeks`'s shape but
reprices independently from spot/strike/remaining-time/IV/discount/carry
via `CRR_AMERICAN_V1` — never anchored to `theoretical_price` (Step 12).
`generateCandidateScenarioResultsCrrShadow` mirrors
`generateCandidateScenarioResults`'s aggregation math exactly (same
leg-P&L formula, same one-time fee subtraction), so shadow-priced
candidates feed directly into the **unmodified** `rankStrategyCandidates`.

## F — Test results

30/30 new tests pass; full regression (18 test files, all pre-existing
suites) remains green. Highlights: carry sign convention (3 tests),
market-input mode transitions (FULL/PARTIAL/UNAVAILABLE), provider
never-silent-zero behavior, shadow-ranking determinism (identical scores
across repeated runs on identical inputs).

## G — Expiration reconciliation

**Exact** for all four required strategy types (`LONG_CALL`, `LONG_PUT`,
`BULL_CALL_SPREAD`, `BEAR_PUT_SPREAD`): at `days_forward >= DTE`, the CRR
shadow's `scenario_pnl` matches `LOCAL_GREEK_APPROXIMATION`'s exactly
(both fall back to intrinsic payoff). Verified on a frozen synthetic
fixture (spot 100).

## H — NVDA

Market inputs: Treasury 3.762%, dividend 0.1287% (TRAILING, LOW conf),
borrow UNAVAILABLE → **PARTIAL_EXTERNAL_INPUTS, LOW confidence**.
Model disagreement (BASE scenario, n=41 candidates): **median 16%, P75
19.6%, P95 25.5%, max 40%**. With-local-warning mean **14.9%** vs
without-warning mean **0.00%** (n=2 unwarned — small sample). Shadow
ranking: **top-5 overlap only 1/5** — the largest instability of the
three symbols; one candidate moved from production rank 5 to shadow rank
38.

## I — AAPL

Market inputs: Treasury 3.762%, dividend 0.3338% (TRAILING, LOW conf),
borrow UNAVAILABLE → **PARTIAL_EXTERNAL_INPUTS, LOW confidence**.
Disagreement (n=36): **median 17.7%, P75 22.8%, P95 29.6%, max 30%**.
With-warning mean **16.8%** vs without-warning **0.00%** (n=2). Shadow
ranking top-5 overlap **3/5**.

## J — PANW

Market inputs: Treasury 3.762%, dividend ZERO_DIVIDEND_CONFIRMED (HIGH
conf), borrow UNAVAILABLE → **PARTIAL_EXTERNAL_INPUTS, MEDIUM confidence**
(the only symbol reaching MEDIUM — HIGH-confidence dividend input, capped
down one level by the missing borrow leg, per Step 8's rule, not further).
Disagreement (n=35): **median 8.3%, P75 13.3%, P95 19.5%, max 20.6%** —
noticeably lower than NVDA/AAPL. With-warning mean **9.6%** vs
without-warning **0.00%** (n=2). Shadow ranking top-5 overlap **3/5**.

## K — Warning correlation

Across all three symbols, candidates already carrying a
`LARGE_TIME_STEP`/`NEAR_EXPIRATION`/`LARGE_SPOT_MOVE` warning from
`LOCAL_GREEK_APPROXIMATION` showed **9.6%–16.8% mean disagreement**,
versus **0.00%** for the small number of unwarned candidates. **This
supports Step 25's key question affirmatively** — high disagreement does
concentrate where the local-Greek engine already flags itself as
unreliable — but the unwarned sample was only 2 candidates per symbol (the
30-day BASE scenario used here triggers `LARGE_TIME_STEP` for nearly every
candidate at these DTEs), so this is suggestive, not statistically robust.
A proper small/moderate/large graduated test (Step 20's 5/15/30-day
design) was implemented only as a frozen-fixture *expiration* reconciliation
test (Section G), not as a full graduated small-move comparison on live
data — noted as a limitation (Section N).

## L — Shadow ranking stability

Top-5 overlap: NVDA 1/5, AAPL 3/5, PANW 3/5. Largest single-candidate rank
swings ranged from a moderate 8-rank shift (PANW, 34→26) to a severe
33-rank shift (NVDA, 5→38). **Pricing-model choice materially reorders
candidates**, most severely for NVDA. This was measured, not interpreted
as evidence either model is "more correct" (Step 27).

## M — Missing-input behavior

Verified end-to-end, live: every one of the 9 expiration/symbol
combinations correctly resolved to `PARTIAL_EXTERNAL_INPUTS` (never
`FULL`, since borrow was never connected) and never silently substituted
0 for the missing borrow fee — `borrow_input.fee_rate` stayed `null`
throughout, with `BORROW_DATA_UNAVAILABLE` in every record's warnings.

## N — Limitations

- Borrow data is unavailable in this environment (no IBKR/broker
  connection) — every live result here used `PARTIAL_EXTERNAL_INPUTS`.
- Discrete dividend dates remain unavailable (same gap as Phase 2B.1,
  Step 18) — dividend input is a trailing-yield approximation, not a
  discrete schedule.
- Constant contract-IV-shift assumption (Step 11) — no vol-surface
  dynamics; every shadow leg is flagged `CONSTANT_CONTRACT_IV_SHIFT`.
- CRR uses 200 steps (Phase 2A's recommended production step count) — a
  numerical approximation, not exact.
- The shadow model is not user-facing and does not affect any Copilot
  output in this phase.
- TradingView `theoretical_price` was not used as a CRR anchor or fit
  target anywhere in this pipeline (Step 12/23 honored).
- The graduated small/moderate/large live-scenario comparison (Step 20's
  spirit) was only exercised as a synthetic-fixture expiration
  reconciliation test, not a full live 5/15/30-day progression — the live
  comparison used only the standardized 30-day DOWNSIDE/BASE/UPSIDE set
  (Step 21), so the "small move" half of Step 18's expected-behavior claim
  is asserted by the synthetic tests but not separately confirmed live.

## O — Verdict

**B) CRR SHADOW MODEL PROMISING BUT MARKET INPUTS INCOMPLETE**

Checking Step 28's seven criteria: (1) CRR numerical tests remain clean —
**yes**; (2) market inputs reproducible — **yes** (deterministic Treasury
+ TradingView dividend); (3) no silent missing-input assumptions —
**yes** (verified live, Section M); (4) exact-expiry reconciliation
passes — **yes**, all four strategy types; (5) model disagreement low for
local scenarios — **not separately tested live** (only the 30-day
standardized scenario was run; live small-move testing is a gap); (6)
disagreement concentrates where local-Greek already warns — **yes,
directionally supported** (9.6–16.8% vs 0.00%), though on a thin unwarned
sample; (7) shadow ranking free of pathological instability — **no**,
NVDA's 1/5 top-5 overlap and 33-rank single-candidate swing is a real
warning sign, not dismissible as noise. Criteria 1–4 and 6 pass; 5 is
untested live; 7 fails for NVDA specifically. That mixed picture, combined
with borrow data being structurally unavailable (capping every live
result at PARTIAL/LOW-MEDIUM confidence — never the FULL/HIGH-confidence
regime the model is actually designed for), means this is not yet a
production-migration candidate, but the core CRR shadow machinery
(pricing, aggregation, exact-expiry reconciliation, market-input
discipline) is sound and worth continuing to develop.

## P — Next phase

Before considering production migration: (1) obtain a real borrow-fee
data source (IBKR or another securities-lending feed) so `FULL_EXTERNAL_
INPUTS`/HIGH-confidence results become achievable and testable; (2) run
the graduated 5-day/15-day/30-day live comparison Step 20 specified,
not just the single 30-day standardized set; (3) investigate NVDA's
severe shadow-ranking instability specifically — is it driven by a small
number of thinly-traded, wide-spread candidates that a tighter execution
filter would exclude? (4) expand the live sample beyond ~15 contracts per
symbol for more statistically robust disagreement percentiles. **Do not
switch production pricing, ranking confidence, or `options_analyze_
directional` output semantics until these are addressed.**

STOP. No production pricing switch made.
