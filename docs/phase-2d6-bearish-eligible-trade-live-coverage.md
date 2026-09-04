# Phase 2D.6 — Bearish Eligible-Trade MCP Live Coverage

**Date:** 2026-09-03
**Branch:** `phase-2d-hybrid-policy`
**Base commit:** `1a933f4ba51adc03d73a7049b7eca7db055e4fdb`

## Purpose

Phase 2D.5 validated the bearish MCP tool path but every symbol landed on
`NO_TRADE_BASELINE_ONLY` — a real but incomplete result, since the
`TRADE_CANDIDATES_AVAILABLE` decision path (an eligible top trade
candidate, not just the baseline) was never exercised live for a bearish
thesis. Phase 2D.6 closes that gap: find at least one live bearish MCP
tool run that reaches `TRADE_CANDIDATES_AVAILABLE`, without relaxing
ranking/eligibility rules and without changing code.

## MCP health

CDP was already connected from the prior session. `tv_health_check`
passed on the first call (`cdp_connected: true`, `chart_symbol:
"BATS:ETN"`, `api_available: true`). No repo files were touched during
the health check. An MCP server update was again noted and not acted on,
per instructions.

## Root cause investigation (why 2D.5 always hit NO_TRADE)

Before searching parameters blindly, the ranking/confidence code was
inspected (`src/core/options/strategyRanking.js`,
`src/core/options/optionRepricer.js`) to understand *why* every
`BEAR_PUT_SPREAD` in Phase 2D.5 was blocked despite scores up to 81.81:

- `scenarioModelConfidence()` (`strategyRanking.js:126`) forces
  `confidence: LOW` whenever any required scenario carries a MAJOR
  warning — `LARGE_TIME_STEP` or `NEAR_EXPIRATION`
  (`strategyRanking.js:23`).
- `optionRepricer.js:124` sets `LARGE_TIME_STEP` whenever `daysForward >
  Math.min(30, 0.5 * daysToExpiry)`.
- At `horizon_days: 30` (so `daysForward = 30`), this is true for
  **any** contract with `daysToExpiry < 60` — i.e. it is structurally
  unavoidable for the `min_dte: 30, max_dte: 75` window Phase 2D.4/2D.5
  used by default, regardless of direction, symbol, or target price.

This is not a bug: it is the local-Greek approximation honestly flagging
that a 30-day step is "large" relative to a near-dated contract's
remaining life, and the ranking model correctly treats that as
`LOW` confidence, which the default `minimum_confidence_for_consideration:
MEDIUM` gate then correctly rejects. The fix is a parameter choice, not a
code change: widen the expiration window so selected contracts have
`daysToExpiry >= 60`, at which point `Math.min(30, 0.5*60..90) = 30` and
`daysForward(30) > 30` is false — `LARGE_TIME_STEP` never fires, and
`scenarioModelConfidence` can reach `MEDIUM`/`HIGH` on its own merits
(spread width, `INTRINSIC_FLOOR_APPLIED`, etc.).

## Parameter search

**Single bounded attempt, no threshold relaxation.** Live spot was read
via `quote_get` immediately before each call. All three symbols were run
once with:

- `direction: bearish`
- `horizon_days: 30`
- `max_loss: 2500` (relaxed from 2D.5's 1000, per the task's suggested
  grid, to allow wider/costlier spreads at the longer-dated expirations)
- `min_dte: 60`, `max_dte: 90` (widened from the 30/75 default —
  the change that eliminates `LARGE_TIME_STEP`)
- `max_spread_pct: 25` (relaxed from the 15 default, per the task's
  suggested grid, since fewer/further-dated contracts are available)
- `base_target_price` ≈ 8% below live spot
- all three IV shocks explicit `0`
- `include_crr_hybrid_diagnostics: true`
- **`minimum_score_for_consideration` and
  `minimum_confidence_for_consideration` left at their production
  defaults (60 / MEDIUM) — not relaxed.** This distinction matters: the
  fix here was making the ranking model *legitimately* reach
  MEDIUM/HIGH confidence by choosing an expiration window that avoids a
  structural warning, not by lowering the bar for what counts as
  eligible.

All three symbols reached `TRADE_CANDIDATES_AVAILABLE` on this first
attempt — see `docs/fixtures/phase2d6-bearish-eligible-trade-live-coverage-20260903/attempts-summary.md`
for the full search rationale and `{nvda,aapl,panw}-attempt1-success.json`
for the raw evidence. No second attempt, no additional symbols (TSLA/META/AMD
were not needed), and no relaxed score/confidence thresholds were required.

## Successful eligible-trade runs

| Symbol | Spot | Target | Decision state | Top trade candidate | Score | Confidence |
|---|---|---|---|---|---|---|
| NASDAQ:NVDA | 229.255 | 211 (-8.0%) | TRADE_CANDIDATES_AVAILABLE | `BEAR_PUT_SPREAD` 2026-11-20 P225/P230 | 80.02 | HIGH |
| NASDAQ:AAPL | 327.68 | 301 (-8.1%) | TRADE_CANDIDATES_AVAILABLE | `BEAR_PUT_SPREAD` 2026-11-20 P320/P330 | 85.20 | MEDIUM |
| NASDAQ:PANW | 329.655 | 303 (-8.1%) | TRADE_CANDIDATES_AVAILABLE | `BEAR_PUT_SPREAD` 2026-11-20 P310/P330 | 65.95 | MEDIUM |

### NVDA — top 5 (all `BEAR_PUT_SPREAD`, all HIGH confidence except rank 5 is HIGH too)

1. P225/P230 — score 80.02, HIGH, eligible
2. P220/P230 — score 77.63, HIGH, eligible
3. P225/P235 — score 76.38, HIGH, eligible
4. P220/P235 — score 74.53, HIGH, eligible
5. P215/P230 — score 74.33, HIGH, eligible

`LONG_PUT` did not appear in NVDA's top 10 (all 10 were `BEAR_PUT_SPREAD`)
— see coverage table below.

### AAPL — top 5 (mixed `BEAR_PUT_SPREAD`/`LONG_PUT`)

1. `BEAR_PUT_SPREAD` P320/P330 — score 85.20, MEDIUM, eligible
2. `BEAR_PUT_SPREAD` P325/P330 — score 84.57, MEDIUM, eligible
3. `BEAR_PUT_SPREAD` P315/P330 — score 82.77, MEDIUM, eligible
4. `BEAR_PUT_SPREAD` P325/P335 — score 82.12, MEDIUM, eligible
5. `BEAR_PUT_SPREAD` P320/P335 — score 81.45, MEDIUM, eligible

`LONG_PUT` P330, P335, P340, and P325 appear at ranks 6, 7, 9, and 10
respectively (scores 79.31 → 75.66, all MEDIUM confidence, all
`consideration_eligible: true`) — the first live evidence in this Phase
2D series of `LONG_PUT` surfacing as an eligible top candidate.

### PANW — top 5 (all `BEAR_PUT_SPREAD`)

1. P310/P330 — score 65.95, MEDIUM, eligible
2. P310/P340 — score 65.30, MEDIUM, eligible
3. P300/P330 — score 65.05, MEDIUM, eligible
4. P320/P340 — score 63.40, MEDIUM, eligible
5. P320/P330 — score 63.26, MEDIUM, eligible

Ranks 8–10 (scores 58.83, 57.85, 56.68) fell below the (unrelaxed) 60-point
`minimum_score_for_consideration` threshold and were correctly marked
`consideration_eligible: false` with reason `SCORE_BELOW_THRESHOLD` — the
existing gate worked exactly as designed even inside an otherwise-eligible
run; wider spreads (PANW's put IV/spread widths are larger than NVDA/AAPL's)
still produced some non-eligible candidates within the same top 10.

## Failed/no-trade attempts summary

See `docs/fixtures/phase2d6-bearish-eligible-trade-live-coverage-20260903/attempts-summary.md`.
In short: Phase 2D.5's default-window run (30/75 DTE, `max_loss: 1000`,
default `max_spread_pct: 15`, no threshold relaxation) is the known
failing baseline this phase addresses — every symbol there hit
`NO_TRADE_BASELINE_ONLY` because `LARGE_TIME_STEP` structurally capped
confidence at LOW for near-dated contracts at a 30-day horizon. It was not
re-run in this phase since it is already fully documented in
`docs/phase-2d5-bearish-mcp-tool-live-validation.md`. This phase's single
widened-window attempt (min_dte 60/max_dte 90) succeeded for all three
symbols on the first try, so no further failed attempts were generated in
this phase.

## Bearish strategy coverage

| Symbol | `BEAR_PUT_SPREAD` in top 10 | `LONG_PUT` in top 10 | `LONG_PUT` in near-miss | Notes |
|---|---|---|---|---|
| NVDA | Yes (10/10) | No | N/A (near_miss empty; decision already TRADE_CANDIDATES_AVAILABLE) | All-spread top 10 |
| AAPL | Yes (6/10) | Yes (4/10 — ranks 6,7,9,10) | N/A | First live confirmation of `LONG_PUT` reaching an eligible top-10 slot in this phase series |
| PANW | Yes (10/10) | No | N/A | All-spread top 10; widest bid/ask spreads (IV ~47-52%) of the three symbols |

`near_miss_candidates` was empty (`[]`) for all three symbols in this
phase, as expected — near-miss candidates are only populated when
`decision_state === NO_TRADE_BASELINE_ONLY` (`directionalAnalysis.js:507`),
and all three runs here reached `TRADE_CANDIDATES_AVAILABLE`.

## CRR diagnostic status

| Symbol | `status` | `mode` | total candidates | by_action |
|---|---|---|---|---|
| NVDA | AVAILABLE | DIAGNOSTIC_ONLY_NO_RANKING_CHANGE | 35 | LOCAL_ONLY 16, CRR_SHADOW_REVIEW 18, NO_ACTION 1 |
| AAPL | AVAILABLE | DIAGNOSTIC_ONLY_NO_RANKING_CHANGE | 31 | CRR_SHADOW_REVIEW 29, LOCAL_ONLY 1, NO_ACTION 1 |
| PANW | AVAILABLE | DIAGNOSTIC_ONLY_NO_RANKING_CHANGE | 27 | LOCAL_ONLY 23, CRR_SHADOW_REVIEW 3, NO_ACTION 1 |

New action value observed this phase: `LOCAL_ONLY` with reason
`LOCAL_CLEAN_AND_CRR_AGREES` — meaning the CRR shadow price agreed closely
enough with the local-Greek price that no review flag was raised. This
action value did not appear in Phase 2D.4/2D.5's near-dated (30-75 DTE)
runs, where every candidate had at least one local warning; at the wider
60-90 DTE window used here, many candidates cleared with zero local
warnings and low model disagreement, producing `LOCAL_ONLY` for the first
time in this phase series. This is additional evidence the diagnostic
path differentiates real candidates (not a constant), and it remains
purely informational — `ranking.model` stayed `RANKING_MODEL_V1` for all
three, confirming production ranking never switched to CRR.

`crr_shadow_available_count` equaled `total_candidates` for all three
symbols — CRR shadow repricing ran for every generated candidate,
including the newly-surfaced `LONG_PUT` candidates for AAPL.

## Market input status

| Symbol | Expiration sampled | Mode | Overall confidence | Dividend mode | Borrow source | Warnings |
|---|---|---|---|---|---|---|
| NVDA | 2026-11-20 (78 DTE) | PARTIAL_EXTERNAL_INPUTS | LOW | TRAILING_DIVIDEND_YIELD_APPROXIMATION | NOT_CONNECTED | TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE, CONTINUOUS_DIVIDEND_APPROXIMATION, TRAILING_NOT_FORWARD, BORROW_DATA_UNAVAILABLE |
| AAPL | 2026-11-20 (78 DTE) | PARTIAL_EXTERNAL_INPUTS | LOW | TRAILING_DIVIDEND_YIELD_APPROXIMATION | NOT_CONNECTED | TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE, CONTINUOUS_DIVIDEND_APPROXIMATION, TRAILING_NOT_FORWARD, BORROW_DATA_UNAVAILABLE |
| PANW | 2026-11-20 (78 DTE) | PARTIAL_EXTERNAL_INPUTS | MEDIUM | ZERO_DIVIDEND_CONFIRMED | NOT_CONNECTED | TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE, BORROW_DATA_UNAVAILABLE |

Identical pattern to Phase 2D.4/2D.5: no market-input record reached
`FULL_EXTERNAL_INPUTS`, borrow stayed explicitly `NOT_CONNECTED` /
`BORROW_DATA_UNAVAILABLE` for the one sampled expiration per symbol (the
candidate set here concentrated on a single 2026-11-20 expiration inside
the 60-90 DTE window, unlike the 2-3 expirations sampled in earlier
phases' narrower windows), and no IBKR dependency appeared anywhere.

## Acceptance criteria — checklist

- [x] At least one attempted run reached `TRADE_CANDIDATES_AVAILABLE` —
      all three did.
- [x] The successful runs still have `diagnostics.crr_hybrid_policy.status:
      AVAILABLE` for all three.
- [x] Diagnostic mode remains `DIAGNOSTIC_ONLY_NO_RANKING_CHANGE` for all
      three.
- [x] Market inputs remain non-IBKR and never `FULL_EXTERNAL_INPUTS` —
      confirmed `PARTIAL_EXTERNAL_INPUTS` for all three.
- [x] Borrow remains explicitly unavailable
      (`NOT_CONNECTED`/`BORROW_DATA_UNAVAILABLE`) for all three.
- [x] Ranking output remains local-Greek ranking — `ranking.model:
      RANKING_MODEL_V1` for all three; CRR shadow never became the
      ranking source.
- [x] No thresholds were relaxed — `minimum_score_for_consideration` (60)
      and `minimum_confidence_for_consideration` (MEDIUM) stayed at
      production defaults for every run in this phase. `max_loss`,
      `min_dte`/`max_dte`, and `max_spread_pct` were the only parameters
      adjusted, and are clearly labeled above as validation-scope
      parameter choices, not eligibility relaxations or recommendations.
- [x] No source code changes were made — none were needed.

All acceptance criteria met.

## Verdict

**PASS.** A live bearish MCP tool run reaching `TRADE_CANDIDATES_AVAILABLE`
was found for all three test symbols (NVDA, AAPL, PANW) by widening the
expiration window (`min_dte: 60, max_dte: 90`) to avoid the structural
`LARGE_TIME_STEP` confidence penalty inherent to near-dated contracts at a
30-day horizon — a parameter choice, not a code change, and one that did
not touch consideration thresholds. The CRR hybrid diagnostics remained
`AVAILABLE` / `DIAGNOSTIC_ONLY_NO_RANKING_CHANGE` throughout, market
inputs stayed `PARTIAL_EXTERNAL_INPUTS` with borrow always unavailable and
no IBKR dependency, and production ranking stayed on `RANKING_MODEL_V1`
(local-Greek). AAPL additionally surfaced `LONG_PUT` as an eligible top
candidate alongside `BEAR_PUT_SPREAD`, giving this phase series its first
live evidence of a single-leg bearish candidate reaching an eligible
top-10 slot. No bug was found; no code changes were made.

## Caveats

- Point-in-time live validation (2026-09-03, US market hours) — not a
  regression suite; re-run after any change to candidate generation,
  ranking, or the CRR hybrid policy evaluator.
- The successful recipe used a wider `min_dte`/`max_dte` (60-90) than
  Phase 2D.4/2D.5's default (30-75), which concentrated all surfaced
  candidates on a single expiration (2026-11-20, 78 DTE) rather than the
  2-3 expirations seen in earlier narrower-window runs. This is a valid
  parameter choice for demonstrating the `TRADE_CANDIDATES_AVAILABLE`
  path, but means this run does not add new evidence about behavior
  across multiple expirations simultaneously — that remains covered by
  Phase 2D.4/2D.5's narrower-window runs.
- As in all prior 2D.x phases, no `FULL_EXTERNAL_INPUTS` / HIGH-confidence
  market-input record was observed — explicitly out of scope for this
  phase per instructions.
- `max_loss` (2500) and `max_spread_pct` (25) were relaxed from the 2D.5
  defaults (1000 / 15) as part of the bounded parameter grid the task
  specified; these affect which contracts are *eligible for candidate
  generation*, not the ranking/eligibility gates themselves
  (`minimum_score_for_consideration`, `minimum_confidence_for_consideration`),
  which were left untouched.
- Test target prices (~8% below spot) and all other parameters in this
  phase are tool-exercise inputs only, not trading theses for NVDA, AAPL,
  or PANW.
- TSLA/META/AMD were not needed and were not tried — all three original
  test symbols succeeded on the first attempt.

## Next recommended phase

Phase 2D.7 — a live/HIGH-confidence market-input provider validation (the
`FULL_EXTERNAL_INPUTS` path deferred across 2D.4, 2D.5, and 2D.6, pending a
connected discount-rate/borrow source), or a live run at the narrower
default DTE window (30-75) that still reaches `TRADE_CANDIDATES_AVAILABLE`
for a bearish thesis — e.g. by choosing a symbol/target combination where
near-dated `INTRINSIC_FLOOR_APPLIED`-only candidates (no `LARGE_TIME_STEP`)
clear MEDIUM confidence — to confirm the eligible-trade path also holds at
the shorter expiration windows used in Phase 2D.4/2D.5.
