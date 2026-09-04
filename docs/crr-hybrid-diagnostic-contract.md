# CRR Hybrid Diagnostic Contract

**Status:** stable, frozen shape as of Phase 2E.1 (2026-09-04).
**Applies to:** `options_analyze_directional` (`src/tools/optionsAnalysis.js`),
field `diagnostics.crr_hybrid_policy` in its response.

This document is the reference for anyone — human or agent — consuming
`diagnostics.crr_hybrid_policy`. It describes what the field means, what it
guarantees, and what it must never be treated as.

## The one-paragraph version

`diagnostics.crr_hybrid_policy` is an **opt-in, evidence-only** diagnostic.
It never changes what `options_analyze_directional` ranks, scores, or
recommends. It exists to show whether an alternative pricing model (CRR —
Cox-Ross-Rubinstein binomial tree) agrees with the local-Greek
approximation that actually drives ranking, and to flag the specific
candidates where the two disagree enough to warrant human review. It is
not a second opinion to act on; it is a transparency signal.

## How to turn it on

Pass `include_crr_hybrid_diagnostics: true` to `options_analyze_directional`.
Omitting it (the default) always returns `status: "NOT_REQUESTED"`.

## Top-level shape

```json
{
  "status": "NOT_REQUESTED" | "UNAVAILABLE" | "AVAILABLE",
  "mode": "DIAGNOSTIC_ONLY_NO_RANKING_CHANGE"
}
```

`mode` is always `"DIAGNOSTIC_ONLY_NO_RANKING_CHANGE"` in every status —
it is not a status-dependent field. It exists specifically so a consumer
that reads only this one field can tell, without checking `status` first,
that whatever this diagnostic contains will never have altered ranking.

### `status: "NOT_REQUESTED"`

Returned whenever `include_crr_hybrid_diagnostics` is false or omitted
(the default). Fields: `status`, `mode`. Nothing else.

### `status: "UNAVAILABLE"`

Returned when diagnostics were requested but no CRR-shadow market-input
provider is configured. In normal operation this should not happen — a
default non-IBKR provider (`tradingViewCrrShadowMarketInputs.js`) is wired
in and used automatically — but the shape exists as a safety fallback and
is exercised in tests via explicit dependency-injection override. Fields:
`status`, `mode`, `reason` (currently always
`"CRR_SHADOW_MARKET_INPUT_PROVIDER_NOT_CONFIGURED"`).

### `status: "AVAILABLE"`

The normal case when diagnostics are requested. Fields: `status`, `mode`,
`market_inputs` (array), `summary` (object), `candidates` (array).

## `market_inputs[]` — per-expiration pricing input records

One entry per option expiration present in the candidate universe.

| Field | Type | Notes |
|---|---|---|
| `expiration` | string | ISO date, e.g. `"2026-10-16"` |
| `days_to_expiry` | number | |
| `mode` | string | `"PARTIAL_EXTERNAL_INPUTS"` or `"MARKET_INPUT_UNAVAILABLE"` for the shipped non-IBKR provider. **Never `"FULL_EXTERNAL_INPUTS"`** — see "Ceiling on confidence" below. |
| `overall_confidence` | string \| null | `"LOW"`, `"MEDIUM"`, or `"HIGH"` (HIGH is unreachable with the shipped provider — see below) |
| `discount_rate_source` | string \| null | e.g. `"TREASURY_BILL_COUPON_EQUIVALENT_NORMALIZED"` |
| `dividend_mode` | string \| null | e.g. `"TRAILING_DIVIDEND_YIELD_APPROXIMATION"`, `"ZERO_DIVIDEND_CONFIRMED"`, `"DIVIDEND_DATA_UNAVAILABLE"` |
| `borrow_source` | string \| null | Always `"NOT_CONNECTED"` for the shipped provider |
| `warnings` | string[] | e.g. `"TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE"`, `"BORROW_DATA_UNAVAILABLE"` |

## `summary` — aggregate counts

| Field | Type | Notes |
|---|---|---|
| `total_candidates` | number | Total candidates evaluated by the policy (the full candidate universe, not just the scoped `candidates[]` below) |
| `by_action` | object | Map of action name → count; keys are a subset of the five action values below |
| `crr_shadow_available_count` | number | How many candidates had a usable CRR shadow price |
| `local_warning_count` | number | How many candidates carried at least one local-Greek scenario warning |

`Object.values(by_action)` always sums to `total_candidates`.

## `candidates[]` — scoped per-candidate policy actions

**Scoped, not exhaustive.** This array only contains the candidates that
are also in `top_candidates` or `near_miss_candidates` — it deliberately
does not repeat the full candidate universe (that would duplicate data
already reachable via `summary.total_candidates` and inflate payload
size). If a candidate ID isn't in `top_candidates`/`near_miss_candidates`,
it will not appear here even if the policy evaluated it (it's counted in
`summary` regardless).

| Field | Type | Notes |
|---|---|---|
| `candidate_id` | string | Matches a `top_candidates[].candidate_id` or `near_miss_candidates[].candidate_id` |
| `strategy_type` | string | e.g. `"BULL_CALL_SPREAD"`, `"LONG_PUT"`, `"BUY_STOCK"`, `"NO_TRADE"` |
| `action` | string | One of the five action values below |
| `reasons` | string[] | Zero or more reason codes explaining the action |
| `local_warnings` | string[] | Local-Greek scenario warnings observed for this candidate (e.g. `"LARGE_TIME_STEP"`, `"INTRINSIC_FLOOR_APPLIED"`) |
| `max_model_disagreement_level` | string \| null | `"MODEL_DISAGREEMENT_LOW"`, `"MODEL_DISAGREEMENT_MEDIUM"`, `"MODEL_DISAGREEMENT_HIGH"`, or `null` when no disagreement could be computed |
| `crr_shadow_available` | boolean | Whether a CRR shadow price was computable for this candidate |

### Action values

| Action | Meaning |
|---|---|
| `NO_ACTION` | Non-option baseline (`BUY_STOCK`, `NO_TRADE`) — the policy does not evaluate these |
| `LOCAL_ONLY` | Local scenarios are clean (no warnings) and CRR shadow agrees closely (or CRR shadow is unavailable and there are no local warnings) |
| `LOCAL_WITH_WARNING` | Local scenario data — or CRR shadow data — was unavailable; the current local-only behavior is kept, but explicitly flagged as not CRR-validated |
| `CRR_SHADOW_REVIEW` | Warning or disagreement evidence exists, but not strong enough to flag as a hybrid repricing candidate |
| `HYBRID_REPRICE_CANDIDATE` | A major local warning (`LARGE_TIME_STEP` or `NEAR_EXPIRATION`) combines with medium/high CRR-vs-local disagreement |

**`HYBRID_REPRICE_CANDIDATE` is not a trade recommendation.** It means
"the local-Greek approximation and CRR disagree enough here that a human
reviewing this candidate should know the local price may be less
reliable in this specific warning region." It says nothing about whether
the underlying trade is good, bad, attractive, or eligible — those
judgments come entirely from `top_candidates[].score`,
`.confidence`, and `.consideration_eligible`, none of which this
diagnostic can influence.

## What this diagnostic guarantees

1. **Opt-in only.** Diagnostics are never computed unless
   `include_crr_hybrid_diagnostics: true` is passed.
2. **Evidence only, never a recommendation.** Nothing in
   `diagnostics.crr_hybrid_policy` is a buy/sell signal, a probability, or
   an endorsement of any candidate.
3. **Zero effect on ranking, score, confidence, eligibility, or
   recommendations.** `top_candidates`, `ranking.decision_state`,
   `ranking.top_trade_candidate_id`, `scenario_quality_summary`,
   `consideration_eligible`, and `ai_contract.allowed_candidate_ids` are
   computed identically whether or not diagnostics are requested — this is
   enforced by tests (`tests/directional_analysis.test.js`,
   "Phase 2E.1 — CRR hybrid diagnostic contract stabilization" and
   "Phase 2D.3" sections) and verified live in Phase 2D.4–2D.6.
4. **Ceiling on confidence: `PARTIAL_EXTERNAL_INPUTS`, never
   `FULL_EXTERNAL_INPUTS`.** The shipped default provider
   (`tradingViewCrrShadowMarketInputs.js`) has no connection to a live
   borrow source (no IBKR, no funded account) — `borrow_source` is always
   `"NOT_CONNECTED"`. Because the market-input mode calculation requires a
   present borrow rate to reach `FULL_EXTERNAL_INPUTS`, this provider
   cannot produce that mode by construction, and `overall_confidence` can
   reach at most `"MEDIUM"` (never `"HIGH"`).

## What this diagnostic does not guarantee

- It does not claim CRR is more accurate than local-Greek pricing.
- It does not model early exercise, dividends beyond a trailing-yield
  approximation, or a live discount curve (the Treasury rate is a frozen,
  periodically-refreshed fallback table, tagged
  `TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE` in every record).
- It is not a substitute for `top_candidates[].confidence` — a candidate
  can be `HYBRID_REPRICE_CANDIDATE` in the diagnostic and still be
  `consideration_eligible: true` in the actual ranking, or vice versa;
  the two systems are intentionally independent.
- `FULL_EXTERNAL_INPUTS` / `HIGH`-confidence market inputs remain a future
  capability, contingent on a live borrow/discount-rate provider (e.g. a
  funded IBKR connection) that does not currently exist in this codebase.

## For downstream consumers (including AI agents)

If you are an agent or application consuming this field:

- Never state or imply that `HYBRID_REPRICE_CANDIDATE` means "buy" or
  "avoid" — it is a data-quality flag, not a trading signal.
- Never treat a market-input record's `overall_confidence` as a
  probability of a trade's success — it describes confidence in the
  *pricing inputs*, unrelated to `top_candidates[].confidence`, which
  describes confidence in the *scenario model*.
- Mention diagnostics only when the user has asked about pricing-model
  agreement, data quality, or CRR specifically — do not surface them
  unprompted as part of a normal trade discussion, since they add noise
  without changing any actionable number.
- If asked "is this candidate good," answer from `score`, `confidence`,
  and `consideration_eligible` — never from `crr_hybrid_policy`.

## Related documents

- `docs/phase-2d-hybrid-crr-policy.md` — original policy design
- `docs/phase-2d2-guarded-integration-design.md` — integration guardrails
- `docs/phase-2d3-diagnostic-market-input-provider.md` — the shipped
  non-IBKR provider
- `docs/phase-2e0-phase-2d-rollup-migration-decision.md` — the migration
  decision this contract implements
- `docs/phase-2e1-crr-diagnostic-contract-stabilization.md` — this
  contract's stabilization phase
