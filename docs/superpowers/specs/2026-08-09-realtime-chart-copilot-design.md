# Realtime Chart Copilot — Design Specification

## 1. Goal

Build a read-only chart copilot for Vietnamese stocks and XAUUSD that combines an always-on, low-cost monitor with on-demand analysis. The monitor detects deterministic chart events; the LLM explains only validated evidence and produces base/bull/bear scenarios.

The first release must preserve the existing TradingView MCP contracts and must not place orders or write `journal.db`.

## 2. Scope

### In scope

- Bounded watchlists for VN stocks and XAUUSD.
- TradingView Desktop data through the existing CDP/MCP bridge.
- Quote, bars, study values, Pine levels/labels/tables, and optional screenshots.
- Multi-timeframe context, setup, and trigger profiles.
- Evidence families: levels, structure/trend, indicators/momentum, and volume/footprint.
- Confluence detection requiring at least two independent evidence families.
- Intrabar `PROVISIONAL` events and closed-bar `CONFIRMED` events.
- Structured JSON output, human-readable alerts, evidence ledger, and deterministic replay tests.
- Telegram/dashboard/CLI delivery adapters with explicit read-only permissions.

### Non-goals

- Automatic order placement or broker integration.
- Direct modification of TradingView layouts outside an explicitly leased read operation.
- News, financial-statement, or macro research in the first chart-copilot release.
- Replacing the existing `DATA_JSON` scan/check contract.

## 3. Architecture

```text
TradingView Desktop/CDP
        |
  monitor worker (one process, bounded watchlist)
        |
  chart lease -> identity/freshness validator -> normalizer
        |
  feature extractors -> confluence detector -> alert gate
        |                                      |
  versioned monitor.v1 evidence packet       outbox/evidence ledger
        |
  LLM analyst (explanation only)
        |
  Telegram / dashboard / CLI
```

The monitor worker is separate from the MCP stdio request path. It owns a bounded schedule and a single serial chart lease. On-demand copilot requests use the same lease and pause or queue monitor reads while chart navigation is active.

## 4. Required invariants

### 4.1 Chart lease and identity

- Every read acquires a serial lease for the chart/pane.
- The request includes the expected full symbol identity, provider/exchange, timeframe, pane/layout identity, and profile.
- After any symbol or timeframe navigation, the worker validates the observed identity before accepting data.
- A missing exchange/provider, identity mismatch, lease timeout, or concurrent navigation produces no alert and no evidence packet.
- The initial monitor uses one worker and a bounded watchlist; parallel reads are deferred until lease semantics are proven.

### 4.2 Immutable closed-bar evidence

- A bar key is canonical: `symbol_identity + timeframe + session + bar_open_timestamp + bar_index`.
- Evidence stores separate `source_timestamp`, `receipt_timestamp`, and `evaluated_at` values.
- Clock-skew, future timestamps, out-of-order samples, duplicates, and stale data are rejected or marked `UNKNOWN`.
- `CONFIRMED` requires two consistent reads after the bar-close boundary using the production validation path.
- A stale/missing/disconnected observation is `UNKNOWN` or `STALE`, never `RETRACTED`.

### 4.3 Evidence-family independence

- The engine has fixed, versioned evidence families and profile-specific required fields.
- Two indicators from the same family do not satisfy the two-family gate.
- Every evidence item includes source tool/study ID, configuration version, bar key, freshness, and canonical value.
- Pine labels/tables are untrusted input; only engine-validated facts may enter the LLM packet.

### 4.4 Durable state and outbox

- Event state, evidence, and notification outbox live in a separate local append-only store; `journal.db` remains untouched.
- Event IDs and notification keys are deterministic and idempotent across restart.
- Delivery is marked sent only after adapter acknowledgement; failures remain pending for retry.
- Cooldown is keyed by candidate identity, transition, and evidence revision; a new evidence revision may legitimately notify again.

### 4.5 Versioned compatibility

- The monitor emits a separate `monitor.v1` schema and namespace.
- Existing `DATA_JSON`, scan/check consumers, and doctor contracts remain unchanged.
- Any future bridge to existing contracts requires explicit producer, consumer, documentation, and doctor touchpoints.

## 5. Market profiles

### VN stocks

- Separate exchange session, timezone, holiday, gap, limit, and volume rules.
- Context/setup/trigger defaults are D → H6/H1 → H1, configurable per watchlist item.
- VNINDEX and sector context are `CONTEXT` inputs and do not alert independently.

### XAUUSD

- Separate London/New York session, timezone, maintenance/rollover, spread, and volatility rules.
- Context/setup/trigger defaults are H1/H4 → M15 → M5/M15, configurable per item.
- Tick-volume semantics are not treated as exchange-volume semantics.

Unknown or unconfigured profile values fail closed. Session calendars and policy versions are persisted with each event.

## 6. Watchlist and scheduling

Watchlist tiers:

- `CORE`: held positions or primary symbols; highest priority.
- `TACTICAL`: symbols near a level or setup.
- `DISCOVERY`: scanner candidates; promoted only after profile gates pass.
- `CONTEXT`: benchmarks and cross-asset context; never an independent alert source.

Each item stores `symbol`, `asset_class`, `profile`, `priority`, three timeframes, key levels, allowed setups, session policy, liquidity rules, cooldown, and last event/revision.

Scheduling is adaptive and bounded by tier and session. Bar-close validation is canonical; quote/tick updates may update `PROVISIONAL` state but cannot confirm it. The scheduler records backpressure and pauses safely when the chart lease is unavailable.

## 7. Event state machine

```text
CANDIDATE -> PROVISIONAL -> CONFIRMED -> EXPIRED
                 |             |
                 +----------> RETRACTED
```

- `CANDIDATE`: partial evidence, below the alert gate.
- `PROVISIONAL`: at least two independent families agree intrabar.
- `CONFIRMED`: closed-bar recheck passes with immutable evidence.
- `RETRACTED`: contrary closed-bar evidence invalidates a prior provisional/confirmed setup.
- `EXPIRED`: time window or invalidation boundary ends the event without contrary evidence.
- `UNKNOWN/STALE`: data-quality state, not a directional transition.

Each candidate has a stable identity, revision number, transition history, evidence hash, and terminal-state rule. Restart recovery replays the ledger before new notifications are emitted.

## 8. Detector and LLM boundary

The detector applies profile gates, freshness checks, hard conflicts, family independence, confluence score, and cooldown. It creates a machine-readable evidence packet containing only canonical engine facts.

The LLM may explain the packet and render:

- current bias and evidence summary;
- base, bull, and bear scenarios;
- trigger, invalidation, expected path, and confidence label;
- `WATCH`, `WAIT`, `REVIEW`, or `MANAGE_RISK` guidance.

The LLM may not change event state, invent missing evidence, turn heuristic confidence into a calibrated probability, or issue an order instruction. LLM timeout/failure falls back to deterministic JSON.

## 9. Output contract

`monitor.v1` includes `event_id`, `candidate_id`, `revision`, `status`, `symbol_identity`, `profile`, `timeframe`, `bar_key`, `evidence[]`, `scenarios[]`, `action`, `confidence_label`, `freshness`, `source_timestamps`, `policy_version`, `engine_version`, `schema_version`, `generated_at`, and `evidence_hash`.

Human alerts must show status, symbol/timeframe, closed-bar time, evidence families, missing/stale fields, scenarios, invalidation, and source freshness. Conflicting or incomplete evidence renders `WAIT`.

## 10. Failure handling and observability

- Bounded reconnect with health heartbeat and explicit paused state.
- Malformed payloads are quarantined with reason codes.
- Notification retries use the durable outbox and never create a new event.
- Lease failures, identity mismatches, stale data, and LLM fallback are observable metrics/events.
- The system supports a dry/shadow mode before user-facing alerts.

## 11. Verification

- Unit tests for identity, lease serialization, closed-bar detection, freshness, evidence-family independence, scoring, transitions, cooldown, and outbox idempotency.
- Replay tests use the production detector path with an injected clock and recorded snapshots; identical input must produce identical state and evidence hash.
- Integration tests cover mocked stream reads, chart navigation, disconnect/reconnect, malformed Pine data, duplicate/out-of-order/future samples, DST/holiday boundaries, restart recovery, LLM failure, and notification failure.
- Read-only smoke tests verify a real chart without changing the user's chart permanently.
- Acceptance requires zero confirmed signals from open bars, zero duplicate notifications after restart, no cross-symbol contamination, and unchanged existing `DATA_JSON` behavior.

## 12. Delivery phases

- **M1:** monitor worker, bounded watchlist, lease/identity validator, profile config, feature extraction, and state machine.
- **M2:** durable evidence ledger/outbox, `monitor.v1`, delivery adapters, and replay/integration tests.
- **M3:** LLM scenario renderer and on-demand copilot UI.
- **M4:** calibration/backtest and expanded profiles; only after M1–M3 acceptance.

No phase may add automatic trading or alter `journal.db` without a separate approved design and migration boundary.

