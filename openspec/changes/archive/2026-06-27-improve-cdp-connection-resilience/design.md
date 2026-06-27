## Context
`connection.js` is the single most reliability-critical module and has zero unit coverage. The failure
modes are all "hangs or raw errors under transient CDP instability." `stream.js` shares the connection
but also owns its own output channel, which collides with the MCP stdio transport.

## Goals / Non-Goals
- Goals: no unbounded hangs; transient socket drops self-heal once; output never corrupts MCP stdio;
  streams escalate instead of silently looping.
- Non-Goals: a full reconnection state machine or pooling; changing the happy-path API.

## Decisions
- **Decision:** `fetchWithTimeout(url, ms)` using `AbortController`, shared with `tab.js`
  (see `fix-tab-switch-cdp-reconnect`). Discovery deadline ~5s, separate from the retry backoff.
- **Decision:** Single retry in `evaluate()` gated on a connection-reset regex; reconnect via the same
  path `getClient()` uses. One retry only — avoid masking real page errors.
- **Decision:** Liveness probe throttled by a `lastProbeAt` timestamp (skip within ~1s) to cut the
  per-call round-trip while still catching stale singletons.
- **Decision:** Stream output goes through an injectable sink (default: CLI stdout writer). On the MCP
  path the sink is absent/guarded so nothing writes to the protocol stream. Backoff doubles to a 30s cap;
  after N consecutive failures emit one error event/line and optionally exit non-zero (CLI only).

## Risks / Trade-offs
- A retry could hide a genuine one-off page error → mitigated by the narrow connection-reset gate and
  single attempt.
- Bounding total wait could fail a slow cold start → choose a bound (~10s) above observed cold-start.

## Migration Plan
- Land `fetchWithTimeout` + `evaluate` retry + probe throttle first (pure resilience, low risk), then the
  stream sink/backoff change (behavioral, tested via the CLI stream commands).

## Open Questions
- Exact N for stream-failure escalation (proposed 10 consecutive) and whether CLI should exit 2 after it.
