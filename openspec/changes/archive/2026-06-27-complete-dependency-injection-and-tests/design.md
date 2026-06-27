## Context
DI adoption is uneven (3 of 16 modules). The pattern is mechanical and already proven in `drawing.js`,
so the work is plumbing, not design. The bigger risk is the orphaned test suites: they pass when run
manually but never run in the default workflow, so a regression in sanitization or replay-delay
validation ships undetected.

## Goals / Non-Goals
- Goals: a uniform `_deps` seam across CDP-touching core modules; the existing unit suites actually run;
  new failure-path coverage for behavior tightened by sibling proposals.
- Non-Goals: rewriting tools/CLI layers; introducing a mocking framework (Node's built-in test runner +
  injected `_deps` is sufficient).

## Decisions
- **Decision:** Copy `drawing.js`'s `_resolve(deps)` verbatim; each function takes an optional `{_deps}`
  and resolves `evaluate`/`evaluateAsync`/`getClient`/`getChartApi`/`waitForChartReady` as needed.
  - Alternatives considered: a single shared deps module imported everywhere — rejected as a larger
    refactor than the established per-module pattern.
- **Decision:** Sequence the rollout by call frequency / report-pipeline reliance: `data.js` first, then
  `pine.js`, `indicators.js`, `ui.js`, then the rest.
- **Decision:** Test scripts become the source of truth that a suite "counts"; CI runs `test:all`.

## Risks / Trade-offs
- Touching 13 modules risks churn → mitigated by the mechanical, additive (optional-parameter) nature;
  no call sites change.
- Wiring in the orphaned suites may surface latent failures → that is the point; fix or quarantine with
  a tracked note.

## Migration Plan
- Land DI per module with its unit suite. Add the two orphaned suites to scripts in the same change.

## Open Questions
- Should `connection.js` itself gain a test seam for its retry/backoff? Deferred to
  `improve-cdp-connection-resilience`.
