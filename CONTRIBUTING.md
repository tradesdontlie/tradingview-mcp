# Contributing

Thanks for your interest in contributing to tradingview-mcp.

## Scope

This tool is a **local bridge** between Claude Code and the TradingView Desktop app running on your machine. All contributions must stay within this scope.

### What's in scope

- Improving reliability of existing tools (better selectors, error handling, timeouts)
- Adding CLI commands that mirror existing MCP tool capabilities
- Bug fixes and test coverage
- Documentation improvements
- Pine Script development workflow enhancements
- UI automation for the locally running Desktop app

### What's out of scope

Contributions **must not** add features that:

- **Connect directly to TradingView's servers** — all data access must go through the locally running Desktop app via CDP
- **Bypass authentication or subscription restrictions** — this tool requires a valid TradingView account and subscription
- **Scrape, cache, or redistribute market data** — no data storage, no databases, no export-to-CSV of price data
- **Enable automated trading or order execution** — this is a chart reading/development tool, not a trading bot framework
- **Reverse-engineer or redistribute TradingView's proprietary code** — no bundled TradingView source, no charting library code
- **Access other users' data** — private scripts, watchlists, or account information of others

Also out of scope — please keep these in your own fork or repo:

- **Personal trading configurations** — `rules.json` is gitignored for this reason; watchlist/scanner configs, layouts, and personal `.mcp.json` files belong on your machine, not in the repo
- **Pine Script strategies/indicators** — unless a minimal fixture needed by a test
- **Trading bots, signal dashboards, or strategy layers built on top of the bridge** — the bridge stays unopinionated about how you trade; open a Discussion if you want yours linked from the README

If you're unsure whether a feature fits, open an issue to discuss before submitting a PR.

## Development

```bash
npm install
npm run lint      # eslint — the no-undef guard catches unfinished refactors
npm run test:unit # offline unit tests (no TradingView needed)
npm run test:e2e  # requires TradingView running with CDP on port 9222
tv status         # verify CDP connection (TradingView must be running)
```

Core functions take an optional `_deps` parameter resolved via `_resolve(_deps)` so they're unit-testable — see `src/core/replay.js` or `src/core/health.js` for the pattern.

## Pull Requests

- Keep changes focused — one feature or fix per PR; bundled PRs (fix + config + docs) usually get closed in favor of the smallest equivalent
- **Search open PRs before writing code** — popular bugs here have attracted 20+ duplicate fixes; if an open PR already covers it, comment there instead
- Add tests for new functionality where possible
- Ensure `npm run lint` and `npm run test:unit` pass
- Test against a live TradingView Desktop instance before submitting, and describe in the PR body exactly what you ran and observed — PRs with real verification notes merge much faster

## Bug Reports

Include: OS, TradingView Desktop version and install type (installer vs Microsoft Store/MSIX), the exact tool call with its full JSON result, and `tv_health_check` output. One-line issues without repro details will be closed.
