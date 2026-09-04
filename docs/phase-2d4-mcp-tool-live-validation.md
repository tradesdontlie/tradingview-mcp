# Phase 2D.4 — MCP Tool Live Validation

**Date:** 2026-09-03
**Branch:** `phase-2d-hybrid-policy`
**Base commit:** `dac7b506dbf5b5149983a883867868c2b42ae6cd`

## Purpose

Prior phases (2D.1–2D.3) exercised the guarded hybrid CRR policy evaluator
through direct engine/service calls. Phase 2D.4 validates the same
`include_crr_hybrid_diagnostics` path end-to-end through the **actual MCP
tool boundary** — i.e. `options_analyze_directional` invoked as an MCP tool
call over a live CDP connection to TradingView Desktop, not a unit test or
in-process call.

## Environment recovery

The previous session's TradingView Desktop process had exited and CDP
(port 9222) was refusing connections (`fetch failed` / connection refused).

1. `tv_launch` (default `kill_existing: true`) — first attempt returned
   `cdp_ready: false` (still loading); the launched process (PID 90309) had
   exited by the time of the retry.
2. `tv_launch` (second attempt, explicit `kill_existing: true`) — succeeded,
   PID 90731, CDP ready immediately (Chrome/146.0.7680.216 under
   Electron/41.7.1, TVDesktop/3.4.0).
3. `tv_health_check` — passed:
   - `cdp_connected: true`
   - `chart_symbol: "BISTMIXED:SASA"`, `chart_resolution: "1D"`
   - `api_available: true`
   - Noted (not acted on): an MCP server update is available
     (`local_commit: dac7b506`, `latest_commit: c05b8f57`). Per instructions,
     no code/update changes were made during this validation.

No repo files were touched during environment recovery.

## Method

Three live `options_analyze_directional` MCP tool calls, one per symbol,
all bullish, 30-day horizon, `max_loss: 1000`, all three IV shocks
explicitly set to `0`, `include_crr_hybrid_diagnostics: true`. Spot prices
were read live via `quote_get` immediately before each call; base target
prices were set ~5-6% above spot purely to exercise the tool path (test
inputs, not a trading thesis).

| Symbol | Spot (quote_get) | base_target_price | horizon_days | max_loss | IV shocks (down/base/up) |
|---|---|---|---|---|---|
| NASDAQ:NVDA | 230.20 | 245 | 30 | 1000 | 0 / 0 / 0 |
| NASDAQ:AAPL | 327.11 | 345 | 30 | 1000 | 0 / 0 / 0 |
| NASDAQ:PANW | 329.00 | 348 | 30 | 1000 | 0 / 0 / 0 |

Raw responses saved to `docs/fixtures/phase2d4-mcp-tool-live-validation-20260903/{nvda,aapl,panw}.json`.

## Results

### Call success

All three calls returned `analysis_type: "DIRECTIONAL_OPTIONS"` with a
complete packet (`data_source.chain_completeness: "COMPLETE"` for all
three) — no tool errors, no partial/timeout responses.

### CRR hybrid diagnostics (`diagnostics.crr_hybrid_policy`)

| Symbol | status | mode | total candidates | CRR_SHADOW_REVIEW | HYBRID_REPRICE_CANDIDATE | NO_ACTION |
|---|---|---|---|---|---|---|
| NVDA | AVAILABLE | DIAGNOSTIC_ONLY_NO_RANKING_CHANGE | 62 | 8 | 52 | 2 |
| AAPL | AVAILABLE | DIAGNOSTIC_ONLY_NO_RANKING_CHANGE | 63 | 9 | 52 | 2 |
| PANW | AVAILABLE | DIAGNOSTIC_ONLY_NO_RANKING_CHANGE | 23 | 2 | 19 | 2 |

Diagnostic mode was confirmed `DIAGNOSTIC_ONLY_NO_RANKING_CHANGE` in all
three responses — consistent with the Phase 2D contract that this flag
never affects ranking, eligibility, or scoring.

### Market input modes (per expiration)

- **NVDA / AAPL** — all sampled expirations (`2026-10-09`, `2026-10-16`,
  `2026-10-23`) reported `mode: PARTIAL_EXTERNAL_INPUTS`,
  `overall_confidence: LOW`, `dividend_mode:
  TRAILING_DIVIDEND_YIELD_APPROXIMATION`, `borrow_source: NOT_CONNECTED`,
  with warnings `TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE`,
  `CONTINUOUS_DIVIDEND_APPROXIMATION`, `TRAILING_NOT_FORWARD`,
  `BORROW_DATA_UNAVAILABLE`.
- **PANW** — sampled expirations (`2026-10-09`, `2026-10-16`) reported
  `mode: PARTIAL_EXTERNAL_INPUTS`, `overall_confidence: MEDIUM` (higher
  than NVDA/AAPL because `dividend_mode: ZERO_DIVIDEND_CONFIRMED` removes
  the two dividend-approximation warnings), with warnings
  `TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE`, `BORROW_DATA_UNAVAILABLE`.

This matches the previously-documented guarded-policy behavior: discount
rate is a frozen non-live fallback, borrow is not connected, and dividend
handling is either a trailing-yield approximation or a confirmed-zero case
— never a live forward curve.

### Policy summary / model disagreement (spot check)

Sampled `crr_hybrid_policy.candidates` entries across all three symbols
showed `local_warnings` of `LARGE_TIME_STEP` and/or
`INTRINSIC_FLOOR_APPLIED`, and `max_model_disagreement_level` values
spanning `MODEL_DISAGREEMENT_LOW` → `MODEL_DISAGREEMENT_HIGH`, i.e. the
policy is actually differentiating between candidates rather than emitting
a constant value.

### Top candidates and baselines

`ranking.decision_state` was `TRADE_CANDIDATES_AVAILABLE` for all three
symbols (i.e. not the `NO_TRADE_BASELINE_ONLY` state). Each packet
returned 10 `top_candidates`, with `BUY_STOCK` ranked highest in all three
cases:

| Symbol | Top candidate | Score | Confidence | Eligible | 2nd (options) | Score | Confidence | Eligible |
|---|---|---|---|---|---|---|---|---|
| NVDA | BUY_STOCK | 61.09 | HIGH | true | BULL_CALL_SPREAD (10/09, 220/230) | 71.88 | LOW | false |
| AAPL | BUY_STOCK | 60.19 | HIGH | true | BULL_CALL_SPREAD (10/16, 315/325) | 67.80 | LOW | false |
| PANW | BUY_STOCK | 60.48 | HIGH | true | BULL_CALL_SPREAD (10/16, 310/320) | 58.49 | LOW | false |

Notable: for all three symbols the highest-*scoring* candidate overall was
a `BULL_CALL_SPREAD`, but every spread candidate carried `confidence: LOW`
and `consideration_eligible: false` — `BUY_STOCK` was the only
options-adjacent (baseline) eligible top candidate. This is a real
consequence of `LOW`-confidence spreads never being silently upgraded to
eligible (per the Options Copilot standard), and was surfaced correctly by
the live tool, not by any local post-processing.

`baselines` returned exactly one entry per symbol —
`NO_TRADE::NASDAQ:<SYM>`, `confidence: HIGH`, `consideration_eligible:
true` — present alongside `TRADE_CANDIDATES_AVAILABLE`, not overwritten by it.

### Candidate generation funnel (sanity check)

| Symbol | input contracts | eligible contracts | candidates | rejected (wide spread / delta out of range / max loss exceeded) |
|---|---|---|---|---|
| NVDA | 380 | 190 | 62 | 49 / 124 / 8 |
| AAPL | 338 | 169 | 63 | 39 / 112 / 11 |
| PANW | 434 | 217 | 23 | 111 / 93 / 22 |

`scenario_quality_summary` showed exactly 1 `HIGH_CONFIDENCE_CANDIDATES`
(the `BUY_STOCK` baseline) and the remainder `LOW_CONFIDENCE_CANDIDATES`
for all three symbols, with 0 `MEDIUM_CONFIDENCE_CANDIDATES` — consistent
with the `PARTIAL_EXTERNAL_INPUTS` / LOW-MEDIUM market-input confidence
seen above propagating into candidate confidence.

### Caveats / limitations returned by the tool

Identical `limitations` array across all three symbols, including (among
others):
- Score is a heuristic comparative metric (`RANKING_MODEL_V1`), not a
  probability or expected return.
- Scenario repricing is `LOCAL_GREEK_APPROXIMATION`, not a full pricing
  model.
- IV shocks default to 0 unless explicitly supplied (not applicable here —
  all three shocks were explicit).
- Open interest unavailable; volume not used in filtering/scoring/ranking.
- No portfolio-level risk, no early-exercise/dividend modeling, no
  historical calibration of scoring weights.

No `IV_SCENARIO_NOT_SPECIFIED` warning was present in any response, as
expected — this run explicitly supplied all three IV shock values.

## Verdict

**PASS.** The MCP tool path for `options_analyze_directional` with
`include_crr_hybrid_diagnostics: true` works correctly end-to-end over a
live CDP connection for all three test symbols:

- Diagnostics are `AVAILABLE` and `DIAGNOSTIC_ONLY_NO_RANKING_CHANGE` in
  every response — confirming the guarded policy never touches ranking.
- Market input modes and per-expiration confidence are populated and vary
  sensibly with dividend data (`ZERO_DIVIDEND_CONFIRMED` for PANW raising
  confidence to MEDIUM vs. `TRAILING_DIVIDEND_YIELD_APPROXIMATION` for
  NVDA/AAPL staying at LOW).
- Policy candidate actions differentiate real candidates by model
  disagreement and local warnings rather than returning a constant.
- Baselines (`NO_TRADE`) and eligibility gating (LOW-confidence spreads not
  silently promoted) behave per the Options Copilot standard.
- No tool errors, malformed payloads, or contract mismatches were observed.

No bug was found; no code changes were made.

## Caveats

- This was a point-in-time live validation (2026-09-03, US market hours);
  it does not constitute a regression suite and should be re-run after any
  change to candidate generation, ranking, or the CRR hybrid policy
  evaluator.
- Market input confidence was LOW/MEDIUM for all sampled expirations
  across all three symbols — this run did not encounter a `HIGH`-confidence
  or `FULL_EXTERNAL_INPUTS` market-input mode, so that code path remains
  unexercised by this validation.
- Only 2-3 expirations per symbol were present in the diagnostic
  `market_inputs` sample (the tool's own dedup/window, not a limitation
  introduced by this validation).
- Test target prices were arbitrary (~5-6% above spot) for the sole
  purpose of exercising the tool; they do not represent an actual trading
  thesis for NVDA, AAPL, or PANW.

## Next recommended phase

Phase 2D.5 — extend live validation to bearish direction and a symbol with
a live/HIGH-confidence borrow or discount-rate input (if/when a market-data
provider for CRR shadow inputs is connected), to exercise the
`overall_confidence: HIGH` / `FULL_EXTERNAL_INPUTS` branch not observed in
this run.
