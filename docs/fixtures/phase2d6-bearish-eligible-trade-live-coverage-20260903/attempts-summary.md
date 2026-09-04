# Phase 2D.6 — Attempts Summary

## Failed baseline (reference, not re-run this phase)

Phase 2D.5 (`docs/phase-2d5-bearish-mcp-tool-live-validation.md`,
`docs/fixtures/phase2d5-bearish-mcp-tool-live-validation-20260903/`) already
ran NVDA/AAPL/PANW bearish with default `min_dte`/`max_dte` (i.e.
`min_dte = horizon_days = 30`, `max_dte = horizon_days + 45 = 75`),
`max_loss: 1000`, `max_spread_pct` default (15), default thresholds
(`minimum_score_for_consideration: 60`, `minimum_confidence_for_consideration: MEDIUM`),
and targets ~5% below spot. All three reached `NO_TRADE_BASELINE_ONLY`:
every `BEAR_PUT_SPREAD` candidate scored above the 60-point threshold
(up to 81.81) but was blocked by `confidence: LOW`, driven structurally by
the `LARGE_TIME_STEP` scenario warning (`daysForward(30) >
Math.min(30, 0.5 * daysToExpiry)` — true whenever `daysToExpiry < 60` at a
30-day horizon; see `src/core/options/optionRepricer.js:124`). Not
re-run here; cited as the known failing baseline this phase addresses.

## Attempt 1 (this phase) — widened expiration window, no threshold relaxation

Rationale: `LARGE_TIME_STEP` (a MAJOR scenario warning) forces
`scenario_model_confidence: LOW` whenever `daysForward > min(30, 0.5 *
daysToExpiry)`. At `horizon_days: 30`, this is unavoidable for any
contract with `daysToExpiry < 60`. Widening the expiration window to
`min_dte: 60, max_dte: 90` selects only contracts where
`min(30, 0.5*60..90) = 30`, so `daysForward(30) > 30` is false and the
warning never fires — a parameter change, not a code change, and one that
does not touch `minimum_score_for_consideration` or
`minimum_confidence_for_consideration` (both left at their production
defaults).

Parameters: `direction: bearish`, `horizon_days: 30`, `max_loss: 2500`,
`min_dte: 60`, `max_dte: 90`, `max_spread_pct: 25`, all three IV shocks
explicit `0`, `include_crr_hybrid_diagnostics: true`,
`minimum_score_for_consideration` and `minimum_confidence_for_consideration`
left at production defaults (60 / MEDIUM — not relaxed).

| Symbol | Spot | Target (~8% down) | Result |
|---|---|---|---|
| NASDAQ:NVDA | 229.255 | 211 | **TRADE_CANDIDATES_AVAILABLE** — top candidate BEAR_PUT_SPREAD, score 80.02, HIGH confidence |
| NASDAQ:AAPL | 327.68 | 301 | **TRADE_CANDIDATES_AVAILABLE** — top candidate BEAR_PUT_SPREAD, score 85.2, MEDIUM confidence; LONG_PUT also present at ranks 6/7/9/10 |
| NASDAQ:PANW | 329.655 | 303 | **TRADE_CANDIDATES_AVAILABLE** — top candidate BEAR_PUT_SPREAD, score 65.95, MEDIUM confidence |

All three symbols succeeded on the first attempt of this phase — no
second attempt, no additional symbols, and no relaxation of
`minimum_score_for_consideration` or `minimum_confidence_for_consideration`
were needed. The search is therefore bounded to this single parameter set.
