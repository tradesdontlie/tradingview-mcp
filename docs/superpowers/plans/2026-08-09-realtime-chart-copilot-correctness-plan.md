# Realtime Chart Copilot — Correctness Fix Plan

Status: `PAUSED_BEFORE_IMPLEMENTATION`

This plan is the next fresh workflow round. The previous controller is
`BLOCKED` and must not be resumed. The current additive monitor implementation
and its untracked files are preserved; no deletion, reset, staging, or commit is
part of this plan.

## Goal

Repair the three remaining correctness defects in the read-only chart monitor:

1. Preserve newer same-event checkpoint state across persistence and restart.
2. Enforce the canonical profile session allowlist fail-closed.
3. Restore `last_seen` exactly across restart and expiry boundaries.

## Exact write scope

Only these seven files may change:

- `src/monitor/profiles.js`
- `src/monitor/normalize.js`
- `src/monitor/store.js`
- `src/monitor/worker.js`
- `test_monitor_engine.mjs`
- `test_monitor_store.mjs`
- `test_monitor_worker.mjs`

All other files are read-only for this round, including the remaining
`src/monitor` modules, `journal.db`/sidecars, `src/core/**`, package and lock
files, DATA_JSON producers/consumers, unrelated tests, the approved design
spec, and `CONTRACTS.md` Sections 9A–9C.

## Non-goals

- No orders, broker integration, Telegram/dashboard/LLM delivery, or chart UI automation.
- No new dependencies, package exports, migrations, schema changes, refactors, or cleanup.
- No deletion, revert, stage, commit, deployment, or journal access.

## Work sequence

### T0 — read-only resume audit

Recheck the worktree and the seven owned files. Confirm the existing untracked
implementation is still present, protected hashes are unchanged, and the three
known defects remain the only intended scope. If any protected path drifted,
stop before editing.

### T1 — one bounded coding pass

Implement only:

- **Checkpoint progress:** checkpoint identity must distinguish newer
  `state_observations` even when `event_id`, revision, evidence revision and
  evidence hash are unchanged. Restart must hydrate the latest checkpoint.
- **Session fail-closed:** normalization must consume the canonical
  `profiles.js` `sessions` allowlist. Missing, unknown, unconfigured, or
  out-of-policy sessions reject; an explicitly approved producer session is
  accepted. Do not invent session labels from time ranges.
- **Last-seen restore:** worker hydration must use persisted `last_seen`, not
  `generated_at`, and expiry behavior must remain exact around the threshold.
- Add exactly one production-path regression in each of:
  `test_monitor_engine.mjs`, `test_monitor_store.mjs`, and
  `test_monitor_worker.mjs`.

### T1 — owning verification

Run and record actual exit codes:

```text
node test_monitor_engine.mjs
node test_monitor_store.mjs
node test_monitor_worker.mjs
node test_monitor_contracts.mjs
node test_closed_bar_integrity.mjs
node test_session_phase.mjs
git diff --check
node --check src/monitor/*.js
```

Also perform an allowlisted path/status audit and verify no forbidden
navigation, UI, drawing, journal, DATA_JSON, package, or dependency changes.

## Acceptance criteria

- `CHECKPOINT_PROGRESS`: persist open then closed state with unchanged event and
  revision identity; restart retains both observations and the next valid close
  can confirm.
- `SESSION_FAIL_CLOSED`: default resolved profile rejects an unconfigured
  session and accepts only a producer-contract-approved token.
- `LAST_SEEN_RESTORE`: restart reproduces the exact persisted `last_seen`; expiry
  occurs only on the correct side of the injected-clock boundary.
- `REGRESSIONS`: exactly three new/updated production-path regressions, one per
  named test file, all passing.
- `PRESERVE`: no protected path or public contract changes; existing additive
  implementation remains intact.

## Review gate

After T1 passes, freeze a new immutable snapshot containing the exact working
tree paths and SHA-256 hash. Run an independent read-only reviewer against that
snapshot and fresh test evidence. A single bounded retry is allowed only for a
review-confirmed fix; any retry invalidates the snapshot and requires a fresh
snapshot, full verification, and fresh review. A second failure or scope drift
stops the round as `BLOCKED`.

## Resume checklist

1. Re-read this plan and the approved design.
2. Recreate a new controller plan; do not resume the old blocked controller.
3. Run T0 audit before any edit.
4. Preserve the current untracked monitor files and journal sidecars.
5. Do not stage or commit unless separately authorized after review `PASS`.
