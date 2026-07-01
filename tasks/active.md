# Active tasks

> Full specs for tasks ready to work on. Move OUT to `done.md` on completion or `backlog.md` if deferred.
> Index: `../TASKS.md`. Shipped-divergence narrative: `../FORK_NOTES.md`.

---

## Standards (S1–S5) — apply to T112–T120

Cross-cutting requirements shared by every replay/backtest task. Each task references these instead of duplicating.

- **S1 — Never send unvalidated values to cloud-persisted replay state.** Autoplay delay and replay resolution both write to TradingView cloud account state; invalid values corrupt it *permanently*. Validate against the known-good set (autoplay: `[100,143,200,300,1000,2000,3000,5000,10000]`; resolution: read `_replayUIController._allReplayResolutions.value()` live) BEFORE any CDP call that mutates. Precedent: `src/core/replay.js:78-80`.
- **S2 — DI + path-guard pattern.** New core functions take `{ _deps } = {}` and resolve via `_resolve(_deps)` (precedent `src/core/replay.js:12-17`). Every undocumented TradingView path goes through `KNOWN_PATHS` + `verifyAndReturn` in `src/connection.js` so a renamed internal path fails loud, not silent.
- **S3 — Public-fork hygiene.** This fork is public. NO private identifiers, personal paths, or proprietary strategy/theory content in committed code, docs, tests, or comments. Use generic language ("custom multi-output indicator", "signal series"). Run the sweep in `~/.claude/rules/fork-publishing.md` before every push. Never commit account cookies/session tokens.
- **S4 — Doc propagation is part of done.** On completion update: `FORK_NOTES.md` (new divergence entry, oldest→newest), `CLAUDE.md` (tool decision-tree + tool-count), `README.md` (tool count if changed), and add/extend tests under `tests/`.
- **S5 — Live-probe before relying on undocumented surface.** TradingView renames internal paths without notice. Before building on a method/property not already exercised in our code, dump it live via CDP (`Object.getOwnPropertyNames(Object.getPrototypeOf(obj))`) and record the finding in the task's Implementation notes. Requires TradingView Desktop running with `--remote-debugging-port=9222`.

---

## T113 — Adopt iliaal replay hardening (scroll_back, drift-warning, session clear)

**Status:** TODO
**Priority:** Tier-A (high)
**Effort:** L (<3d)
**Phase:** 1
**Dependencies:** None (independent within Block A)
**Audit ref:** 2026-07-01 fork-commit deep-dive — `iliaal/tradingview-mcp@master:src/core/replay.js` (`_scrollBackToTarget`, drift detection, `CLEAR_SESSION_STATE_JS`), `src/core/dialog.js`; `aydh5848-design` PR #238 (Promise.race timeouts)
**KB ref:** our `src/core/replay.js` `start()`/`stop()`

### Why
Our `replay_start` has three latent bugs the iliaal superfork already solved: (1) a backward `selectDate` past the loaded bar buffer silently clamps — cursor stalls at a stale bar with a false "success"; (2) re-jumping while replay is already running gets absorbed by TV, pinning the cursor; (3) `stop()` can leave a "Continue your last replay?" state that survives restart. It also can't target an intraday bar (only `YYYY-MM-DD`), and hits TV's "data point unavailable" when starting replay on a low timeframe beyond the intraday buffer. Adopting iliaal's mechanisms fixes all of these and makes replay start land where we ask, every time.

### Acceptance criteria
- [ ] `start()` accepts ISO-with-offset timestamps (e.g. `2026-05-08T09:33:00-04:00`) to land on a specific intraday bar, in addition to `YYYY-MM-DD`.
- [ ] Optional `scroll_back` behavior: before engaging replay, synthetic `mouseWheel` batches force-load older history until `bars().valueAt(firstIndex())[0] <= targetTs`, with a `no_more_history` bailout on 2× no-progress and a max-attempts cap. Must run BEFORE `showReplayToolbar()`.
- [ ] Drift-warning: after `selectDate`, if `|currentDate - requestedTs| > 300s`, return a `warning` field surfacing the clamp instead of silent success.
- [ ] Re-jump safety: if replay already running, `stopReplay()` + clear session state + settle before re-`selectDate`.
- [ ] Two-path session clear nulls `_replaySessionState` at both `_chartWidgetCollection` and `_linking._chartWidgetCollection`.
- [ ] `stop()` runs `stopReplay()` + `goToRealtime()` and dismisses the "Leave current replay?" native dialog.
- [ ] Start-sequence workaround for "data point unavailable": when target TF is intraday and select fails, retry on a higher TF then drop to target (per TV support doc).
- [ ] CDP calls that can hang on the native dialog are wrapped with a `Promise.race` timeout (PR #238 pattern).
- [ ] Tests pass; live smoke: jump back 60 days on a 5m chart (exercises scroll_back), jump to an intraday timestamp, re-jump while running, stop cleanly (no leftover dialog).
- [ ] **Standards (S1–S5) applied.**

### Files to touch
- `src/core/replay.js` — `start()`, `stop()`, new `_scrollBackToTarget`, `CLEAR_SESSION_STATE_JS` const.
- `src/core/dialog.js` (new, port concept from iliaal) — `dismissBlockingDialogs()`.
- `src/connection.js` — path guards for `_linking._chartWidgetCollection`, wheel-dispatch pane target.
- `src/tools/replay.js` — expose `scroll_back` param on `replay_start`.
- `tests/`, `CLAUDE.md`, `README.md`, `FORK_NOTES.md`.

### Implementation notes
Port iliaal's approach; do NOT vendor their whole file (they removed `ui_evaluate` and restructured — we keep ours). Cherry-pick the mechanisms. Synthetic wheel via CDP `Input.dispatchMouseEvent({type:'mouseWheel', deltaX:-120})` at the active pane canvas. Consider splitting into T113a (start/scroll_back/drift) and T113b (stop/dialog/session-clear) if it grows past L during execution (per skill: replan rather than let an L balloon).

### Verification
```
npm test
# live smoke sequence per acceptance criteria; capture screenshots to confirm cursor lands correctly
```

### Rollback
Multi-file — keep as one commit if feasible; `git revert`. If split, revert b then a.

### Resume notes
Natural break: land start()/scroll_back/drift first (most value), commit, then stop()/dialog/session-clear as a second pass.

### Completion checklist
Standard. Commit `T113 shipped — replay hardening: scroll_back, drift-warning, session clear`.

---
