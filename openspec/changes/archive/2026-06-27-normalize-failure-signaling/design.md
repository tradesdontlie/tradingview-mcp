## Context
The repo has an implicit "core throws / tools wrap" contract, but ~7 sites violate it by returning
errors in-band or by not throwing. Because the MCP transport and the CLI both branch on the outer
`success` flag, in-band errors are invisible to automation and to the report pipeline. This change makes
the contract explicit and enforces it at the two boundaries (tools wrapper, CLI exit code).

## Goals / Non-Goals
- Goals: one failure channel (throw → `{success:false}`); preserve original error detail; surface
  partial-parse warnings without failing the whole read.
- Non-Goals: changing tool *names* or adding retry logic (resilience is handled in
  `improve-cdp-connection-resilience`).

## Decisions
- **Decision:** Distinguish *failure* from *informational notes*. Logical failures throw. Non-failure
  context (e.g. "DOM panel not open", "no strategy on chart") uses a clearly-named field such as `_note`
  / `_warnings`, never a bare `error` on a `success:true` payload.
  - Alternatives considered: keep in-band `error` but document it — rejected; it has already caused
    silent empty report sections.
- **Decision:** `_warnings` is an array of `{study, reason}` on pine-graphics results so a broken
  TradingView internal shape is observable while still returning whatever parsed.
- **Decision:** CLI maps `result.success === false` to a non-zero exit code in `router.js`, keeping the
  existing connection-error exit-code-2 classification for thrown CDP errors.

## Risks / Trade-offs
- Callers that currently ignore failures and proceed will now see thrown errors / non-zero exits →
  intended, but **BREAKING**; called out in the proposal and covered by tests.
- Over-throwing on benign "nothing found" states would be noisy → mitigated by the `_note` convention
  for non-failures.

## Migration Plan
- Update the report-pipeline prompts only if they relied on `success:true`-with-error; none currently do.
- No data migration. Roll out per-module; tools-layer wrappers already catch throws.

## Open Questions
- Should `_warnings` also be echoed to stderr at the tools layer? Proposed: yes, one line when a
  non-empty `study_filter` matched zero studies but warnings exist.
