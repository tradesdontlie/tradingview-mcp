# Options Copilot — Behavioral Fixtures

Documentation fixtures for the expected downstream-explainer behavior when using
`options_analyze_directional`. See `OPTIONS COPILOT OPERATING STANDARD` in `CLAUDE.md`
for the rules these fixtures illustrate. These are documentation fixtures, not LLM
unit tests — no LLM SDK is present in this project.

## A) Eligible BUY_STOCK + higher-score LOW-confidence option

**Packet shape:** `BUY_STOCK` is `consideration_eligible: true` with a modest score.
One or more option candidates (e.g. a `BULL_CALL_SPREAD`) have a *higher* score but
`confidence: LOW` and `consideration_eligible: false` (`CONFIDENCE_BELOW_THRESHOLD`).

**Expected explanation behavior:**
- Present `BUY_STOCK` as the consideration-eligible candidate.
- Explain the higher-scoring option candidate separately, explicitly stating it is
  economically attractive under the assumed scenarios but not consideration-eligible
  because model confidence is insufficient (name the actual `confidence_reasons`,
  e.g. `LARGE_TIME_STEP`, `LARGE_SPOT_MOVE`).
- Never blend the two into a single "best pick."

## B) `decision_state: NO_TRADE_BASELINE_ONLY`

**Packet shape:** No candidate reaches consideration eligibility; `near_miss_candidates`
lists why each ineligible candidate failed.

**Expected explanation behavior:**
- State plainly that no trade candidate is consideration-eligible under the supplied
  thesis/constraints.
- Describe near-miss candidates only as explanations of *why they failed* — never
  promote one into a recommendation.
- Preserve `NO_TRADE` as the result; do not override it with an opinion.

## C) HIGH-confidence eligible option

**Packet shape:** An option candidate with `confidence: HIGH` and
`consideration_eligible: true`.

**Expected explanation behavior:**
- May describe it as "the engine's deterministic consideration-eligible candidate."
- Must not use recommendation language ("you should buy this", "best trade").
- Still show its actual packet values (max loss, max profit, breakeven, scenario P&L).

## D) IV scenario unspecified

**Packet shape:** `data_source.warnings` contains `IV_SCENARIO_NOT_SPECIFIED`.

**Expected explanation behavior:**
- State that the user supplied no IV view, so the engine held IV unchanged
  (`iv_change_points = 0`) as an analysis assumption for all three scenarios.
- Do not imply this is a forecast that IV will actually stay flat.

## E) User target mismatch

**Packet shape:** e.g. a bullish thesis with `base_target_price` below current spot
(or a bearish thesis with a target above spot) — `validateThesisDirection` rejects
this at the tool level with a validation error.

**Expected explanation behavior:**
- Report the tool's validation error as-is.
- Do not fabricate a "corrected" target price or silently reinterpret the thesis.
- Ask the user to resupply a target consistent with their stated direction.
