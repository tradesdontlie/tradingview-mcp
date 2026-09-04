# Phase 2E.0 — Phase 2D Rollup + Migration Decision

**Date:** 2026-09-04
**Branch:** `phase-2d-hybrid-policy`
**Base commit:** `13fb4b51b1bb02824101994e8e576cb352fdedd9`
**Type:** Decision/checkpoint phase — no code changes.

## Executive verdict

**Ship the guarded diagnostic path as-is. Do not migrate production
pricing/ranking to CRR.**

Phase 2D (through 2D.6) proved the CRR hybrid policy can run end-to-end —
from unit-level policy logic, through live TradingView chains, through the
actual MCP tool boundary, across bullish and bearish theses, and into both
`NO_TRADE_BASELINE_ONLY` and `TRADE_CANDIDATES_AVAILABLE` decision states —
without ever touching production scoring, ranking, confidence, eligibility,
or recommendations. That is a complete, self-consistent diagnostic feature.
It did **not** prove that CRR pricing is safe, necessary, or ready to
replace local-Greek pricing in production, and it explicitly avoided
building the infrastructure (live borrow, live Treasury, IBKR) that a real
migration decision would require. The correct next move is to freeze and
harden the diagnostic contract that already exists (Phase 2E.1), not to
extend it toward a production switch.

## What Phase 2D proved

1. **The hybrid policy logic is correct and conservative** (2D). Given
   local and CRR-shadow scenario results, `evaluateHybridCrrPolicy()`
   correctly classifies candidates into `LOCAL_ONLY`, `CRR_SHADOW_REVIEW`,
   `HYBRID_REPRICE_CANDIDATE`, and `NO_ACTION` (baselines) based on
   warning severity and model disagreement, without pricing or mutating
   anything itself.
2. **The policy holds up on live, active-market chains** (2D.1): NVDA,
   AAPL, and PANW all showed 5/5 top-5 overlap between local and CRR
   shadow rankings across two scenario sets, with zero top-5 membership
   changes and only one intra-top-5 order swap (correctly flagged
   `HYBRID_REPRICE_CANDIDATE`).
3. **The integration point is safely isolated** (2D.2): diagnostics live
   only at `diagnostics.crr_hybrid_policy`, are opt-in
   (`include_crr_hybrid_diagnostics`), gracefully degrade to
   `NOT_REQUESTED`/`UNAVAILABLE` when not requested or not configured, and
   are excluded from `ranking`, `top_candidates`, `scenario_quality_summary`,
   `consideration_eligible`, and `ai_contract.allowed_candidate_ids`
   scoring paths.
4. **A production-usable, non-IBKR market-input provider exists** (2D.3):
   `tradingViewCrrShadowMarketInputs.js` composes Treasury (frozen
   fallback), TradingView trailing/zero dividend, and
   `BORROW_DATA_UNAVAILABLE` into `PARTIAL_EXTERNAL_INPUTS` records with no
   manual wiring required — diagnostics work "out of the box" now.
5. **The full path works through the real MCP tool, not just in-process
   calls** (2D.4, bullish; 2D.5, bearish): `options_analyze_directional`
   with `include_crr_hybrid_diagnostics: true` returns correct, consistent
   diagnostics over a live CDP connection to TradingView Desktop for
   NVDA/AAPL/PANW in both directions.
6. **The diagnostic path holds across both ranking decision states**
   (2D.6): after root-causing why every 2D.5 bearish run landed on
   `NO_TRADE_BASELINE_ONLY` (a structural `LARGE_TIME_STEP` confidence cap
   at short DTE, not a bug), a widened-DTE parameter set reached
   `TRADE_CANDIDATES_AVAILABLE` for all three symbols with diagnostics
   still `AVAILABLE`/`DIAGNOSTIC_ONLY_NO_RANKING_CHANGE` and ranking still
   `RANKING_MODEL_V1` — including a new `LOCAL_ONLY`/`LOCAL_CLEAN_AND_CRR_AGREES`
   action value and a live `LONG_PUT` eligible top candidate, neither seen
   in earlier phases.

## What Phase 2D did not prove

- **That CRR pricing is more accurate than local-Greek pricing in
  production.** No phase compared CRR-priced P&L against realized market
  outcomes; all comparisons were CRR-vs-local agreement/disagreement, not
  CRR-vs-truth.
- **That a `FULL_EXTERNAL_INPUTS` / HIGH-confidence market-input path
  works.** Every live run across 2D.1–2D.6 produced `PARTIAL_EXTERNAL_INPUTS`
  at LOW or MEDIUM confidence — never HIGH, never `FULL_EXTERNAL_INPUTS` —
  because borrow is structurally absent (no IBKR, no funded account) and
  discount rate is a frozen, non-live Treasury fallback.
- **That the diagnostic path is stable over time or across a broad symbol
  universe.** All live runs were point-in-time snapshots on 3–6 large-cap
  liquid names (NVDA, AAPL, PANW); there is no automated regression
  harness that re-runs this on a schedule or across a wider symbol set.
- **That IBKR integration is necessary or even beneficial.** Phase 2C.4
  (pre-2D) found synthetic borrow inputs are not the primary live ranking
  driver at normal fee levels — this remains an open, deprioritized
  question, not a resolved one.
- **That production ranking should ever consume CRR output.** No phase
  attempted or evaluated a production ranking switch; the guardrails
  (opt-in flag, provider gating, ranking isolation, scoped output) were
  designed specifically to avoid needing to answer that question yet.

## Summary of each completed phase

| Phase | Date | What it did | Key result |
|---|---|---|---|
| **2D** | 2026-09-02 | Encoded the hybrid CRR policy as a pure, deterministic evaluator (`hybridCrrPolicy.js`) with 4 action states | 50 tests pass; diagnostic-only, not a production switch |
| **2D.1** | 2026-09-02 | Ran the policy on live NVDA/AAPL/PANW chains across 2 scenario sets | 5/5 top-5 overlap all symbols; zero top-5 membership changes; one correctly-flagged intra-top-5 swap |
| **2D.2** | 2026-09-02 | Designed the guarded integration point (`include_crr_hybrid_diagnostics` flag, `diagnostics.crr_hybrid_policy` output location) | Diagnostics fully isolated from ranking/scoring/eligibility by construction |
| **2D.3** | 2026-09-03 | Wired a default non-IBKR market-input provider (`tradingViewCrrShadowMarketInputs.js`) | Diagnostics work with zero manual wiring; always `PARTIAL_EXTERNAL_INPUTS`, borrow always `NOT_CONNECTED` |
| **2D.4** | 2026-09-03 | Live MCP tool validation, bullish, NVDA/AAPL/PANW | PASS — diagnostics `AVAILABLE`, ranking untouched, LOW-confidence spreads correctly not promoted |
| **2D.5** | 2026-09-03 | Live MCP tool validation, bearish, NVDA/AAPL/PANW | PASS — but all three hit `NO_TRADE_BASELINE_ONLY`; identified as a coverage gap |
| **2D.6** | 2026-09-03 | Closed the 2D.5 gap: found and root-caused a bearish `TRADE_CANDIDATES_AVAILABLE` path via a widened-DTE parameter set (no code/threshold changes) | PASS — all three symbols reached an eligible trade state; diagnostics/ranking guarantees held |

## Evidence table

| Phase | Commit | Docs | Raw evidence |
|---|---|---|---|
| 2D | `a6efec63b9ab394fbe427bdbcc36de004ffeeed4` | `docs/phase-2d-hybrid-crr-policy.md` | `tests/hybrid_crr_policy.test.js` |
| 2D.1 | `595c2aaa3accea76bba8caa2702f4f23696298b6` | `docs/phase-2d1-hybrid-policy-live-acceptance.md` | `docs/fixtures/phase2d1-hybrid-policy-live-20260902/phase2d1-hybrid-policy-live-20260902.json` |
| 2D.2 | `3584e20b006ee2886b7434d4e73585cd6dc21066` | `docs/phase-2d2-guarded-integration-design.md` | `tests/directional_analysis.test.js` |
| 2D.3 | `dac7b506dbf5b5149983a883867868c2b42ae6cd` | `docs/phase-2d3-diagnostic-market-input-provider.md` | `tests/directional_analysis.test.js`, `tests/hybrid_crr_policy.test.js`, `tests/market_conventions_and_shadow.test.js`, `tests/ibkr_market_inputs.test.js` |
| 2D.4 | `fa5323a3e4e03f9ab83e90145250502d4a0fc221` | `docs/phase-2d4-mcp-tool-live-validation.md` | `docs/fixtures/phase2d4-mcp-tool-live-validation-20260903/{nvda,aapl,panw}.json` |
| 2D.5 | `1a933f4ba51adc03d73a7049b7eca7db055e4fdb` | `docs/phase-2d5-bearish-mcp-tool-live-validation.md` | `docs/fixtures/phase2d5-bearish-mcp-tool-live-validation-20260903/{nvda,aapl,panw}.json` |
| 2D.6 | `13fb4b51b1bb02824101994e8e576cb352fdedd9` | `docs/phase-2d6-bearish-eligible-trade-live-coverage.md` | `docs/fixtures/phase2d6-bearish-eligible-trade-live-coverage-20260903/*.json` |

(2D and 2D.2's commit hashes are the feature commits that shipped the
described code; 2D.1/2D.4/2D.5/2D.6's commit hashes are the docs commits
that shipped the described evidence, per this repo's convention of
separate feat/docs commits.)

## Migration decision

| Question | Decision |
|---|---|
| Full CRR migration (replace local-Greek in production pricing/ranking)? | **No** |
| Guarded hybrid diagnostic path (opt-in, isolated, informational)? | **Yes — keep as shipped** |
| Production ranking switch to consume CRR output? | **No** |
| IBKR / `FULL_EXTERNAL_INPUTS` dependency required to proceed? | **No — remains optional/future, not blocking** |

## Current accepted behavior

- **Local-Greek (`LOCAL_GREEK_APPROXIMATION`) remains the production
  default** for all scenario pricing, ranking, scoring, confidence, and
  eligibility — unconditionally, whether or not diagnostics are requested.
- **CRR shadow/hybrid diagnostics are opt-in evidence only**, gated behind
  `include_crr_hybrid_diagnostics: true`, surfaced solely at
  `diagnostics.crr_hybrid_policy`.
- **Diagnostics must never alter score, confidence, eligibility, or
  recommendations.** This has been verified at the unit level (Phase 2D.2
  tests: ranking order, top candidate, decision state byte-identical with
  diagnostics on/off) and at the live level (Phase 2D.4–2D.6: `ranking.model`
  stayed `RANKING_MODEL_V1` in every live packet captured).
- **The non-IBKR provider may produce only `PARTIAL_EXTERNAL_INPUTS`** —
  by construction, it cannot reach `FULL_EXTERNAL_INPUTS` because borrow is
  always absent (`ibkrResult: null` unconditionally).

## Remaining gaps

- **`FULL_EXTERNAL_INPUTS` / HIGH-confidence market-input path not
  exercised.** No live run in any 2D.x phase has produced this mode; it
  requires a connected borrow source (IBKR or equivalent), which remains
  out of scope.
- **Live borrow is unavailable.** `resolveBorrowWithPrecedence` is always
  called with `ibkrResult: null`; every market-input record's
  `borrow_source` is `NOT_CONNECTED`.
- **The frozen Treasury fallback table is still used in the diagnostic
  provider.** `FALLBACK_TREASURY_BILL_RATES` is dated `2026-09-01` and
  tagged `TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE` in every record; no live
  Treasury fetcher exists in this codebase.
- **Broader symbol/time regression is not yet automated.** All live
  evidence (2D.1, 2D.4, 2D.5, 2D.6) is a manually-triggered, point-in-time
  snapshot on 3 (occasionally up to 6-candidate) large-cap symbols; there
  is no scheduled or CI-driven re-run that would catch drift.

## Go/no-go table

| Item | Go / No-Go | Rationale |
|---|---|---|
| Ship guarded hybrid diagnostics as an opt-in feature | **GO** | Fully isolated from production ranking by design and by test/live evidence across 6 sub-phases |
| Document the diagnostic contract for downstream users/agents | **GO** | Contract is stable in shape; needs freezing/documentation, not further feature work |
| Full CRR production migration | **NO-GO** | No accuracy evidence vs. ground truth; no HIGH-confidence market-input path exercised; would require IBKR/live-Treasury infrastructure not yet built |
| Production ranking switch to CRR | **NO-GO** | Never attempted or evaluated; explicitly out of this phase's and all prior 2D.x phases' scope |
| Requiring IBKR as infrastructure | **NO-GO** | Phase 2C.4 found borrow is not the primary live ranking driver at normal fee levels; account is unfunded; not a blocker worth forcing |
| Automated regression coverage for the diagnostic path | **GO (recommended next)** | Currently manual-only; schema/shape tests would lock in the contract cheaply |

## Recommended next phase

**Phase 2E.1 — Release gate / contract stabilization.**

Scope:

1. Freeze the public shape of `diagnostics.crr_hybrid_policy` (status
   values, mode, `market_inputs[]` fields, `summary` counts, scoped
   `candidates[]` fields) as a documented, versioned contract.
2. Add schema/shape tests (e.g. a JSON-schema or structural assertion
   suite) that fail if a future change silently alters the diagnostic
   contract's shape, independent of the existing behavioral tests in
   `tests/hybrid_crr_policy.test.js` and `tests/directional_analysis.test.js`.
3. Prepare safe, explicit documentation for downstream users/agents
   (including the Options Copilot operating standard already in
   `CLAUDE.md`) making clear: diagnostics are informational only, never a
   recommendation, score override, or pricing switch — and that
   `PARTIAL_EXTERNAL_INPUTS` is the ceiling until a live borrow/discount
   source is connected.
4. Explicitly **not** in scope: any change to production pricing, ranking,
   scoring, confidence, eligibility, or a CRR migration decision. Phase
   2E.1 stabilizes what already exists; it does not extend the feature
   toward production use.

This keeps the project's stated posture — "local-Greek in production,
CRR as shadow evidence" — intact while converting six phases of ad hoc
live validation into a durable, tested contract that won't silently
regress.
