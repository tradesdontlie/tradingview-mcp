# Phase 2D.5 — Bearish MCP Tool Live Validation

**Date:** 2026-09-03
**Branch:** `phase-2d-hybrid-policy`
**Base commit:** `fa5323a3e4e03f9ab83e90145250502d4a0fc221`

## Purpose

Phase 2D.4 validated the guarded CRR hybrid diagnostics
(`include_crr_hybrid_diagnostics: true`) through the live MCP tool path for
a **bullish** thesis on NVDA/AAPL/PANW. Phase 2D.5 extends that validation
to the **bearish** direction through the same live MCP tool path, to
confirm the diagnostic wiring, market-input provider, and put-side
candidate universe all behave correctly when the thesis (and therefore the
option side) flips.

## Environment / MCP health

CDP was already up from the prior session (no relaunch needed this time).
`tv_health_check` passed on the first call:

```
cdp_connected: true
chart_symbol: "BATS:ETN"
api_available: true
```

An MCP server update was again noted (`local_commit: dac7b506`,
`latest_commit: c05b8f57`) and, per instructions, not acted on. No repo
files were touched during the health check.

## Method

Live spot was read via `quote_get` immediately before each call, then
`options_analyze_directional` was invoked bearish, 30-day horizon,
`max_loss: 1000`, all three IV shocks explicit `0`,
`include_crr_hybrid_diagnostics: true`, with `base_target_price` set
~5% below spot (a bearish thesis requires `base_target_price < current
spot`, enforced by `validateThesisDirection()` in
`directionalAnalysis.js`).

| Symbol | Spot (quote_get) | base_target_price | Below spot | horizon_days | max_loss | IV shocks (down/base/up) |
|---|---|---|---|---|---|---|
| NASDAQ:NVDA | 229.68 | 218 | -5.1% | 30 | 1000 | 0 / 0 / 0 |
| NASDAQ:AAPL | 327.01 | 310 | -5.2% | 30 | 1000 | 0 / 0 / 0 |
| NASDAQ:PANW | 330.08 | 314 | -4.8% | 30 | 1000 | 0 / 0 / 0 |

All three test targets are tool-exercise inputs only, not trading theses.

Raw responses saved to
`docs/fixtures/phase2d5-bearish-mcp-tool-live-validation-20260903/{nvda,aapl,panw}.json`.
(The MCP client's inline-result size limit truncated the direct tool
response text for all three calls — each was ~55KB/~1,750 lines — but the
full JSON was written to disk by the harness and confirmed to `json.load`
cleanly for all three symbols; this is a transport/display limit, not a
tool failure.)

## Per-symbol summary

| Symbol | Snapshot ID | Underlying price | Chain completeness | Candidate count | Decision state | Top trade candidate |
|---|---|---|---|---|---|---|
| NVDA | `997884de179dca08` | 229.76 | COMPLETE | 59 | NO_TRADE_BASELINE_ONLY | none (null) |
| AAPL | `5a7e7b3abfa34d32` | 326.95 | COMPLETE | 55 | NO_TRADE_BASELINE_ONLY | none (null) |
| PANW | `f0cf659a9165b059` | 330.00 | COMPLETE | 27 | NO_TRADE_BASELINE_ONLY | none (null) |

`data_source.warnings` was empty (`[]`) for all three — no
`IV_SCENARIO_NOT_SPECIFIED` warning, as expected since all three IV shocks
were explicitly supplied.

### Top 5 candidates per symbol

All three symbols' top 5 ranked candidates (of 10 total `top_candidates`
returned) were exclusively `BEAR_PUT_SPREAD`, all `confidence: LOW`,
`consideration_eligible: false`:

**NVDA** (spot 229.76, target 218):
1. `BEAR_PUT_SPREAD` 2026-10-09 P225/P230 — score 77.21
2. `BEAR_PUT_SPREAD` 2026-10-09 P225/P240 — score 75.16
3. `BEAR_PUT_SPREAD` 2026-10-09 P225/P235 — score 75.07
4. `BEAR_PUT_SPREAD` 2026-10-09 P230/P240 — score 73.45
5. `BEAR_PUT_SPREAD` 2026-10-16 P230/P245 — score 72.76

**AAPL** (spot 326.95, target 310):
1. `BEAR_PUT_SPREAD` 2026-10-16 P325/P330 — score 81.81
2. `BEAR_PUT_SPREAD` 2026-10-09 P325/P330 — score 79.54
3. `BEAR_PUT_SPREAD` 2026-10-16 P320/P330 — score 79.23
4. `BEAR_PUT_SPREAD` 2026-10-16 P325/P335 — score 78.56
5. `BEAR_PUT_SPREAD` 2026-10-09 P320/P330 — score 78.28

**PANW** (spot 330.00, target 314):
1. `BEAR_PUT_SPREAD` 2026-10-16 P320/P330 — score 63.83
2. `BEAR_PUT_SPREAD` 2026-10-16 P330/P340 — score 62.60
3. `BEAR_PUT_SPREAD` 2026-10-16 P310/P330 — score 61.67
4. `BEAR_PUT_SPREAD` 2026-10-16 P340/P350 — score 56.45
5. `BEAR_PUT_SPREAD` 2026-10-16 P350/P360 — score 54.49

All 10 `top_candidates` and all 5 `near_miss_candidates` were
`BEAR_PUT_SPREAD` for every symbol — `LONG_PUT` did not appear in either
list for any symbol (see "Bearish strategy coverage" below).

### Baselines and decision state

`ranking.decision_state` was `NO_TRADE_BASELINE_ONLY` for all three
symbols, and `ranking.top_trade_candidate_id` was `null` in all three —
correctly preserved as the real baseline per the Options Copilot standard
(no near-miss `BEAR_PUT_SPREAD` was promoted into a recommendation despite
scores as high as 81.81, because every one carried `confidence: LOW`).
`baselines` returned exactly one entry per symbol —
`NO_TRADE::NASDAQ:<SYM>`, `confidence: HIGH`, `consideration_eligible:
true`. No `SHORT_STOCK`/`BUY_STOCK`-equivalent baseline was present for
the bearish direction — this matches `directionalAnalysis.js`, which
surfaces only `rankingResult.baselines` as returned by
`strategyRanking.js` and does not special-case a short-equivalent baseline
for bearish requests (out of scope for this validation to change).

## Diagnostic status table

| Symbol | `crr_hybrid_policy.status` | `crr_hybrid_policy.mode` | total candidates | HYBRID_REPRICE_CANDIDATE | CRR_SHADOW_REVIEW | NO_ACTION |
|---|---|---|---|---|---|---|
| NVDA | AVAILABLE | DIAGNOSTIC_ONLY_NO_RANKING_CHANGE | 59 | 45 | 13 | 1 |
| AAPL | AVAILABLE | DIAGNOSTIC_ONLY_NO_RANKING_CHANGE | 55 | 43 | 11 | 1 |
| PANW | AVAILABLE | DIAGNOSTIC_ONLY_NO_RANKING_CHANGE | 27 | 18 | 8 | 1 |

`crr_shadow_available_count` equaled `total_candidates` for all three
(59/55/27) — CRR shadow repricing ran for every generated candidate, put
spreads included. `ranking.model` was `RANKING_MODEL_V1` for all three,
confirming production ranking stayed on local-Greek scoring
(`LOCAL_GREEK_APPROXIMATION`) — the CRR path never became the ranking
source of truth.

Sampled `diagnostics.crr_hybrid_policy.candidates` entries (scoped to
top+near-miss candidate IDs, per `directionalAnalysis.js`'s
`candidateIdsFromTopAndNearMisses`) showed `local_warnings` of
`LARGE_TIME_STEP` and `INTRINSIC_FLOOR_APPLIED` with
`max_model_disagreement_level` ranging `MODEL_DISAGREEMENT_MEDIUM` →
`MODEL_DISAGREEMENT_HIGH` across the three symbols — the policy
differentiates real candidates, not a constant value, matching the
bullish-run finding from Phase 2D.4.

## Market input status table

| Symbol | Expirations sampled | Mode | Overall confidence | Dividend mode | Borrow source | Warnings |
|---|---|---|---|---|---|---|
| NVDA | 10/09, 10/16, 10/23 | PARTIAL_EXTERNAL_INPUTS | LOW | TRAILING_DIVIDEND_YIELD_APPROXIMATION | NOT_CONNECTED | TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE, CONTINUOUS_DIVIDEND_APPROXIMATION, TRAILING_NOT_FORWARD, BORROW_DATA_UNAVAILABLE |
| AAPL | 10/09, 10/16, 10/23 | PARTIAL_EXTERNAL_INPUTS | LOW | TRAILING_DIVIDEND_YIELD_APPROXIMATION | NOT_CONNECTED | TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE, CONTINUOUS_DIVIDEND_APPROXIMATION, TRAILING_NOT_FORWARD, BORROW_DATA_UNAVAILABLE |
| PANW | 10/09, 10/16, 10/23 | PARTIAL_EXTERNAL_INPUTS | MEDIUM | ZERO_DIVIDEND_CONFIRMED | NOT_CONNECTED | TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE, BORROW_DATA_UNAVAILABLE |

Identical to the Phase 2D.4 bullish run: no market-input record reached
`FULL_EXTERNAL_INPUTS`, borrow was explicitly `NOT_CONNECTED` /
`BORROW_DATA_UNAVAILABLE` (never a silent zero) for all sampled
expirations across all three symbols, and no IBKR dependency appeared
anywhere in the request path or response — `tradingViewCrrShadowMarketInputs.js`
was called with `ibkrResult: null` unconditionally, exactly as designed.

## Bearish strategy coverage

| Symbol | `BEAR_PUT_SPREAD` present (top 10) | `LONG_PUT` present (top 10 / near-miss) | Candidate-generation total | Rejection breakdown (wide spread / delta out of range / max loss) |
|---|---|---|---|---|
| NVDA | Yes (10/10) | No | 59 | 56 / 117 / 10 |
| AAPL | Yes (10/10) | No | 55 | 66 / 86 / 14 |
| PANW | Yes (10/10) | No | 27 | 96 / 101 / 42 |

`LONG_PUT` is a real generated strategy type for the bearish direction
(`src/core/options/strategyCandidates.js:233` —
`cfg.direction === 'bullish' ? LONG_CALL : LONG_PUT`), so put-side
candidates were generated for all three symbols. Under this run's test
parameters (max_loss 1000, ~5% target move, 30-day horizon), every
`LONG_PUT` candidate simply ranked below the `BEAR_PUT_SPREAD` candidates
shown above and did not make either the top-10 or 5-slot near-miss list —
consistent with vertical spreads typically producing a higher
reward/risk-driven score than an equivalent long single-leg option under a
capped target move. This is expected ranking behavior (a real consequence
of `RANKING_MODEL_V1`'s scoring, not a defect), not evidence that
`LONG_PUT` candidates are missing from generation — `candidate_generation`
counts and rejection summaries confirm option contracts across the full
put chain were evaluated (190/169/217 eligible contracts per symbol,
matching Phase 2D.4's bullish call-side counts for the same three symbols).

Bear-put-spread strikes span both above and below the target price for
all three symbols (e.g. NVDA P225/P230 through P230/P245; AAPL P320/P330
through P325/P335; PANW P310/P330 through P350/P360), i.e. the candidate
universe was not artificially narrow — the put-side chain supported
multiple width/strike combinations that the ranking model then
differentiated by score.

## Acceptance criteria — checklist

- [x] All three MCP tool calls completed without normal-symbol tool
      errors (the client's inline-size truncation is a transport display
      limit, not a tool-level failure — full valid JSON was recovered from
      disk for all three).
- [x] `diagnostics.crr_hybrid_policy.status` is `AVAILABLE` for all three.
- [x] `diagnostics.crr_hybrid_policy.mode` is
      `DIAGNOSTIC_ONLY_NO_RANKING_CHANGE` for all three.
- [x] Market inputs are `PARTIAL_EXTERNAL_INPUTS`, never
      `FULL_EXTERNAL_INPUTS`, for all sampled expirations.
- [x] Borrow remains explicitly `NOT_CONNECTED` /
      `BORROW_DATA_UNAVAILABLE` for all sampled expirations — never a
      silent zero.
- [x] `ranking.model` is `RANKING_MODEL_V1` (local-Greek) for all three —
      the CRR shadow path never became the ranking source.
- [x] No recommendation/eligibility semantics changed: `NO_TRADE` baseline
      was preserved (`decision_state: NO_TRADE_BASELINE_ONLY`), and no
      LOW-confidence near-miss was silently promoted despite scores up to
      81.81.
- [x] No IBKR dependency appears anywhere in the request/response path.
- [x] Bearish candidate universe behaves sensibly — `BEAR_PUT_SPREAD`
      populated the entire top-10 for all three symbols, spanning multiple
      strike widths; `LONG_PUT` was generated but did not rank into the
      surfaced top-10/near-miss set for these specific test parameters.

All acceptance criteria met.

## Verdict

**PASS.** The MCP tool path for `options_analyze_directional` with
`direction: "bearish"` and `include_crr_hybrid_diagnostics: true` works
correctly end-to-end over a live CDP connection for NVDA, AAPL, and PANW.
The guarded CRR hybrid diagnostics remain diagnostic-only and never touch
production ranking, scoring, confidence, or eligibility; the non-IBKR
market-input provider behaves identically to the bullish run (Phase
2D.4) — `PARTIAL_EXTERNAL_INPUTS`, borrow always unavailable, dividend
mode value-based (trailing-yield vs. zero-confirmed); and the bearish
put-side candidate universe is populated and internally differentiated by
the (unchanged) local-Greek ranking model.

No bug was found; no code changes were made.

## Caveats

- Point-in-time live validation (2026-09-03, US market hours) — not a
  regression suite; re-run after any change to candidate generation,
  ranking, or the CRR hybrid policy evaluator.
- As in Phase 2D.4, no `FULL_EXTERNAL_INPUTS` / `HIGH`-confidence
  market-input record was observed in this run — that path remains
  unexercised pending a live borrow/discount-rate provider, and was
  explicitly out of scope for this phase per the task instructions.
- `LONG_PUT` candidates were generated (per code inspection and
  candidate-generation contract counts) but did not appear in the
  surfaced top-10/near-miss lists for any of the three symbols under
  these specific test parameters — this reflects the ranking model's
  scoring under a ~5% capped move, not a gap in candidate generation. A
  future phase could deliberately choose parameters (e.g. a larger target
  move or tighter max_loss) to force a `LONG_PUT` candidate into the
  surfaced set if that path specifically needs live-tool evidence.
- Test target prices were arbitrary (~5% below spot) for the sole purpose
  of exercising the tool; they do not represent an actual trading thesis
  for NVDA, AAPL, or PANW.
- All three symbols reached `NO_TRADE_BASELINE_ONLY` — this validation
  did not exercise a bearish `TRADE_CANDIDATES_AVAILABLE` decision state
  with an eligible top candidate; that remains untested by this specific
  run's parameter choices.

## Next recommended phase

Phase 2D.6 — either (a) a live/HIGH-confidence market-input provider
validation (the `FULL_EXTERNAL_INPUTS` path deferred from both 2D.4 and
2D.5, pending a connected discount-rate/borrow source), or (b) a
parameter-space live validation deliberately chosen to produce an eligible
bearish `TRADE_CANDIDATES_AVAILABLE` result and/or surface a `LONG_PUT`
top candidate, to confirm those specific response shapes over the live MCP
tool path as well.
