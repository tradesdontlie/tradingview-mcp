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

_(no active tasks — Block A shipped; remaining work T113b + Phase 2 is in `backlog.md`. Standards S1–S5 above still apply.)_
