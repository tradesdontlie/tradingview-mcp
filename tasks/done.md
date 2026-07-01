# Done tasks

> Completed task specs, newest at top. **Append-only — never delete or edit a DONE spec.**
> This queue starts at T112. Historical shipped work (T1–T111) predates the queue and is
> narrated in `../FORK_NOTES.md` (the fork's divergence log) — not migrated here.

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

