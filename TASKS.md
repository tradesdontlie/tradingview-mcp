# TASKS — tradingview-mcp fork

> Forward task queue for the fork. **Index only — specs live in `tasks/{active,backlog,done}.md`.**
> Shipped-work narrative (what diverges from upstream and why) continues to live in `FORK_NOTES.md`.
> T-numbers are shared across FORK_NOTES + commit messages + this queue, so they never collide.

**Next ID:** T121
**Active branch:** `fixes/draw-api-resolve`

---

## Master ship order

### Block A — Replay reliability & data capture (Phase 1, browser/CDP path)
Fixes the "replay isn't working great" complaint and makes browser-replay backtesting possible for the first time. Ship order:

1. ~~**T112** — Reliable stepping (forward-progress currentDate watch, replaces fragile timer poll).~~ ✅ DONE 2026-07-01. *Foundation for T115.*
2. ~~**T114** — `replay_set_resolution` (tick/second/minute granularity).~~ ✅ DONE 2026-07-01.
3. ~~**T116** — `chart_snapshot` per-bar capture.~~ ✅ DONE 2026-07-01. *Enables fast T115.*
4. ~~**T115** — `replay_walk(from, to, capture)` capture loop → JSONL time-series. *The key deliverable.*~~ ✅ DONE 2026-07-01.
5. **T113** — Adopt iliaal replay hardening (scroll_back + drift-warning, intraday ISO start, two-path session clear, robust stop + dialog dismiss, higher-TF start-sequence). *Only remaining Block A task.*

### Block B — Headless backtest engine (Phase 2, socket path)
The scale unlock: array-speed full-history backtests, no browser. Gated on a viability spike.

6. **T117** — Mathieu2301 socket viability spike (gate). Research/spike.
7. **T118** — Backtest sidecar: full-history study `periods` + `graphic` → signal series. Depends T117.
8. **T119** — Strategy harness: `strategyReport` JSON + code-side P&L for indicator signals. Depends T118.

### Standalone quality
- **T120** — Strategy-tester DOM-scrape fallback (TV 3.1+ report reliability). Tier-Q, opportunistic.

---

## Active
- T113 — Adopt iliaal replay hardening (scroll_back, drift, session clear) — Tier-A / L — see `tasks/active.md`

## Backlog
- T117 — Mathieu2301 headless-socket viability spike — Tier-A / M — see `tasks/backlog.md`
- T118 — Headless backtest sidecar (full-history study series) — Tier-S / L — see `tasks/backlog.md`
- T119 — Strategy harness (strategyReport + code-side P&L) — Tier-A / L — see `tasks/backlog.md`
- T120 — Strategy-tester DOM-scrape fallback — Tier-Q / S — see `tasks/backlog.md`

## Recently done
- T115 — replay_walk (capture-during-replay backtest loop) ⭐ — DONE 2026-07-01 — see `tasks/done.md`
- T116 — chart_snapshot (single-call per-bar capture) — DONE 2026-07-01 — see `tasks/done.md`
- T114 — replay_set_resolution (tick/second/minute granularity) — DONE 2026-07-01 — see `tasks/done.md`
- T112 — Reliable replay stepping (forward-progress currentDate watch) — DONE 2026-07-01 — see `tasks/done.md`
- (historical shipped work T1–T111 is narrated in `FORK_NOTES.md`)
