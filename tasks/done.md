# Done tasks

> Completed task specs, newest at top. **Append-only — never delete or edit a DONE spec.**
> This queue starts at T112. Historical shipped work (T1–T111) predates the queue and is
> narrated in `../FORK_NOTES.md` (the fork's divergence log) — not migrated here.

## T132 — persistent `.env.local` loader for sidecar secrets

**Status:** DONE (2026-07-22)
**Priority:** Tier-Q (quality-of-life)
**Effort:** S
**Phase:** 2 (Block B follow-on)
**Dependencies:** T118 / T119 (the sidecars that read `TV_SESSION` / `TV_SIGNATURE`)

### Motivation
`backtest_pull` and `backtest_run_strategy` read the session token from `process.env`,
but nothing loaded it — supplying it meant exporting the vars into the exact host that
launched the server, and the T119 pattern extracted a token into a throwaway `.env` it
then deleted. No persistent, low-friction path existed for a long-lived MCP server
started by an editor/agent host rather than a shell.

### Outcome
- New `src/load-env.js`: zero-dependency loader. Pure `parseEnv(text)` +
  `loadEnvFile(path, env)` (no-override semantics — real env wins), plus an import
  side-effect that loads the repo-root `.env.local` into `process.env`. Skips blanks/`#`
  comments; preserves `=` inside values (base64 signature padding).
- `src/server.js`: imports `./load-env.js` as the **first** statement, before anything
  reads `process.env`.
- `.env.local` is gitignored (`.gitignore`: `.env.*`); the token stays local, never
  committed (S3). The loader itself carries no secret.

### Verification (actual)
- `tests/load-env.test.js` — 6 token-free unit tests (temp fixture + own env object),
  green; wired into `test:unit:pure`.
- Live: after `import './src/load-env.js'`, `process.env` gains `TV_SESSION` +
  `TV_SIGNATURE` (checked by key name only, values never echoed). `.env.local` written
  with real newlines, mode 600, `git check-ignore` confirms ignored.

### Files touched
- New: `src/load-env.js`, `tests/load-env.test.js`.
- Modified: `src/server.js` (one import line), `package.json` (`test:unit:pure`),
  `FORK_NOTES.md` (§25), `TASKS.md`, `tasks/done.md`.

### Note
Uncommitted as of filing — commit/push to the public fork is deferred to Kp's trigger,
with the `fork-publishing.md` secret sweep applied at that time.

---

## T119 — strategy harness (strategyReport + code-side P&L)

**Status:** DONE (2026-07-02)
**Priority:** Tier-A
**Effort:** L
**Phase:** 2
**Dependencies:** T118 ✓

### Outcome
Two backtest engines sharing **one canonical metrics schema** (net profit, gross P/L, profit factor, win rate, expectancy, avg/largest win-loss, max drawdown + %, equity curve, trade list):
- **`backtest_from_signals`** (new `src/sidecar/signal_pnl.js`, MCP tool + `tv backtest-from-signals` CLI) — pure code-side P&L over a captured `{t,values}` series (inline or JSONL) with declarative entry/exit `rules` (predicate grammar `{field,op,value?|field2?}` + `all/any/not`, ops incl. crosses/rising/falling/truthy). No browser, no token. Sidesteps Pine's 2000-order strategy cap. **The primary path for our indicator-heavy setup.**
- **`backtest_run_strategy`** (new `src/sidecar/strategy_report.js`, MCP tool + `tv backtest-run-strategy` CLI) — loads a Pine `strategy()` over the socket, reads TV's `study.strategyReport`, normalizes to the same schema (recomputed from the trade list via shared `src/sidecar/metrics.js`) + `tv_native` aggregates. Needs `TV_SESSION`.

**Live dump fixed two real mapping bugs** (the reason the spec demanded a live dump): (1) strategyReport is **zlib-deflate (78 9c), not ZIP** — the lib's jszip `parseCompressed` crashes the study listener (and the MCP process); new `src/sidecar/tv_decompress.js` sniffs magic bytes → zlib/gzip/raw-inflate, installed by patching cached `protocol.js` before `study.js` loads, returns `{report:{}}` on failure (graceful, no crash). (2) max drawdown key is **`maxStrategyDrawDown{,Percent}`** on TV 3.1 (legacy `maxDrawDown` absent → was null); trade times are **ms → normalized to seconds**; `grossLoss` sign-agnostic (`Math.abs`); `percentProfitable` guarded to a 0–1 fraction.

### Verification (actual)
- **26 new unit tests** (`signal_pnl` 12 incl. a hand-computed multi-trade fixture, `strategy_report` 10, `tv_decompress` 4) + **1 headless CLI e2e** (`cli.test.js`), all with injected I/O — no token. 32/32 across the sidecar files.
- **Live smoke** (`STD;Supertrend%Strategy`, NASDAQ:AAPL D, 500 bars): decoded cleanly, **no crash**, 338 trades, recomputed net $3.14M / win 37.6% / PF 1.63; `tv_native.max_drawdown` 367,704, `win_rate` 0.377; trade times in seconds. Token extracted via CDP `Network.getCookies` into a gitignored `.env`, then **deleted — never committed** (Critical secret per fork-publishing rules); fork-publishing secret sweep clean.

### Files touched
- New: `src/sidecar/signal_pnl.js`, `src/sidecar/metrics.js`, `src/sidecar/strategy_report.js`, `src/sidecar/tv_decompress.js`, `tests/signal_pnl.test.js`, `tests/strategy_report.test.js`, `tests/tv_decompress.test.js`.
- Modified: `src/tools/replay.js`, `src/cli/commands/replay.js`, `tests/cli.test.js`, `CLAUDE.md`, `README.md`, `FORK_NOTES.md` (§20), `TASKS.md`, `tasks/{backlog,done}.md`.

---

## T118 — headless backtest sidecar (backtest_pull, Block B)

**Status:** DONE (2026-07-02)
**Priority:** Tier-S (the scale unlock)
**Effort:** L
**Phase:** 2
**Dependencies:** T117 (GO)

### Outcome
New `src/sidecar/backtest_socket.js` + `backtest_pull` MCP tool + `tv backtest-pull` CLI. Browser-free backtest engine: pulls a Pine indicator's full per-bar output over TradingView's WebSocket and normalizes to the **same `{t, values}` rows as replay_walk** (engines interchangeable). Socket lib dynamically imported (never loads at CDP-server startup); socket I/O injectable for tests. Handles `STD;`/`USER;` id resolution, `1e100`→null, newest-first re-sort, date filter, range-depth note. Auth via `TV_SESSION`/`TV_SIGNATURE` env (Critical secret; reverse-engineered protocol — dep pinned).

### Verification (actual)
- `tests/backtest_socket.test.js` 6/6 (injected socket I/O, no token).
- Live: pulled a custom private indicator over ~5 months = 102 bars + graphic (75 labels/7 lines/1 box/1 table) in ~2.3s (~11× faster than replay_walk for the range). JSONL ascending, 7 plot keys/bar.

### Files touched
- `src/sidecar/backtest_socket.js` (new), `src/tools/replay.js`, `src/cli/commands/replay.js`, `tests/backtest_socket.test.js` (new), `package.json`, `CLAUDE.md`, `README.md`, `FORK_NOTES.md`, `TASKS.md`, `tasks/{backlog,done}.md`.

---

## T117 — Mathieu2301 headless-socket viability spike (GO)

**Status:** DONE (2026-07-02) — **verdict: GO**
**Priority:** Tier-A
**Effort:** M
**Phase:** 2

### Outcome
Throwaway spike (scratch dir outside repo, token in gitignored `.env`, nothing committed) confirmed `@mathieuc/tradingview` as a browser-free backtest engine. All probes passed: socket protocol works (2026-07); auth via account session token unlocks study data; a **custom private indicator loaded headlessly and returned its full per-bar `periods` (160 bars) + `graphic` (75 labels / 7 lines / 1 table / 1 box)** in one round-trip; built-in RSI also returned 160 periods. Unblocks T118/T119. Full scrubbed writeup in `RESEARCH.md`.

### Caveats carried forward
- Reverse-engineered protocol — pin lib version, re-smoke before relying.
- Session token = Critical secret (gitignored `.env`, never commit, rotate if leaked). ToS grey; defensible as personal local use.
- `strategyReport` not probed (our scripts are `indicator()` studies) — confirm during T119 alongside the `periods`+`graphic`→code-side-P&L path.

### Files
- `RESEARCH.md` (scrubbed verdict). No code committed (spike). Scratch: `…/scratchpad/tv-socket-spike/`.

---

## T113a — replay re-jump guard + drift-warning (safe subset of T113)

**Status:** DONE (2026-07-01)
**Priority:** Tier-A (high)
**Effort:** S (actual — scoped down from the L original)
**Phase:** 1
**Supersedes scope:** partial of original T113; remainder → T113b

### Outcome
Shipped the two safe, high-value pieces of T113: a **re-jump guard** in `start()` (stopReplay + settle before re-selecting so a re-start lands correctly) and a **drift-warning** (flags a likely clamp when the landed cursor is >4 days from the requested date). Both validated.

The aggressive parts of the original T113 (nulling `_replaySessionState`, `goToRealtime()` in `stop()`) were implemented, found to **regress normal stop→start→step re-use** (proven — 2nd cycle couldn't step), and reverted. `stop()` is back to the proven `stopReplay()`-only. Full analysis + the S5 finding (no `_linking` copy on TV 3.1.0) in FORK_NOTES §18.

### Verification (actual)
- `tests/replay.test.js` 48/48 (re-jump-stop, drift-warn, no-drift-warn added); full suite 60/60.
- Live: 4 forward start/stop/step cycles clean; drift-warning correctly silent on a correct deep-history landing; `replay_walk` unaffected.

### Files touched
- `src/core/replay.js`, `tests/replay.test.js`, `FORK_NOTES.md`, `TASKS.md`, `tasks/{active,done,backlog}.md`.

---

## T115 — replay_walk (capture-during-replay backtest loop)

**Status:** DONE (2026-07-01)
**Priority:** Tier-S (critical — the headline deliverable)
**Effort:** L (<3d)
**Phase:** 1
**Dependencies:** T112, T116 (both done)

### Outcome
New `replay_walk` MCP tool + `tv replay walk` CLI + `src/core/backtest.js`. Steps replay `from`→`to`, capturing each bar's studies + Pine graphics (via chart_snapshot) into a timestamped JSONL series keyed on OHLCV bar time. Explicit termination reasons (reached_end_date / no_more_data / max_bars+truncated), streams to `out` file or returns inline, `waitReady` warm-up poll so the first bar is real. Composes T112/T114/T116; all deps injectable for tests. First net-new capture-during-replay capability in the fork ecosystem — the core backtest primitive.

### Verification (actual)
- `node --test tests/backtest.test.js` → 7/7 (termination reasons, JSONL streaming, capture+sections passthrough, resolution, date validation).
- Live smoke (`BATS:F` 1D → JSONL): 9 rows, strictly ascending bar times, zero nulls, reached_end_date, ~250ms/bar; per-bar study/label/line counts grow as indicators warm up (correct signal evolution).

### Notes
- First captured bar is a warm-up bar (OHLCV present, indicators need lookback) — captured as empty studies, not null.
- current_date (cursor) vs bar.time (bar start) differ by convention (see T116); series keyed on bar.time, current_date recorded alongside.

### Files touched
- `src/core/backtest.js` (new), `src/tools/replay.js`, `src/cli/commands/replay.js`, `tests/backtest.test.js` (new), `CLAUDE.md`, `README.md`, `FORK_NOTES.md`, `TASKS.md`, `tasks/{active,done}.md`.

---

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

