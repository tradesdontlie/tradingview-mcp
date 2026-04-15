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

If you're unsure whether a feature fits, open an issue to discuss before submitting a PR.

## Development

```bash
npm install
npm run test:offline   # 205 offline tests (no TradingView needed)
npm test               # live tests (TradingView must be running on port 9222)
tv status              # verify CDP connection
```

## Pull Requests

- Keep changes focused — one feature or fix per PR
- Add tests for new functionality where possible. Use dependency-injected mocks (see `tests/screener_*.test.js` or `tests/replay.test.js`) so the test runs offline.
- Ensure `npm run test:offline` passes (205/205) before opening the PR
- Test against a live TradingView Desktop instance before submitting
