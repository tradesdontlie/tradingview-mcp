# Done tasks

> Completed task specs, newest at top. **Append-only — never delete or edit a DONE spec.**
> This queue starts at T112. Historical shipped work (T1–T111) predates the queue and is
> narrated in `../FORK_NOTES.md` (the fork's divergence log) — not migrated here.

## T116 — chart_snapshot (single-call per-bar capture)

**Status:** DONE (2026-07-01)
**Priority:** Tier-A (high)
**Effort:** M (<1d)
**Phase:** 1
**Dependencies:** None (enables fast T115)

### Outcome
New `chart_snapshot` MCP tool + `tv snapshot` CLI + `src/core/snapshot.js`. One concurrent capture of state + current-bar OHLCV + study values + Pine lines/labels/tables/boxes, filtered by `study_filter`, section-selectable via `include`, error-isolated per section, with `bar_time` surfaced. Reuses the existing tested `data.js`/`chart.js` decoders (concurrent `Promise.all`, not a fused IIFE — rationale in FORK_NOTES §16) so no fragile-decode duplication. Fetchers injectable via `_deps` for unit testing.

### Verification (actual)
- `node --test tests/snapshot.test.js` → 5/5 (sections, study_filter, unknown-section-throws, per-section error isolation, bar_time).
- Live smoke: realtime 111ms all 7 sections (4 studies, pine labels×4/lines×2); in-replay 6ms.
- Finding for T115: `current_date` (replay cursor, period-end) ≠ OHLCV `bar.time` (bar start) — same bar, different convention. Key the walk series on `bar.time`.

### Files touched
- `src/core/snapshot.js` (new), `src/tools/data.js`, `src/cli/commands/data.js`, `tests/snapshot.test.js` (new), `CLAUDE.md`, `README.md`, `FORK_NOTES.md`, `TASKS.md`, `tasks/{active,done}.md`.

---

## T114 — replay_set_resolution (tick/second/minute granularity)

**Status:** DONE (2026-07-01)
**Priority:** Tier-B (normal)
**Effort:** S (<2h)
**Phase:** 1
**Dependencies:** None

### Outcome
Added `setResolution()` core fn + `replay_set_resolution` MCP tool + `replay set-resolution` CLI subcommand. Sets replay stepping granularity via `_replayApi.changeReplayResolution()`, validating the requested value against the **live** `replayResolutions()` set before mutating (the set is symbol/timeframe-dependent; invalid values corrupt cloud replay state — S1). `"auto"`→null. Live probe (see FORK_NOTES "Replay API surface") confirmed these methods sit on `_replayApi` directly, so we avoided the private `_replayUIController`.

### Verification (actual)
- `node --test tests/replay.test.js` → 45/45 (added: valid passthrough, invalid-rejected-before-mutate, auto→null, omitted-throws).
- Live smoke (`BATS:F` 1D): set `1H`→reads back `1H`; `auto`→null/is_auto; `7M`→rejected with valid list, no mutation; clean stop.

### Files touched
- `src/core/replay.js`, `src/tools/replay.js`, `src/cli/commands/replay.js`, `tests/replay.test.js`, `CLAUDE.md`, `README.md`, `FORK_NOTES.md`, `TASKS.md`, `tasks/{active,done}.md`.

---

## T112 — Reliable replay stepping (forward-progress currentDate watch)

**Status:** DONE (2026-07-01)
**Priority:** Tier-A (high)
**Effort:** S (<2h)
**Phase:** 1
**Dependencies:** None (foundation for T115)
**Audit ref:** 2026-07-01 replay research (internals agent) + live CDP probe

### Outcome
Rewrote `step()` in `src/core/replay.js` to use `currentDate()` **forward progress** (`current > before`) as the completion signal, polling every 60ms up to a 3s ceiling, and **throwing** at end-of-data instead of returning a stale date. Timing is injectable via `_deps` (`pollMs`/`stepTimeoutMs`) for fast unit tests.

Key correction during implementation: the planned `bars().lastIndex()` signal was disproven by live probing (it freezes at loaded-series size, doesn't track the replay cursor). `currentDate()` is the real per-bar signal but flickers to transient lower values mid-transition — hence the strict forward-progress check. Full findings in `FORK_NOTES.md` §14 + "Replay API surface" reference block.

### Verification (actual)
- `node --test tests/replay.test.js` → 41/41 pass (added forward-progress, no-stale-return, and transient-glitch regression guards).
- Live smoke (fresh TV Desktop 3.1.0, `BATS:F` 1D): 10 consecutive steps, all forward incl. weekend gap, avg ~178ms/step, clean start→step×10→status→stop.
- Confirmed the retired 250ms×12 stale-return behavior is gone (now throws).

### Notes
- S5 probe recorded `currentDate()` WatchedValue is `.subscribe`-able → future event-driven stepping upgrade.
- Discovered replay session-state pollution (symptom: `start()` → `current_date = -63072000`) from repeated start/stop cycles; cleared by TV restart. Flagged for T113 (`CLEAR_SESSION_STATE_JS`).
- Ride-along: fixed a pre-existing `tests/e2e.test.js` `replay_stop` failure (double-teardown assertion on TV 3.1.0) with best-effort try/catch; real core `stop()` hardening remains T113.

### Files touched
- `src/core/replay.js`, `tests/replay.test.js`, `tests/e2e.test.js`, `FORK_NOTES.md`, `TASKS.md`, `tasks/{active,done}.md`.

