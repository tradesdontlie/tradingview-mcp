# Backlog tasks

> Full specs for filed-but-not-active tasks. Move OUT to `active.md` when picked up.
> Standards S1–S5 (see `active.md`) apply to all tasks below.
> Index: `../TASKS.md`.

---

## T113b — replay session recovery + scroll_back (deep remainder of T113)

**Status:** TODO
**Priority:** Tier-B (normal — nice-to-have; the backtest engine works without it)
**Effort:** L (<3d)
**Phase:** 2
**Dependencies:** None
**Supersedes:** remainder of T113 (T113a shipped the safe subset)
**Audit ref:** FORK_NOTES §18 (what was tried + reverted); live findings during T113a

### Why
Two hard problems T113a deliberately left alone because naive fixes regressed re-use:
1. **Repeated-cycle corruption / recovery.** After ~4–5 rapid start/stop cycles, replay degrades (5th `step()` can't advance); only a TV restart clears it today. Nulling `_chartWidgetCollection._replaySessionState` and/or `goToRealtime()` in `stop()` made it WORSE (broke the 2nd cycle) — so recovery needs real investigation of TV 3.1.0's replay-session teardown, not blind field-nulling. Candidates to probe: `leaveReplay()`, `_replayContainer` lifecycle, the `_replayUIController._restoreReplaySessionState` / `_updateReplaySessionState` methods (seen in the live prototype dump).
2. **scroll_back for backward jumps past the loaded buffer.** A `selectDate()` to a target earlier than the loaded history buffer clamps (cursor stalls, `step()` then can't advance). Needs pre-loading older history via synthetic `Input.dispatchMouseEvent({type:'mouseWheel', deltaX:-120})` batches at the pane canvas until `bars().valueAt(firstIndex())[0] <= targetTs`, BEFORE `showReplayToolbar()`. iliaal's `_scrollBackToTarget` is the reference (but re-verify paths on 3.1.0).

### Acceptance criteria
- [ ] A safe replay-session reset that lets ≥10 consecutive start/stop cycles step cleanly with no TV restart — WITHOUT regressing normal stop→start→step (guard with a repeated-cycle live test).
- [ ] `scroll_back` option on `start()`: backward jump past the buffer pre-loads history and lands correctly (drift-warning from T113a should then NOT fire).
- [ ] Robust `stop()` teardown that doesn't break the next start (only add `goToRealtime`/`leaveReplay` if proven safe via the repeated-cycle test).
- [ ] Tests + live smoke (10 cycles; a deep backward jump). **Standards S1–S5**, esp. S5 (probe the teardown methods live first).

### Files to touch
- `src/core/replay.js`, `src/connection.js` (wheel-dispatch pane target), `tests/replay.test.js`, `FORK_NOTES.md`.

### Implementation notes
Start by live-probing `_replayUIController` teardown methods and the `_replayContainer` lifecycle — do NOT re-attempt the reverted `_replaySessionState = null` approach without understanding why it desyncs. The repeated-cycle degradation may even be a TV bug with no clean client-side fix; if so, document that and cap `replay_walk` guidance accordingly.

### Verification / Rollback / Resume
Live 10-cycle test must pass; `replay_walk` must remain green. Additive/guarded changes — revert commit if a regression appears. Natural split: (a) session recovery, (b) scroll_back — ship independently.

---

## T117 — Mathieu2301 headless-socket viability spike (gate)

**Status:** DONE (2026-07-02) — GO. Full outcome in `tasks/done.md`. Kept here for the spec/context; T118/T119 unblocked.
**Priority:** Tier-A (high — gates all of Block B)
**Effort:** M (<1d)
**Phase:** 2
**Dependencies:** None (but gates T118/T119)
**Audit ref:** 2026-07-01 research — other-implementations agent: `Mathieu2301/TradingView-API` (~4.1k★) socket client; `study.periods`, `study.graphic`, `study.strategyReport`, `getPrivateIndicators().get()`, `ReplayMode.js`, `FromToData.js`
**KB ref:** external repo `github.com/Mathieu2301/TradingView-API`

### Why
Block B (the array-speed backtest engine) rests entirely on Mathieu2301's reverse-engineered WebSocket protocol working *today* against TradingView's servers and being able to load our custom (incl. invite-only) Pine indicators. Reverse-engineered protocols break periodically, and it needs account `SESSION`/`SIGNATURE` cookies (secrets). This spike de-risks Block B with a small, throwaway proof before committing to T118/T119 build effort. If it fails, we stay on the browser path (Block A) and record why.

### Acceptance criteria
- [ ] In a scratch/throwaway dir (NOT committed — S3), install the lib and authenticate with a private session token from a secure source (env var / secrets file, never hardcoded).
- [ ] Confirm (or refute) each capability, with evidence:
  - load a built-in indicator and read `study.periods` over a date range (`FromToData.js` pattern);
  - load one of *our* custom indicators via `getPrivateIndicators().get()` → `chart.Study()` and read its `periods` + `graphic` (labels/lines/tables);
  - load a trivial `strategy()` script and read `strategyReport` fields.
- [ ] Check the repo's recent issues for July-2026 protocol-breakage reports; note lib version tested.
- [ ] Written go/no-go recommendation with observed throughput (bars/round-trip) and failure modes.
- [ ] **Standards S3** strictly (secrets handling); S5 not applicable (socket, not CDP).

### Files to touch
- None committed. Findings recorded in `RESEARCH.md` (scrubbed) and this task's completion note. Secrets stay out of the repo.

### Implementation notes
Treat the account token as a Critical secret per `~/.claude/rules/fork-publishing.md` — if it ever lands in a commit, rotate immediately. Prefer a local `.env` (already gitignored) read at runtime. This is a spike: optimize for a fast yes/no, not clean code.

### Verification
Manual: run the three capability probes; paste evidence (trimmed) into the go/no-go note.

### Rollback
Nothing committed — delete the scratch dir.

### Resume notes
Each of the three probes is an independent stop point; the private-indicator probe is the load-bearing one for our use case.

### Completion checklist
Mark DONE with the go/no-go verdict; if GO, unblock T118/T119 in `../TASKS.md`; if NO-GO, mark T118/T119 BLOCKED with the reason and lean on Block A. Update `RESEARCH.md`. No code commit expected.

---

## T118 — Headless backtest sidecar (full-history study series)

**Status:** TODO
**Priority:** Tier-S (critical — the scale unlock)
**Effort:** L (<3d)
**Phase:** 2
**Dependencies:** T117 ✅ GO (2026-07-02) — unblocked
**Audit ref:** 2026-07-01 research — Mathieu2301 `study.periods` + `study.graphic` over a date range in one pull; contrast with browser `replay_walk` (T115) at seconds/bar
**KB ref:** T117 findings

### Why
The browser replay path (Block A) is fidelity-perfect but slow — fine for hundreds of bars, not for scanning years across many symbols. A headless sidecar that pulls a custom indicator's full-history `periods` + `graphic` in one socket round-trip turns "minutes per session" into "whole history at array speed", while still running our *actual* Pine on TV's servers (fidelity preserved, invite-only supported). This is the efficiency the "biggest miss" note is about.

### Acceptance criteria
- [ ] A separate Node sidecar process/module (not mixed into the CDP server) exposing a callable interface the MCP can invoke (tool `backtest_pull` or a thin MCP shim).
- [ ] Given a symbol, timeframe, date range, and indicator id(s), returns the per-bar study values + graphic (labels/lines/boxes/tables) as a timestamped series — same logical shape as T115's JSONL, so downstream analysis is interchangeable between browser and socket paths.
- [ ] Auth via secure token (S3); token never logged or committed.
- [ ] Graceful failure if the socket protocol breaks (clear error → caller can fall back to T115 browser path).
- [ ] Tests (mock the socket client) + live smoke pulling one custom indicator over a multi-month range; cross-check a handful of bars against T115/`chart_snapshot` for fidelity.
- [ ] **Standards S3, S4** applied (S1/S2/S5 are CDP-specific — N/A here).

### Files to touch
- New `sidecar/` (or `src/sidecar/`) module wrapping the socket lib.
- `src/tools/` — MCP shim tool if we expose it directly.
- `tests/`, `CLAUDE.md`, `README.md`, `FORK_NOTES.md`.

### Implementation notes
Keep the sidecar loosely coupled — it may break independently when TV changes the socket protocol, and we don't want that to destabilize the CDP server. Normalize output to the T115 schema so the analysis layer is engine-agnostic. Document the "when to use socket vs browser" decision in CLAUDE.md.

### Verification
```
npm test
# live: backtest_pull SYMBOL TF FROM TO "<indicator>" → series; diff sample bars vs chart_snapshot
```

### Rollback
Additive module — revert commit; sidecar removal doesn't affect the CDP server.

### Resume notes
Break: (1) sidecar reads built-in indicator series; (2) private-indicator series; (3) MCP shim + schema normalization.

### Completion checklist
Standard (S4). Commit `T118 shipped — headless backtest sidecar (full-history study series)`.

---

## T119 — Strategy harness (strategyReport + code-side P&L)

**Status:** TODO
**Priority:** Tier-A (high)
**Effort:** L (<3d)
**Phase:** 2
**Dependencies:** T118 (T117 GO ✓)
**Audit ref:** 2026-07-01 research — Mathieu2301 `study.strategyReport` (netProfit, percentProfitable, profitFactor, maxDrawDown, trades[], equity history); internals agent — code-side P&L avoids Pine's 2000-order cap
**KB ref:** T118

### Why
Two ways to get real backtest metrics: (a) for a theory formalized as a `strategy()`, read `strategyReport` JSON directly — full trade list + performance, no screenshots; (b) for `indicator()` signals (labels/lines), turn them into a timestamped signal series and compute P&L / win-rate / equity curve in code, which sidesteps Pine's strategy-engine limits (2000-order cap, single-position quirks). This gives "improve process on back data" real, queryable numbers.

### Acceptance criteria
- [ ] `backtest_run_strategy(script_id, symbol, tf, range)` → normalized report object (net profit, win rate, profit factor, max DD, trade list, equity/drawdown series). Dump `strategyReport` keys live once and map to canonical field names (internals agent flagged key names aren't enumerated in existing code).
- [ ] `backtest_from_signals(series, rules)` → given a T115/T118 signal series and simple entry/exit rules, compute P&L, win rate, expectancy, max DD, equity curve in code.
- [ ] Both return the same metrics schema so strategy-script and indicator-signal backtests are comparable.
- [ ] Tests with a known fixture (hand-computed expected P&L) + live smoke on a trivial strategy.
- [ ] **Standards S3, S4** applied.

### Files to touch
- `sidecar/` — `strategyReport` reader + signal-P&L engine.
- `src/tools/` — the two MCP tools.
- `tests/` (fixture-based P&L test), `CLAUDE.md`, `README.md`, `FORK_NOTES.md`.

### Implementation notes
The code-side P&L engine is the more valuable half for our indicator-heavy setup — keep it pure/vectorizable and well-tested (this is where silent math bugs hide; use a fixture with hand-verified expected output). Canonical metrics schema should match whatever the downstream analysis layer expects (kept generic here).

### Verification
```
npm test   # fixture P&L must match hand-computed values exactly
# live: backtest_run_strategy on a sample strategy → sane report
```

### Rollback
Additive — revert commit.

### Resume notes
Break: (1) strategyReport reader + key mapping; (2) signal-P&L engine + fixture test; (3) MCP tool wrappers.

### Completion checklist
Standard (S4). Commit `T119 shipped — strategy harness (strategyReport + code-side P&L)`.

---

## T120 — Strategy-tester DOM-scrape fallback (TV 3.1+ report reliability)

**Status:** TODO
**Priority:** Tier-Q (cleanup/quality)
**Effort:** S (<2h)
**Phase:** 1-or-2 (opportunistic — ride along with any strategy-read work)
**Dependencies:** None
**Audit ref:** 2026-07-01 fork-commit deep-dive — `richroberts` PR #96 (DOM-scrape fallback when `reportData`/`ordersData` return empty on TV 3.1+); also PR #90, #51, #216
**KB ref:** our `src/core/data.js:135-243` (existing internal-API strategy reads)

### Why
Our `data_get_strategy_results`/`_trades` read the internal `dataSources().reportData()`/`ordersData()`. On TV 3.1+ these sometimes return empty even when the Strategy Tester panel shows data. PR #96 adds a DOM-scrape fallback so results still come back, tagged `source:'internal_api'|'dom_fallback'`. Low-risk reliability win for the browser strategy-read path.

### Acceptance criteria
- [ ] When the internal-API strategy read returns empty, fall back to scraping the Strategy Tester panel DOM (List of trades + summary).
- [ ] Response tags which path produced the data (`source` field).
- [ ] No regression when the internal API works (fallback only triggers on empty).
- [ ] Tests pass; live smoke on a chart with an active strategy where the internal read is known to come back empty.
- [ ] **Standards S2, S4** applied.

### Files to touch
- `src/core/data.js` — fallback in the strategy read path.
- `tests/`, `CLAUDE.md`, `FORK_NOTES.md`.

### Implementation notes
Port PR #96's selectors but re-verify against current TV Desktop DOM (selectors rot). Keep the internal API as primary — scrape is last resort.

### Verification
```
npm test
# live: force an empty internal read, confirm dom_fallback populates + source flag
```

### Rollback
Single-file — revert commit.

### Resume notes
Trivial; one pass. Good ride-along with T119.

### Completion checklist
Standard (S4). Commit `T120 shipped — strategy-tester DOM-scrape fallback`.
