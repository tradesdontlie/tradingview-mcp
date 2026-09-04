# Phase 2D.2 — Guarded Hybrid CRR Integration Design

Date: 2026-09-02
Branch: `phase-2d-hybrid-policy`

## Verdict

**Guarded integration is implemented.**

The directional analysis contract can now expose Phase 2D hybrid CRR policy
evidence without changing production pricing, ranking, confidence, eligibility,
or recommendation semantics.

## What Changed

Added an optional request flag:

`include_crr_hybrid_diagnostics`

When false or omitted, the analysis output reports:

```json
{
  "diagnostics": {
    "crr_hybrid_policy": {
      "status": "NOT_REQUESTED",
      "mode": "DIAGNOSTIC_ONLY_NO_RANKING_CHANGE"
    }
  }
}
```

When true, the orchestrator only computes CRR hybrid diagnostics if a
CRR-shadow market-input builder is provided by the caller/dependency layer.
If no provider is configured, it returns:

```json
{
  "status": "UNAVAILABLE",
  "mode": "DIAGNOSTIC_ONLY_NO_RANKING_CHANGE",
  "reason": "CRR_SHADOW_MARKET_INPUT_PROVIDER_NOT_CONFIGURED"
}
```

This keeps IBKR, Treasury, borrow, and dividend source decisions outside the
main ranking path.

## Output Location

The diagnostic result is attached at:

`diagnostics.crr_hybrid_policy`

This is deliberately separate from:

- `ranking`
- `top_candidates`
- `scenario_quality_summary`
- `consideration_eligible`
- `ai_contract.allowed_candidate_ids`

## Safety Rules

The AI contract now explicitly states:

`Do not treat crr_hybrid_policy diagnostics as a recommendation, score override, or production pricing switch.`

`diagnostics.crr_hybrid_policy` is also listed under `field_provenance` as an
engine-calculated field.

## Guardrails

The integration is guarded in four ways:

1. **Opt-in only**: diagnostics are not computed unless requested.
2. **Provider-gated**: CRR shadow diagnostics require an injected market-input
   provider.
3. **Ranking-isolated**: local-Greek ranking remains the source of
   `top_candidates`, score, confidence, and eligibility.
4. **Scoped output**: only top/near-miss candidate policy actions are surfaced,
   while aggregate counts still cover the full generated candidate universe.

## Not Changed

This phase does not:

- migrate production pricing to CRR
- alter local-Greek scenario P&L
- alter ranking scores
- alter candidate confidence
- alter eligibility decisions
- promote IBKR to required infrastructure
- claim `FULL_EXTERNAL_INPUTS`

## Tests

Added coverage in:

`tests/directional_analysis.test.js`

Covered cases:

- default output keeps CRR hybrid diagnostics as `NOT_REQUESTED`
- explicit request without provider returns `UNAVAILABLE`
- injected provider returns `AVAILABLE`
- ranking order, top candidate, and decision state remain unchanged when
  diagnostics are enabled

## Recommended Next Step

Proceed to **Phase 2D.3 — production market-input provider wiring for
diagnostics**.

That step should wire a non-IBKR-dependent provider for the diagnostic path:

- Treasury discount input
- TradingView trailing dividend yield or documented zero-dividend source
- borrow unavailable as explicit `PARTIAL_EXTERNAL_INPUTS`

The provider should be used only for `include_crr_hybrid_diagnostics`, not for
production ranking.
