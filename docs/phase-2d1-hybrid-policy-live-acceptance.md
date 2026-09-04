# Phase 2D.1 — Active-Market Hybrid CRR Policy Acceptance

Date: 2026-09-02
Branch: `phase-2d-hybrid-policy`
Status: `DIAGNOSTIC_ONLY_NO_PRODUCTION_SWITCH`

## Verdict

**PASS for diagnostic hybrid policy behavior.**

The Phase 2D policy was run on a fresh active-market TradingView sample for
NVDA, AAPL, and PANW. IBKR was not required.

Across both scenario sets:

- local top-5 vs CRR shadow top-5 overlap was 5/5 for all symbols
- no candidate entered or left the top-5
- clean top candidates stayed `LOCAL_ONLY`
- warning-region candidates were routed to `CRR_SHADOW_REVIEW` or
  `HYBRID_REPRICE_CANDIDATE`
- no production pricing, ranking, confidence, or user-facing behavior changed

This supports the current migration posture:

**keep local-Greek as production default, keep CRR as shadow evidence, and use
hybrid CRR only for explicitly flagged warning/disagreement regions.**

## Evidence

Raw evidence:

`docs/fixtures/phase2d1-hybrid-policy-live-20260902/phase2d1-hybrid-policy-live-20260902.json`

Run window:

- started: `2026-09-02T19:41:30.139Z`
- completed: `2026-09-02T19:42:36.349Z`

Treasury input:

- observation date: `2026-09-01`
- source: U.S. Treasury Daily Treasury Bill Rates, latest published row
  available during run

## Symbol Results

| Symbol | Contracts | Candidates | STRESS_30D top-5 | ORIGINAL_30D top-5 |
|---|---:|---:|---:|---:|
| NVDA | 218 | 66 | 5/5 | 5/5 |
| AAPL | 248 | 70 | 5/5 | 5/5 |
| PANW | 290 | 102 | 5/5 | 5/5 |

## Hybrid Policy Action Counts

Counts across all three symbols and both scenario sets:

| Action | Count |
|---|---:|
| `LOCAL_ONLY` | 152 |
| `CRR_SHADOW_REVIEW` | 71 |
| `HYBRID_REPRICE_CANDIDATE` | 241 |
| `NO_ACTION` | 12 |

Per-symbol summaries:

| Symbol | Scenario set | `LOCAL_ONLY` | `CRR_SHADOW_REVIEW` | `HYBRID_REPRICE_CANDIDATE` | `NO_ACTION` |
|---|---|---:|---:|---:|---:|
| NVDA | STRESS_30D | 20 | 12 | 32 | 2 |
| NVDA | PHASE2C_ORIGINAL_30D | 20 | 7 | 37 | 2 |
| AAPL | STRESS_30D | 20 | 23 | 25 | 2 |
| AAPL | PHASE2C_ORIGINAL_30D | 20 | 13 | 35 | 2 |
| PANW | STRESS_30D | 36 | 9 | 55 | 2 |
| PANW | PHASE2C_ORIGINAL_30D | 36 | 7 | 57 | 2 |

## Top-5 Movement

There were no top-5 membership changes:

| Symbol | Scenario set | Entered top-5 | Left top-5 |
|---|---|---:|---:|
| NVDA | STRESS_30D | 0 | 0 |
| NVDA | PHASE2C_ORIGINAL_30D | 0 | 0 |
| AAPL | STRESS_30D | 0 | 0 |
| AAPL | PHASE2C_ORIGINAL_30D | 0 | 0 |
| PANW | STRESS_30D | 0 | 0 |
| PANW | PHASE2C_ORIGINAL_30D | 0 | 0 |

PANW `STRESS_30D` had a small within-top-5 order change:

- local rank 2 became shadow rank 3 for a `2026-10-16` bull call spread
- that candidate carried `LARGE_TIME_STEP` and `INTRINSIC_FLOOR_APPLIED`
- policy action: `HYBRID_REPRICE_CANDIDATE`

That is the desired behavior: the policy does not overreact to clean candidates,
but it does flag the candidate whose ordering moved in the warning region.

## Interpretation

This run is more stable than Phase 2C.2:

- AAPL no longer shows top-5 instability in either scenario set
- NVDA remains stable
- PANW remains top-5 stable, with only an intra-top-5 rank swap under
  `STRESS_30D`

The policy is conservative: it flags many candidates because 30-day scenarios
naturally trigger `LARGE_TIME_STEP` on shorter expirations. That is acceptable
for this diagnostic phase, but it argues against turning hybrid repricing on
globally.

## Acceptance Result

Accepted:

- Phase 2D policy can be run on live TradingView chains
- it preserves clean/local regions
- it routes warning-region candidates to review/reprice candidate states
- it does not need IBKR
- it does not require full CRR migration

Not accepted yet:

- production hybrid repricing
- user-facing recommendation changes
- automatic CRR replacement of local-Greek ranking
- `FULL_EXTERNAL_INPUTS` market-input confidence

## Recommended Next Step

Proceed to **Phase 2D.2 — guarded integration design**:

Define exactly where the hybrid policy result should appear in the analysis
contract without changing ranking semantics. The likely target is a diagnostic
field near the numeric source of truth, not a production scoring switch.
