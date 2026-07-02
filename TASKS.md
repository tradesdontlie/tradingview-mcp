# TASKS — tradingview-mcp fork

> Forward task queue for the fork. **Index only — specs live in `tasks/{active,backlog,done}.md`.**
> Shipped-work narrative (what diverges from upstream and why) continues to live in `FORK_NOTES.md`.
> T-numbers are shared across FORK_NOTES + commit messages + this queue, so they never collide.

**Next ID:** T121
**Active branch:** `fixes/draw-api-resolve`

---

## ▶ Resume pointer (2026-07-02)

**State:** Block A (browser replay reliability + capture) AND Block B (headless socket engine + strategy harness) both shipped. Three backtest surfaces now work: `replay_walk` (browser capture, T115), `backtest_pull` (headless per-bar series, T118), and the **T119 strategy harness** — `backtest_from_signals` (code-side P&L, no token) + `backtest_run_strategy` (reads TV's strategyReport over the socket). T119 added 26 unit tests (`signal_pnl`/`strategy_report`/`tv_decompress`) + 1 headless CLI e2e; sidecar files 32/32 green; live-smoked on `STD;Supertrend%Strategy` (no crash, sane numbers). **Not yet committed/pushed** as of this pointer — see the T119 commit next.

**Forward queue fully resolved (2026-07-02).** T113b safe subset shipped (guarded `goToRealtime()` teardown in `stop()`; 50/50 replay tests green) — its deep session-recovery + scroll_back remainder is DEFERRED as a documented TV-side limitation (no verified clean client-side fix; prefer `backtest_pull` for long/repeated backtests). T120 CLOSED as superseded by T119's socket `backtest_run_strategy` (no code). See FORK_NOTES §21. **No open fork tasks remain** — only the TV-gated T113b remainder in `tasks/backlog.md`.

**Socket-token note (backtest_pull + backtest_run_strategy):** both need `TV_SESSION` (+ `TV_SIGNATURE`) in the environment. Extract the `sessionid` / `sessionid_sign` cookies from the running TradingView Desktop via CDP `Network.getCookies` — requires explicit user authorization (auto-mode classifier blocks credential harvesting), write to a **gitignored** `.env`, never commit. The T119 live smoke did this then deleted the `.env`. Socket dep `@mathieuc/tradingview ^3.5.2` (reverse-engineered — re-smoke before relying). **strategyReport gotcha:** TV ships the report as zlib-deflate; `strategy_report.js` patches the lib's ZIP-only `parseCompressed` at load (`tv_decompress.js`) — don't remove that patch or strategy reads crash the server.

**Also open:** T113b (replay session-recovery + scroll_back — deep, Tier-B). Do NOT re-attempt naive `_replaySessionState` nulling / `goToRealtime` in `stop()` — proven to regress re-use (FORK_NOTES §18).

**Editing this repo (gotchas hit this session):** source files are **LF**. The Edit/Write tools may write CRLF (and once corrupted a new file with NUL bytes). Normalize with `tr -d '\r'` — do **NOT** use `sed -i` on freshly-Written files (it caused the NUL corruption). Check `git diff --cached -w` if a file's diff looks bloated (EOL flip). `npm install` also flips `package.json` EOL — re-normalize before staging.

---

## Master ship order

### Block A — Replay reliability & data capture (Phase 1, browser/CDP path)
Fixes the "replay isn't working great" complaint and makes browser-replay backtesting possible for the first time. Ship order:

1. ~~**T112** — Reliable stepping (forward-progress currentDate watch, replaces fragile timer poll).~~ ✅ DONE 2026-07-01. *Foundation for T115.*
2. ~~**T114** — `replay_set_resolution` (tick/second/minute granularity).~~ ✅ DONE 2026-07-01.
3. ~~**T116** — `chart_snapshot` per-bar capture.~~ ✅ DONE 2026-07-01. *Enables fast T115.*
4. ~~**T115** — `replay_walk(from, to, capture)` capture loop → JSONL time-series. *The key deliverable.*~~ ✅ DONE 2026-07-01.
5. **T113a** ✅ DONE 2026-07-01 — re-jump guard + drift-warning (safe subset). Deep remainder (session recovery + scroll_back) split to **T113b** in backlog after naive session-clear was found to regress re-use.

### Block B — Headless backtest engine (Phase 2, socket path)
The scale unlock: array-speed full-history backtests, no browser. Gated on a viability spike.

6. ~~**T117** — Mathieu2301 socket viability spike (gate).~~ ✅ DONE 2026-07-02 — **GO**.
7. ~~**T118** — Backtest sidecar: full-history study `periods` + `graphic` → signal series.~~ ✅ DONE 2026-07-02 (`backtest_pull`).
8. ~~**T119** — Strategy harness: `strategyReport` JSON + code-side P&L for indicator signals.~~ ✅ DONE 2026-07-02 (`backtest_from_signals` + `backtest_run_strategy`). **Block B complete.**

### Standalone quality
- **T120** — Strategy-tester DOM-scrape fallback (TV 3.1+ report reliability). Tier-Q, opportunistic.

---

## Active
- (none — Blocks A + B shipped; only optional-quality T113b / T120 remain in `tasks/backlog.md`)

## Backlog
- T113b — replay session recovery + scroll_back (deep remainder) — DEFERRED, documented TV limitation (safe subset shipped) — see `tasks/backlog.md` + FORK_NOTES §21
- T120 — Strategy-tester DOM-scrape fallback — WON'T-FIX / superseded by T119 — see `tasks/backlog.md` + FORK_NOTES §21

## Recently done
- T113b (safe subset) — guarded `goToRealtime()` teardown in replay `stop()` + documented ~4-5-cycle TV limitation — DONE 2026-07-02 — see FORK_NOTES §21
- T120 — closed as superseded by T119 (socket strategyReport beats DOM-scrape); no code — DONE 2026-07-02 — see FORK_NOTES §21
- T119 — strategy harness: `backtest_from_signals` + `backtest_run_strategy` ⭐ — DONE 2026-07-02 (code-side P&L + strategyReport reader, one canonical schema; zlib-decompress + key-mapping fixes) — see `tasks/done.md`
- T118 — headless backtest sidecar (`backtest_pull`) ⭐ — DONE 2026-07-02 (array-speed socket engine, ~11× faster) — see `tasks/done.md`
- T117 — headless-socket viability spike — DONE 2026-07-02 (**GO** — socket loads our private indicators headlessly) — see `tasks/done.md`
- T113a — replay re-jump guard + drift-warning (safe subset of T113; remainder → T113b) — DONE 2026-07-01 — see `tasks/done.md`
- T115 — replay_walk (capture-during-replay backtest loop) ⭐ — DONE 2026-07-01 — see `tasks/done.md`
- T116 — chart_snapshot (single-call per-bar capture) — DONE 2026-07-01 — see `tasks/done.md`
- T114 — replay_set_resolution (tick/second/minute granularity) — DONE 2026-07-01 — see `tasks/done.md`
- T112 — Reliable replay stepping (forward-progress currentDate watch) — DONE 2026-07-01 — see `tasks/done.md`
- (historical shipped work T1–T111 is narrated in `FORK_NOTES.md`)
