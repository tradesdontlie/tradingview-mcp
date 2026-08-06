# tradingview-mcp — Project conventions

This file supplements the canonical policy at `C:\Users\ADMIN\.codex\AGENTS.md`.
Do not duplicate or weaken rules from that file.

`CLAUDE.md` in this directory documents the TradingView MCP tools. This file
covers project-level conventions.

## Before making changes

Before changing any engine, pipeline, skill, or schema in this repo, read
`C:\Users\ADMIN\claude_os\CONTRACTS.md` Section 9 and follow its touchpoint
and final-check requirements (canonical policy: `.codex/AGENTS.md`).

## Journal database

- `journal.db` is the canonical trading journal. Use read-only queries
  (`?mode=ro` with SQLite) unless explicitly asked to write.
- Schema is defined in `journal_setup.sql`. Do not alter it without a
  corresponding migration script.
- Backup files (`journal.db.bak-*`) are historical — read-only.
- When diagnosing journal issues, prefer PRAGMA queries over direct file edits.

## Testing

- Test files are `.mjs` files at the repo root (e.g., `test_decision.mjs`,
  `test_fmt_check.mjs`, `test_telegram_readiness.mjs`).
- Run relevant tests before/after changes: `node test_<name>.mjs`.
- If you add a new module under `src/` or `scripts/`, add a corresponding
  `test_<name>.mjs`.

## Pine scripts

- Pine indicators live in `pine_scripts/` or at the repo root (`*.pine`).
- When editing a Pine script, compile with `pine_smart_compile` first, then
  verify with `pine_get_errors`.
- Keep Pine scripts focused: one strategy or indicator per file.

## Dangerous areas — read-only unless explicitly asked

| Area | Risk |
|---|---|
| `journal.db` | Live trading journal — write only with migration scripts |
| `src/connection.js` | CDP port and connection config — changing breaks all tools |
| `telegram-bot.js` | Running bot process — edit only with full restart plan |
| `screenshots/` | Generated artifacts — can be cleaned up freely |
| `*.bak-*` files | Historical backups — do not delete or modify |

## Code discovery

Prefer `rg` text search for literals, errors, and configuration in this repo.
The source tree is flat enough that codebase graph tools are rarely needed.

## New modules

When adding a new `.mjs` module:
1. Keep it at the repo root if it is a standalone script or entrypoint.
2. Place shared logic under `src/`.
3. Add a corresponding `test_<name>.mjs`.
