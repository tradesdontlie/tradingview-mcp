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

## T114 — `replay_set_resolution` (tick/second/minute granularity)

**Status:** TODO
**Priority:** Tier-B (normal)
**Effort:** S (<2h)
**Phase:** 1
**Dependencies:** None
**Audit ref:** 2026-07-01 fork-commit deep-dive — `KarmicP@9ba5f9f8` → `iliaal@src/core/replay.js` `setResolution()`; controller path in `iliaal@src/connection.js`
**KB ref:** our `src/core/replay.js`, `src/connection.js` KNOWN_PATHS

### Why
Replay currently advances at the chart's timeframe only. Setting the replay update interval (1 tick / 1s / 1,5,15m / 1H,4H / 1D / auto) lets a backtest walk at the granularity a theory needs — e.g. tick-level fills on a 5m structure — without changing the chart TF. Small, clean, self-contained; iliaal already proved the CDP path.

### Acceptance criteria
- [ ] New `replay_set_resolution(resolution)` tool; `null`/`'auto'` = auto.
- [ ] Controller path `_replayApi._replayUIController`; validate the value against `._allReplayResolutions.value()` BEFORE calling `.changeReplayResolution(value)` (S1 — invalid values corrupt cloud replay state).
- [ ] Reads back `._currentReplayResolution.value()` and returns it.
- [ ] Path resolved via `KNOWN_PATHS` + `verifyAndReturn` (S2).
- [ ] Tests pass; live smoke: set 1S on an intraday chart, confirm read-back matches; reject a bogus value cleanly.
- [ ] **Standards (S1–S5) applied.**

### Files to touch
- `src/core/replay.js` — `setResolution()`.
- `src/tools/replay.js` — tool registration.
- `src/connection.js` — `replayUIController` path.
- `tests/`, `CLAUDE.md`, `README.md`, `FORK_NOTES.md`.

### Implementation notes
Mirror the validate-before-mutate shape of the existing autoplay-delay guard. Enum the human-facing resolutions but always cross-check against the live `_allReplayResolutions` list (TV's set can vary by symbol).

### Verification
```
npm test
# live: replay_set_resolution 1S ; expect returned current_resolution == "1S"
```

### Rollback
Single new tool — revert commit.

### Resume notes
Trivial; complete in one pass.

### Completion checklist
Standard. Commit `T114 shipped — replay_set_resolution tick/second/minute granularity`.

---

## T116 — `chart_snapshot` single-round-trip per-bar capture

**Status:** TODO
**Priority:** Tier-A (high)
**Effort:** M (<1d)
**Phase:** 1
**Dependencies:** None (enables fast T115)
**Audit ref:** 2026-07-01 fork-commit deep-dive — `niwang` PR #297 (collapses state+quote+OHLCV+study-values+pine-graphics into one CDP round-trip)
**KB ref:** our `src/core/data.js` (existing decoders for study values + pine lines/labels/boxes/tables)

### Why
The T115 capture loop reads several data points at every replayed bar. Doing that as N separate CDP `evaluate` calls per bar makes a several-hundred-bar walk painfully slow. A single `evaluate` that returns state + current-bar OHLCV + filtered study values + pine graphics in one round-trip cuts per-bar latency dramatically. It's also independently useful for any "analyze my chart" flow. Upstream PR #297 already demonstrates the consolidation.

### Acceptance criteria
- [ ] New `chart_snapshot({ study_filter?, include? })` returns, in ONE CDP call: symbol/TF, current-bar OHLCV (`bars().valueAt(lastIndex())`), study values (via `dataWindowView`), and pine lines/labels/boxes/tables — filtered by `study_filter`.
- [ ] `include` lets callers drop sections they don't need (keep payload small — honor the CLAUDE.md context rules).
- [ ] Reuses existing decoders from `data.js` (no logic fork); prefer the `study._study || study` + `_source._graphics` fallback traversal (more robust during replay).
- [ ] Tests pass; live smoke: snapshot on a chart with a custom multi-output indicator, confirm one round-trip returns all sections and matches the individual tools.
- [ ] **Standards (S1–S5) applied.**

### Files to touch
- `src/core/data.js` or new `src/core/snapshot.js` — the combined reader.
- `src/tools/` — `chart_snapshot` registration.
- `tests/`, `CLAUDE.md`, `README.md`, `FORK_NOTES.md`.

### Implementation notes
Build the combined page-context IIFE by composing the existing extraction expressions, not by re-implementing them — the field decoding in `data.js` is load-bearing and already correct. Return a compact JSON; large arrays (labels) still respect caps + `truncated` flags.

### Verification
```
npm test
# live: chart_snapshot vs data_get_study_values + data_get_pine_* — values must match
```

### Rollback
Additive tool — revert commit.

### Resume notes
Break: land the core reader + a CLI smoke first, then the MCP tool wrapper + tests.

### Completion checklist
Standard. Commit `T116 shipped — chart_snapshot single-round-trip capture`.

---

## T115 — `replay_walk` capture-during-replay loop → JSONL series

**Status:** TODO
**Priority:** Tier-S (critical — the headline deliverable)
**Effort:** L (<3d)
**Phase:** 1
**Dependencies:** T112 (reliable stepping), T116 (fast single-call capture)
**Audit ref:** 2026-07-01 research — all three agents; confirmed NO fork has built capture-during-replay (we're net-new). Pattern reference: Mathieu2301 `ReplayMode.js` per-bar `chart.periods[0]` + `study.periods[0]`.
**KB ref:** T112, T116; `src/core/replay.js`

### Why
This is the capability that makes browser-replay backtesting exist. Today you can step but nothing records what your indicators said at each bar, so you cannot systematically test a theory or "improve process on back data." `replay_walk` steps a date range and, at each bar, harvests the indicator's study values + pine labels/lines into a structured, timestamped JSONL series you can then analyze. No fork or upstream has this — it's the fork's marquee feature.

### Acceptance criteria
- [ ] New `replay_walk({ from, to, capture, resolution?, max_bars? })`:
  - starts replay at `from` (reusing T113 start hardening if landed; else basic start),
  - steps to `to` using T112 reliable stepping,
  - at each bar calls the T116 snapshot filtered to the `capture` study name(s),
  - appends one JSONL row per bar keyed on bar time: `{ t, ohlcv, studies:{…}, pine:{labels,lines,…} }`.
- [ ] Writes to a caller-supplied path (sanitized per S3) or returns the series; caps at `max_bars` with an explicit `truncated` note (no silent cap — log what was dropped).
- [ ] Honors intraday depth limits gracefully: if `bars().lastIndex()` stops advancing, ends the walk with `reason:'no_more_data'` rather than hanging.
- [ ] Progress is resumable/observable: emits a running count; safe to stop between bars.
- [ ] Tests pass (mocked step+snapshot over a synthetic 20-bar range); live smoke: walk ~50 bars capturing a custom indicator's labels, verify the JSONL is complete, in order, and matches spot-checked manual reads.
- [ ] **Standards (S1–S5) applied** — esp. S1 (if using autoplay/resolution to fast-forward regions) and S3 (path sanitization on output file).

### Files to touch
- `src/core/replay.js` (or new `src/core/backtest.js`) — the walk loop.
- `src/tools/replay.js` — `replay_walk` registration.
- `tests/`, `CLAUDE.md` (add a "backtest / capture" section to the decision tree), `README.md`, `FORK_NOTES.md`.

### Implementation notes
Loop shape mirrors Mathieu2301's `replayStep(1)` → read `periods` per bar, but over CDP. Keep the per-bar payload lean (filter to the one indicator under test). This is the browser-path backtest engine; the Phase-2 socket engine (T118/T119) will later do the same at array speed for large ranges — `replay_walk` remains the fidelity/visual path and the fallback for anything that only runs in the live Desktop. Consider writing JSONL incrementally (stream to disk) so a long walk survives an interrupt.

### Verification
```
npm test
# live: replay_walk --from 2025-03-03 --to 2025-03-05 --capture "<indicator name>" --out walk.jsonl
#       wc -l walk.jsonl ; spot-check 3 rows against manual replay_step + chart_snapshot
```

### Rollback
Additive feature — revert commit. Output files are disposable.

### Resume notes
Break points: (1) loop with in-memory accumulation + return; (2) add streaming JSONL to disk; (3) add resolution/fast-forward + caps. Ship (1) first if time-boxed.

### Completion checklist
Standard. Commit `T115 shipped — replay_walk capture-during-replay backtest loop`.
