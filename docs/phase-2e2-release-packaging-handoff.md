# Phase 2E.2 — Release Packaging / Branch Handoff

**Date:** 2026-09-04
**Branch:** `phase-2d-hybrid-policy`
**Prepared against:** `7f44cc8f903af0f6a1fe6daca0aec97657f9fa64`
**Type:** Packaging/handoff only — no code changes expected or made.

Note: this document's own commit necessarily lands after the commit above
(a handoff doc can't cite the hash of its own commit in advance). Treat
`main..phase-2d-hybrid-policy` (i.e. the actual branch HEAD at PR-open
time) as authoritative for the exact commit count and hash — this doc's
own commit, and any small docs-only polish commit after it, add no
further source changes to what's described below.

## Executive summary

The `phase-2d-hybrid-policy` branch is ready to merge. It adds a
**guarded, opt-in CRR (Cox-Ross-Rubinstein binomial tree) diagnostic
layer** to `options_analyze_directional` that shows where an alternative
pricing model agrees or disagrees with the local-Greek approximation that
actually drives production ranking — without ever touching that
production ranking. The feature has been validated at four levels: unit
tests, a live scripted acceptance run, live MCP-tool calls over a real
CDP connection to TradingView Desktop (bullish and bearish, both decision
states), and a frozen, tested public contract. Migration to CRR as a
production pricing/ranking source was explicitly evaluated and rejected
for now (Phase 2E.0); this branch ships the diagnostic, not a migration.

## Branch and commit range

- **Branch:** `phase-2d-hybrid-policy`
- **Merge base with `main`:** `0ac960ad548597d0d1e5fb2bf7bd9a7a50faa87b`
- **Head:** `7f44cc8f903af0f6a1fe6daca0aec97657f9fa64`
- **Total commits ahead of `main`:** 29

That commit range includes the full options-feasibility feature arc
(chain reading, strategy candidate generation, scenario pricing, ranking,
the directional-analysis orchestrator, and the CRR shadow-pricing
groundwork) going back to `fb29e95` (2026-07-21). **This handoff document
scopes specifically to the Phase 2D/2E CRR hybrid diagnostic work**, which
is the self-contained, decision-complete portion of the branch:

| From | To | Scope |
|---|---|---|
| `a6efec63b9ab394fbe427bdbcc36de004ffeeed4` | `7f44cc8f903af0f6a1fe6daca0aec97657f9fa64` | Phase 2D → 2E.2: hybrid CRR policy evaluator through contract stabilization and this handoff |

The pre-2D commits (options chain/candidates/scenarios/ranking/directional
analysis, IBKR adapter, CRR shadow scenario engine, joint carry
estimators) are prerequisite infrastructure this diagnostic layer builds
on; they are not re-evaluated here and are assumed already accepted as
part of the branch's earlier phases (2A–2C).

## What is ready to ship

- **The hybrid CRR policy evaluator** (`src/core/options/marketInputs/hybridCrrPolicy.js`)
  — a pure, deterministic classifier with 5 action states
  (`NO_ACTION`, `LOCAL_ONLY`, `LOCAL_WITH_WARNING`, `CRR_SHADOW_REVIEW`,
  `HYBRID_REPRICE_CANDIDATE`). No pricing, no mutation, no I/O.
- **The guarded integration point** in `directionalAnalysis.js`: an
  opt-in `include_crr_hybrid_diagnostics` flag surfacing results solely at
  `diagnostics.crr_hybrid_policy`, fully isolated from `ranking`,
  `top_candidates`, `scenario_quality_summary`, `consideration_eligible`,
  and `ai_contract.allowed_candidate_ids`.
- **The default non-IBKR market-input provider**
  (`tradingViewCrrShadowMarketInputs.js`) — diagnostics work out of the
  box with zero manual wiring, using TradingView key-stats and a frozen
  Treasury fallback table; borrow is always explicitly unavailable, never
  a silent zero.
- **The frozen, documented public contract**
  (`docs/crr-hybrid-diagnostic-contract.md`) with exact field shapes for
  all three statuses, backed by 7 shape/type-precise tests in
  `tests/directional_analysis.test.js` in addition to the 8 behavioral
  tests in `tests/hybrid_crr_policy.test.js`.
- **Live evidence** across bullish, bearish, `NO_TRADE_BASELINE_ONLY`,
  and `TRADE_CANDIDATES_AVAILABLE` states, through both a scripted
  acceptance run and the real MCP tool boundary (see Validation evidence
  below).

## What is explicitly not being shipped

- **No CRR production migration.** Local-Greek (`LOCAL_GREEK_APPROXIMATION`)
  remains the unconditional production default for all scenario pricing,
  scoring, confidence, and eligibility.
- **No production ranking switch.** `ranking.model` is `RANKING_MODEL_V1`
  in every packet, with or without diagnostics requested.
- **No IBKR dependency.** The shipped provider calls
  `resolveBorrowWithPrecedence({ ibkrResult: null })` unconditionally;
  IBKR integration remains a deferred, optional future capability, not
  infrastructure this branch requires.
- **No `FULL_EXTERNAL_INPUTS` / HIGH-confidence market-input path.** By
  construction, the shipped provider cannot produce this mode (no live
  borrow source available) — every live and unit-test record observed is
  `PARTIAL_EXTERNAL_INPUTS` at LOW or MEDIUM confidence.
- **No automated/scheduled regression harness.** All live validation
  (2D.1, 2D.4–2D.6) is manual and point-in-time; this branch does not add
  CI-driven or scheduled re-runs. (Explicitly out of scope per this
  phase's instructions, not an oversight.)
- **No live Treasury fetcher.** The discount-rate input remains a frozen,
  manually-refreshed fallback table (`FALLBACK_TREASURY_BILL_RATES`,
  dated `2026-09-01`), tagged `TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE` in
  every record.

## Public contract summary

Full detail: `docs/crr-hybrid-diagnostic-contract.md`. Summary:

`diagnostics.crr_hybrid_policy` on `options_analyze_directional`'s
response, gated behind `include_crr_hybrid_diagnostics: true` (default
false → `status: "NOT_REQUESTED"`):

| Status | Fields |
|---|---|
| `NOT_REQUESTED` | `status`, `mode` |
| `UNAVAILABLE` | `status`, `mode`, `reason` |
| `AVAILABLE` | `status`, `mode`, `market_inputs[]`, `summary`, `candidates[]` |

`mode` is always `"DIAGNOSTIC_ONLY_NO_RANKING_CHANGE"`, in every status,
by design — a consumer reading only that one field can confirm nothing
here ever altered ranking, without needing to branch on `status` first.

`candidates[]` is scoped to candidate IDs already present in
`top_candidates`/`near_miss_candidates` — it is not a dump of the full
evaluated universe (that count lives in `summary.total_candidates`).

## User/agent safety rules

Restated from `docs/crr-hybrid-diagnostic-contract.md` and already
present in `CLAUDE.md`'s Options Copilot Operating Standard:

1. `HYBRID_REPRICE_CANDIDATE` is a data-quality/model-disagreement flag,
   **not** a trade recommendation, buy/sell signal, or endorsement.
2. A market-input record's `overall_confidence` describes confidence in
   the *pricing inputs* (discount/dividend/borrow), and is unrelated to
   `top_candidates[].confidence`, which describes confidence in the
   *scenario model*. Never conflate the two.
3. Never answer "is this candidate good" from `crr_hybrid_policy` — that
   answer comes only from `score`, `confidence`, and
   `consideration_eligible` in `top_candidates`.
4. Diagnostics should be surfaced only when a user asks about pricing
   model agreement, data quality, or CRR specifically — not injected
   unprompted into a normal trade discussion, since they carry no
   actionable signal on their own.

## Validation evidence summary

### Unit tests

- `tests/hybrid_crr_policy.test.js` — 8 behavioral tests: clean-agreement,
  major-warning + high disagreement → reprice, major-warning + low
  disagreement → review, moderate-warning routing, CRR-unavailable
  fallback, baseline exclusion, aggregate summary counts. (Phase 2D)
- `tests/directional_analysis.test.js` — CRR-diagnostic-relevant coverage:
  `NOT_REQUESTED` default (Phase 2D.2), explicit provider-disabled
  `UNAVAILABLE` (Phase 2D.2/2D.3), default-provider `AVAILABLE` with
  dividend-mode branching (Phase 2D.3), ranking-parity with diagnostics
  on/off (Phase 2D.2/2D.3), plus 7 new shape/type-precise contract tests
  (Phase 2E.1) covering exact field sets for all three statuses,
  `market_inputs[]`, `candidates[]`, `summary` consistency, and the
  `FULL_EXTERNAL_INPUTS` ceiling.
- Full suite: **342/342 pass** (`npm run test:unit`, verified again this
  phase — see Validation below).

### Lint

- `npm run lint`: **0 errors**, 9 pre-existing warnings in unrelated files
  (unchanged across every phase in this series).

### Live script validation

- **Phase 2D.1** — the policy run directly (not via MCP tool) against a
  live TradingView chain for NVDA/AAPL/PANW across two scenario sets:
  5/5 top-5 overlap between local and CRR-shadow rankings for all
  symbols, zero top-5 membership changes, one correctly-flagged
  intra-top-5 order swap.

### Real MCP tool validation

- **Phase 2D.4** (bullish) — `options_analyze_directional` called as an
  actual MCP tool over a live CDP connection to TradingView Desktop for
  NVDA/AAPL/PANW: diagnostics `AVAILABLE`/`DIAGNOSTIC_ONLY_NO_RANKING_CHANGE`,
  ranking untouched, LOW-confidence spreads correctly never promoted to
  eligible.
- **Phase 2D.5** (bearish) — same live MCP tool path, bearish direction,
  same three symbols: PASS, though all three landed on
  `NO_TRADE_BASELINE_ONLY` (a real, correctly-preserved baseline, not a
  bug) — identified as a coverage gap.
- **Phase 2D.6** (bearish eligible-trade) — closed that gap: root-caused
  the `NO_TRADE_BASELINE_ONLY` result to a structural `LARGE_TIME_STEP`
  confidence cap at short DTE and 30-day horizon, then found a live
  parameter set (widened DTE window, no threshold relaxation) that
  reached `TRADE_CANDIDATES_AVAILABLE` for all three symbols with
  diagnostics and ranking guarantees still holding; also surfaced
  `LONG_PUT` as a live eligible top candidate for the first time.

### Bullish and bearish coverage

| Direction | Decision state exercised live | Phase |
|---|---|---|
| Bullish | `TRADE_CANDIDATES_AVAILABLE` | 2D.4 |
| Bearish | `NO_TRADE_BASELINE_ONLY` | 2D.5 |
| Bearish | `TRADE_CANDIDATES_AVAILABLE` | 2D.6 |

Both directions and both decision states have live MCP-tool evidence with
diagnostics enabled; no combination was skipped.

## Migration decision summary

Per `docs/phase-2e0-phase-2d-rollup-migration-decision.md`:

| Question | Decision |
|---|---|
| Full CRR migration (replace local-Greek in production)? | **No** |
| Guarded hybrid diagnostic path (opt-in, isolated)? | **Yes — ship** |
| Production ranking switch to consume CRR output? | **No** |
| IBKR / `FULL_EXTERNAL_INPUTS` dependency required? | **No — optional/future only** |

## Known caveats and future work

- `FULL_EXTERNAL_INPUTS`/HIGH-confidence market-input path remains
  unexercised — requires a live borrow/discount-rate provider (e.g. a
  funded IBKR connection) not present in this codebase.
- Live borrow is unavailable; every market-input record's `borrow_source`
  is `NOT_CONNECTED`.
- The Treasury discount input is a frozen fallback table, not a live
  fetch — needs periodic manual refresh.
- No automated/scheduled regression exists for the live MCP-tool
  validations; all evidence to date is manually triggered and point-in-time
  on a small symbol set (NVDA, AAPL, PANW).
- None of the above block this merge — they are documented, bounded gaps
  consistent with the "diagnostic only" scope this branch was always
  targeting, not defects.

## Recommended merge/PR checklist

- [ ] Confirm `npm run test:unit` passes on the merge commit (342/342 at
      time of this handoff).
- [ ] Confirm `npm run lint` has 0 errors on the merge commit (9
      pre-existing warnings acceptable).
- [ ] Confirm no diff touches production ranking/scoring/pricing files
      outside the guarded `diagnostics.crr_hybrid_policy` path (verified
      throughout 2D.2–2E.1 via ranking-parity tests; no such diff exists
      as of this handoff).
- [ ] Reviewer reads `docs/crr-hybrid-diagnostic-contract.md` before
      approving — it's the one doc a future consumer actually needs.
- [ ] Confirm `CLAUDE.md`'s Options Copilot Operating Standard already
      covers `crr_hybrid_policy` safety language (it does, as of this
      branch — no further doc changes required there).
- [ ] After merge, no immediate follow-up action is required — this is a
      complete, self-contained diagnostic feature increment.

## Rollback/safety note

This feature is additive and gated behind an opt-in request flag
(`include_crr_hybrid_diagnostics`, default `false`). Reverting is
low-risk in either direction:

- **If a problem is found post-merge:** callers who never pass
  `include_crr_hybrid_diagnostics: true` are entirely unaffected — no
  rollback is needed for them. For callers who do pass it, the field can
  be ignored/stripped downstream without touching ranking, since nothing
  in `top_candidates`/`ranking`/`baselines` depends on it (verified by
  the ranking-parity tests in `tests/directional_analysis.test.js`).
- **Full revert:** reverting the 2D→2E.2 commit range removes the
  `diagnostics.crr_hybrid_policy` field and the `include_crr_hybrid_diagnostics`
  request parameter entirely; no other production behavior changes as a
  result, since this range never modified `strategyCandidates.js`,
  `strategyScenarios.js`, or `strategyRanking.js`.
- **No data migration, no schema migration, no external state** is
  created or depended on by this feature — it is a pure, stateless,
  request-scoped computation.

## Suggested PR title

`feat: guarded CRR hybrid diagnostic path (opt-in, ranking-isolated)`

## Suggested PR description

```markdown
## Summary

Adds an opt-in, evidence-only CRR (Cox-Ross-Rubinstein binomial tree)
diagnostic to `options_analyze_directional`, surfaced at
`diagnostics.crr_hybrid_policy`. It shows where an alternative pricing
model agrees or disagrees with the local-Greek approximation that drives
production ranking — without ever influencing that ranking. Full CRR
migration was evaluated and explicitly rejected for now; see
`docs/phase-2e0-phase-2d-rollup-migration-decision.md`.

## What changed

- New hybrid CRR policy evaluator (`hybridCrrPolicy.js`): classifies
  candidates into `NO_ACTION` / `LOCAL_ONLY` / `LOCAL_WITH_WARNING` /
  `CRR_SHADOW_REVIEW` / `HYBRID_REPRICE_CANDIDATE`.
- New opt-in request flag `include_crr_hybrid_diagnostics` on
  `options_analyze_directional`, surfacing results solely at
  `diagnostics.crr_hybrid_policy`.
- New default non-IBKR market-input provider
  (`tradingViewCrrShadowMarketInputs.js`) — works with zero manual
  wiring; always `PARTIAL_EXTERNAL_INPUTS`, borrow always explicit
  `NOT_CONNECTED`.
- Frozen, documented, tested public contract:
  `docs/crr-hybrid-diagnostic-contract.md` + 7 new shape-precise tests.

## What did not change

- Local-Greek scenario pricing, `ranking.model` (`RANKING_MODEL_V1`),
  scoring, confidence, eligibility, and recommendations — byte-identical
  with diagnostics on vs. off, verified by tests and live MCP-tool runs.
- No IBKR dependency added or required.
- No `FULL_EXTERNAL_INPUTS`/HIGH-confidence path — not reachable by the
  shipped provider by construction.

## Validation

- Unit: 342/342 pass (`npm run test:unit`).
- Lint: 0 errors, 9 pre-existing unrelated warnings (`npm run lint`).
- Live script acceptance (Phase 2D.1): 5/5 top-5 overlap, zero top-5
  membership changes, NVDA/AAPL/PANW.
- Live real-MCP-tool validation, bullish (2D.4) and bearish (2D.5, 2D.6),
  covering both `NO_TRADE_BASELINE_ONLY` and `TRADE_CANDIDATES_AVAILABLE`
  decision states, over an actual CDP connection to TradingView Desktop.

## Caveats / future work

- `FULL_EXTERNAL_INPUTS`/HIGH-confidence market inputs remain unreached
  pending a live borrow/discount-rate provider (e.g. funded IBKR) — not
  a blocker, a documented future extension point.
- Treasury discount rate is a frozen, periodically-refreshed fallback
  table, not a live fetch.
- No automated/scheduled regression yet for the live MCP validations —
  all evidence is manual/point-in-time on NVDA/AAPL/PANW.

## Safety contract

`diagnostics.crr_hybrid_policy` is opt-in, evidence-only, and must never
be treated as a recommendation, score override, or pricing switch —
`HYBRID_REPRICE_CANDIDATE` flags a pricing-model disagreement, not a
trade signal. Full rules: `docs/crr-hybrid-diagnostic-contract.md`.
```
