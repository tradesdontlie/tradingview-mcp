# Phase 2E.1 — Release Gate / CRR Diagnostic Contract Stabilization

**Date:** 2026-09-04
**Branch:** `phase-2d-hybrid-policy`
**Base commit:** `f777a915626ef3f022bc131a8d6a8ca38870cdfd`

## Purpose

Phase 2E.0 decided: keep the guarded hybrid CRR diagnostic path as
shipped, do not migrate production pricing/ranking to CRR, and recommended
a release-gate phase to freeze the diagnostic contract before any further
work builds on top of it. Phase 2E.1 is that gate: it does not add
capability, it locks down the shape that already exists so future changes
to `directionalAnalysis.js` or the CRR modules can't silently break
downstream consumers (human or agent) of `diagnostics.crr_hybrid_policy`.

## What changed

1. **Contract documentation** — `docs/crr-hybrid-diagnostic-contract.md`
   (new). A standalone, user/agent-facing reference for
   `diagnostics.crr_hybrid_policy`: exact field shapes per status, action
   value meanings, explicit guarantees (opt-in, evidence-only, zero
   ranking effect, `PARTIAL_EXTERNAL_INPUTS` ceiling), explicit
   non-guarantees, and consumer guidance (never treat
   `HYBRID_REPRICE_CANDIDATE` as a recommendation).
2. **Shape/contract tests** — added a new `describe` block, "Phase 2E.1 —
   CRR hybrid diagnostic contract stabilization", to
   `tests/directional_analysis.test.js` (7 new tests). These assert exact
   field sets (via `Object.keys(...).sort()` equality, not just
   presence-of-some-fields) and primitive/array types for all three
   statuses and both nested array shapes, independent of the existing
   behavioral tests already in that file.
3. **No production code changes.** `src/core/options/directionalAnalysis.js`,
   `hybridCrrPolicy.js`, `tradingViewCrrShadowMarketInputs.js`, and
   `src/tools/optionsAnalysis.js` were read for reference but not modified
   — the existing shape already matched what this phase asked to freeze;
   no docs-safe hardening was needed.

## The frozen contract (summary)

Full detail in `docs/crr-hybrid-diagnostic-contract.md`. In brief:

| Status | Required fields |
|---|---|
| `NOT_REQUESTED` | `status`, `mode` |
| `UNAVAILABLE` | `status`, `mode`, `reason` |
| `AVAILABLE` | `status`, `mode`, `market_inputs[]`, `summary`, `candidates[]` |

`market_inputs[]` entry: `expiration`, `days_to_expiry`, `mode`,
`overall_confidence`, `discount_rate_source`, `dividend_mode`,
`borrow_source`, `warnings` — 8 fields.

`summary`: `total_candidates`, `by_action`, `crr_shadow_available_count`,
`local_warning_count` — 4 fields, with `by_action` values summing to
`total_candidates`.

`candidates[]` entry (scoped to top/near-miss candidate IDs, not the full
universe): `candidate_id`, `strategy_type`, `action`, `reasons`,
`local_warnings`, `max_model_disagreement_level`, `crr_shadow_available` —
7 fields. `action` is one of `NO_ACTION`, `LOCAL_ONLY`,
`LOCAL_WITH_WARNING`, `CRR_SHADOW_REVIEW`, `HYBRID_REPRICE_CANDIDATE`.
`max_model_disagreement_level` is one of `MODEL_DISAGREEMENT_LOW`,
`MODEL_DISAGREEMENT_MEDIUM`, `MODEL_DISAGREEMENT_HIGH`, or `null`.

## Tests added

All in `tests/directional_analysis.test.js`, describe block "Phase 2E.1 —
CRR hybrid diagnostic contract stabilization":

1. `NOT_REQUESTED` shape — exactly `status`+`mode`, nothing else.
2. `UNAVAILABLE` shape — exactly `status`+`mode`+`reason`; provider
   forced disabled via `buildCrrShadowMarketInputs: false` (the existing
   dependency-injection seam — `false` is not nullish, so it survives the
   `??` default in `directionalAnalysis.js` and still fails the
   typeof-function check).
3. `AVAILABLE` shape — exactly `status`+`mode`+`market_inputs`+`summary`+
   `candidates`, exercised via the real default non-IBKR provider (no
   deps override).
4. `summary` — exact 4-field shape, correct primitive types, and an
   internal consistency check (`by_action` values sum to
   `total_candidates`).
5. `candidates[]` — exact 7-field shape per entry, correct types, `action`
   constrained to the 5 documented values, `max_model_disagreement_level`
   constrained to the 3 documented values or `null`.
6. `market_inputs[]` — exact 8-field shape per entry, correct types, and
   an explicit assertion that `mode` is never `FULL_EXTERNAL_INPUTS` for
   the shipped non-IBKR provider.
7. Ranking non-interference — enabling diagnostics changes none of
   `ranking.decision_state`, `ranking.top_trade_candidate_id`,
   `top_candidates[].candidate_id`, `.score`, `.confidence`, or
   `.consideration_eligible` versus the same request with diagnostics off.

Test 7 overlaps in spirit with two pre-existing Phase 2D.2/2D.3 tests in
the same file (which already assert `candidate_id`/`top_trade_candidate_id`/
`decision_state` parity) — it was still added as a single consolidated
assertion of every field named explicitly in this phase's requirements
(`ranking.decision_state`, `ranking.top_trade_candidate_id`,
`top_candidates[].candidate_id/.score/.confidence/.consideration_eligible`),
so a future reviewer can find one test that names all six fields together
rather than reconstructing that list from several older tests.

## Validation

```
node --test tests/directional_analysis.test.js
npm run test:unit
npm run lint
```

Results:

- `tests/directional_analysis.test.js`: 34/34 pass (7 new Phase 2E.1
  cases; all pre-existing cases unaffected).
- Full unit suite (`npm run test:unit`): 342/342 pass.
- Lint: 0 errors, 9 pre-existing warnings in unrelated files (unchanged).

## What this phase does not do

- Does not change production pricing, ranking, confidence, eligibility, or
  recommendations — no source module outside the test file was modified.
- Does not expand the diagnostic path toward `FULL_EXTERNAL_INPUTS` or a
  live borrow/discount-rate provider.
- Does not attempt or evaluate a production ranking switch to CRR.
- Does not add IBKR as a dependency.

## Verdict

**PASS.** The public shape of `diagnostics.crr_hybrid_policy` is now
documented as a standalone contract
(`docs/crr-hybrid-diagnostic-contract.md`) and locked down by 7 new,
type/shape-precise tests that will fail on any silent field
addition/removal/rename or status-value drift, independent of the
existing behavioral test coverage. No code changes were needed beyond the
tests themselves — the shape Phase 2D shipped already matched what this
phase set out to freeze.

## Next recommended phase

Phase 2E.2 or later — candidates for future work, none of which are
started by this phase:

- A live borrow/discount-rate provider (IBKR or equivalent) to finally
  exercise the `FULL_EXTERNAL_INPUTS` / `HIGH`-confidence market-input
  path this contract has documented as unreached.
- An automated, scheduled re-run of the Phase 2D.4–2D.6 live MCP
  validations (currently manual/point-in-time) to catch drift over time
  and across a broader symbol universe.
- If/when either of the above lands, a Phase 2F migration-readiness
  reassessment — not before.
