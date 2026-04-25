# TradingView MCP — Agent Instructions

Read this file before making changes, then read `CLAUDE.md` for tool-specific behavior and context management rules.

## What This Repo Is

`tradingview-mcp` is an MCP bridge for controlling a local TradingView Desktop chart through Chrome DevTools Protocol on port 9222. Many tools read chart state, but some can change symbols, edit Pine scripts, create alerts, enter replay mode, or launch/kill the desktop app.

## Safety Rules

- Do not place trades, create real alerts, save Pine scripts, or alter a user's chart layout unless the task explicitly asks for it.
- Do not launch or kill TradingView during automated tests. Keep CI and pre-commit checks offline.
- Do not commit screenshots, local chart state, credentials, cookies, tokens, or TradingView session data.
- Treat `tests/e2e.test.js` and replay/UI tests as manual checks that require an intentionally prepared local TradingView session.
- Prefer adding deterministic unit tests around parsing, validation, CLI routing, and injection-safety behavior.

## Workflow

- Branch from `origin/main`.
- Keep changes small and reversible.
- Run `npm ci` after dependency changes.
- For routine code changes, run:
  ```bash
  npm run check:syntax
  npm run test:offline
  ```
- Run CDP-dependent tests only when a local TradingView Desktop session is intentionally running with `--remote-debugging-port=9222`.

## Pull Requests

Include:

- Summary of behavior changed.
- Test plan, separating offline checks from any manual CDP checks.
- Blast radius, especially for chart mutation, Pine, alert, replay, or launch behavior.
- Rollback notes.
