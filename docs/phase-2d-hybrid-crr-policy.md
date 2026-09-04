# Phase 2D — Hybrid CRR Policy Diagnostic

Date: 2026-09-02
Branch: `phase-2d-hybrid-policy`

## Verdict

**Hybrid CRR policy is now encoded as a diagnostic layer, not production
migration.**

This step turns the Phase 2C.3 / 2C.4 findings into deterministic policy
output:

- keep local-Greek pricing where candidates are clean and CRR agrees
- keep CRR in shadow review when local warnings appear but disagreement is low
- mark candidates as hybrid reprice candidates only when major local warnings
  combine with material CRR disagreement
- do not block on IBKR or real borrow availability
- do not change production scenario pricing, ranking, or user-facing output

## Rationale

Phase 2C.3 showed that the AAPL rank instability was explainable and localized
to warning-region repricing, especially `LARGE_TIME_STEP`.

Phase 2C.4 showed that synthetic borrow inputs are not the primary live ranking
driver at normal fee levels. IBKR remains useful as a future provider, but it
should not block the next migration decision.

The correct next step is therefore a hybrid policy:

1. trust local-Greek approximation in clean/low-disagreement regions
2. use CRR shadow as evidence in warning regions
3. consider CRR repricing only when warning-region disagreement is material

## Added Module

`src/core/options/marketInputs/hybridCrrPolicy.js`

Exports:

- `HYBRID_CRR_ACTIONS`
- `HYBRID_CRR_REASONS`
- `evaluateHybridCrrPolicyForCandidate(localCandidate, crrShadowCandidate, opts)`
- `evaluateHybridCrrPolicy(localCandidates, crrShadowCandidates, opts)`

The evaluator consumes already-generated local and CRR-shadow scenario results.
It does not fetch data, does not price options, and does not mutate candidates.

## Actions

`NO_ACTION`

Used for non-option baselines such as `BUY_STOCK` and `NO_TRADE`.

`LOCAL_ONLY`

Used when local scenarios have no relevant warnings and CRR shadow disagreement
is low.

`LOCAL_WITH_WARNING`

Used when local scenario data or CRR shadow evidence is unavailable. This keeps
the current local behavior explicit without pretending CRR validated it.

`CRR_SHADOW_REVIEW`

Used when warning or disagreement evidence exists, but the evidence is not yet
strong enough to route the candidate to hybrid repricing.

`HYBRID_REPRICE_CANDIDATE`

Used when major local warnings, currently `LARGE_TIME_STEP` or
`NEAR_EXPIRATION`, combine with medium/high CRR-vs-local model disagreement.

## Tests

Added:

`tests/hybrid_crr_policy.test.js`

Covered cases:

- clean local candidate plus low CRR disagreement stays `LOCAL_ONLY`
- `LARGE_TIME_STEP` plus high disagreement becomes
  `HYBRID_REPRICE_CANDIDATE`
- `NEAR_EXPIRATION` plus low disagreement stays under `CRR_SHADOW_REVIEW`
- moderate warnings route to review, not automatic reprice
- unavailable CRR shadow falls back to `LOCAL_WITH_WARNING`
- stock/no-trade baselines are excluded from hybrid repricing
- aggregate policy summary counts actions across candidates

## Validation

Commands run:

```bash
node --test tests/hybrid_crr_policy.test.js tests/market_conventions_and_shadow.test.js tests/strategy_ranking.test.js
npm run lint
```

Results:

- 50 tests passed
- 0 test failures
- lint had 0 errors
- lint still reports pre-existing warnings in unrelated files

## Migration Status

Still **not ready for full CRR migration**.

Phase 2D supports the hybrid path:

- local-Greek remains the default production path
- CRR shadow remains evidence-only
- warning-region candidates are now classifiable for future guarded repricing

Recommended next step:

Run the Phase 2D policy over one more live active-market sample and compare:

- local top-5
- CRR shadow top-5
- hybrid policy actions for each top/local-near-top candidate
- whether `HYBRID_REPRICE_CANDIDATE` flags explain all top-5 movement
