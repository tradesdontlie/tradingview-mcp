# Phase 2D.3 — Production Market-Input Provider Wiring for Diagnostics

Date: 2026-09-03
Branch: `phase-2d-hybrid-policy`
Status: `DIAGNOSTIC_ONLY_NO_PRODUCTION_SWITCH`

## Verdict

**The guarded diagnostic path now has a real default provider.**

`include_crr_hybrid_diagnostics: true` no longer requires the caller to
inject a market-input builder — it now works out of the box using
TradingView key-stats and a frozen Treasury bill-rate table, with no IBKR
dependency at all.

## What Was Wired

New module: `src/core/options/marketInputs/tradingViewCrrShadowMarketInputs.js`,
exporting `buildTradingViewCrrShadowMarketInputs({ symbol, root, spot,
keyStats, chainResp, expirations })` — the exact shape
`directionalAnalysis.js`'s `deps.buildCrrShadowMarketInputs` hook expects.

It composes, per expiration:

- **Discount**: `resolveDiscountRate()` (Phase 2B/2C, unchanged) against a
  frozen fallback Treasury bill-rate table
  (`FALLBACK_TREASURY_BILL_RATES`, dated `FALLBACK_TREASURY_AS_OF_DATE =
  2026-09-01`, taken from the Phase 2C.2 live acceptance run). Every
  resulting record is tagged with `TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE`
  so it's never confused with a live quote.
- **Dividend**: `resolveDividendWithPrecedence()` (Phase 2C.1) fed
  `keyStats.dividend_yield_pct` as `tvTrailingYieldPct`
  (`TRAILING_DIVIDEND_YIELD_APPROXIMATION`) — except when TradingView
  reports an exact `0%`, which is treated as the documented zero-dividend
  source (`ZERO_DIVIDEND_CONFIRMED`), the same value-based pattern the
  Phase 2C/2C.1 live scripts already used for PANW. This is generic (any
  symbol reporting exactly 0%), not a hardcoded PANW allowlist.
- **Borrow**: `resolveBorrowWithPrecedence({ ibkrResult: null })` — always
  `BORROW_DATA_UNAVAILABLE`, never a silent zero.

`buildMarketInputRecord()` (unchanged) then determines the mode: since
borrow is always absent here, every record is `PARTIAL_EXTERNAL_INPUTS`
(never `FULL_EXTERNAL_INPUTS` — this module cannot produce that mode by
construction, since it has no path to a present borrow fee).

`directionalAnalysis.js` was changed by exactly one line's worth of logic:

```js
const buildCrrShadowMarketInputs = deps.buildCrrShadowMarketInputs ?? _buildCrrShadowMarketInputs;
```

— following the same `deps.x ?? _x` pattern already used for
`getOptionChain`, `getKeyStats`, etc. in the same file. Tests can still
force the "no provider" path by passing a non-function, non-nullish
override (`buildCrrShadowMarketInputs: false`), since `??` only
substitutes on `null`/`undefined`.

## Why IBKR Is Not Required

The account is not funded/active, so no authenticated IBKR session exists
to test against (consistent with Phase 2C.1/2C.2/2C.4's findings). Nothing
in this wiring step depends on IBKR: `resolveBorrowWithPrecedence` is
called with `ibkrResult: null` unconditionally, which is exactly its
documented "no live borrow source" path (Phase 2C.1). If an IBKR adapter
is connected in a future phase, swapping in a real `ibkrResult` there
would upgrade individual records toward `FULL_EXTERNAL_INPUTS` without
any change to this module's calling contract.

## What Remains Diagnostic-Only

Unchanged from Phase 2D.2's guardrails — this step adds a data source,
not a new integration point:

- `diagnostics.crr_hybrid_policy` is the only place this output appears.
- Local-Greek `top_candidates`, `ranking`, `score`, `confidence`,
  `consideration_eligible`, and `ai_contract.allowed_candidate_ids` are
  untouched — verified by tests (see below).
- No order/account functionality; no live network I/O added (the builder
  only transforms `keyStats`/`expirations` the orchestrator already
  fetched for the main analysis — it makes no calls of its own).
- No production ranking weights or confidence thresholds changed.

## Validation

```
node --test tests/directional_analysis.test.js tests/hybrid_crr_policy.test.js tests/market_conventions_and_shadow.test.js
node --test tests/hybrid_crr_policy.test.js tests/pricing_crr_american.test.js tests/market_conventions_and_shadow.test.js tests/ibkr_market_inputs.test.js tests/strategy_ranking.test.js tests/strategy_scenarios.test.js tests/directional_analysis.test.js
npm run lint
```

Results:

- `directional_analysis.test.js`: 27/27 pass (5 new Phase 2D.3 cases, 1
  updated to force the disabled-provider path explicitly).
- Broader suite (7 files): 142/142 pass.
- Lint: 0 errors, 9 pre-existing warnings in unrelated files (unchanged).

New test coverage confirms:

- default request (no flag) stays `NOT_REQUESTED`.
- `include_crr_hybrid_diagnostics: true` with **no deps override** now
  returns `AVAILABLE` (previously always `UNAVAILABLE`).
- every returned market-input record is `PARTIAL_EXTERNAL_INPUTS` with
  `borrow_source: 'NOT_CONNECTED'` and `BORROW_DATA_UNAVAILABLE` in
  warnings — never `FULL_EXTERNAL_INPUTS`.
- an exact `0%` TradingView yield resolves to `ZERO_DIVIDEND_CONFIRMED`;
  a positive yield resolves to `TRAILING_DIVIDEND_YIELD_APPROXIMATION`.
- missing dividend data resolves to `DIVIDEND_DATA_UNAVAILABLE` /
  `MARKET_INPUT_UNAVAILABLE` per-expiration — the provider still runs and
  returns structured, honest "unavailable" records rather than crashing
  or fabricating a rate.
- ranking order, top candidate id, decision state, score, confidence, and
  eligibility are byte-identical with diagnostics on vs off.

## Migration Verdict

Unchanged from Phase 2D/2D.1: **not ready for production CRR migration.**
This phase only makes the diagnostic path usable without manual wiring —
it does not add new evidence about CRR-vs-local agreement or ranking
stability (that remains Phase 2C.2/2C.3/2C.4's job). Market-input
confidence achievable through this provider is capped at whatever
`buildMarketInputRecord` assigns for `PARTIAL_EXTERNAL_INPUTS` — never
`HIGH`/`FULL`, since borrow is structurally absent here by design.

## Recommended Next Step

Run the Phase 2D hybrid policy end-to-end through the MCP tool itself
(`options_analyze_directional` with `include_crr_hybrid_diagnostics:
true`) against a live active-market TradingView session for NVDA/AAPL/
PANW, now that no manual dependency injection is required — confirming
the wiring behaves identically to the injected-provider path already
validated in Phase 2D.1's live acceptance run. If a funded IBKR account
becomes available later, extend `buildTradingViewCrrShadowMarketInputs`
(or add a sibling provider) to pass a real `ibkrResult` into
`resolveBorrowWithPrecedence`/`resolveDividendWithPrecedence`, which
would let some records reach `FULL_EXTERNAL_INPUTS` without changing any
caller.
