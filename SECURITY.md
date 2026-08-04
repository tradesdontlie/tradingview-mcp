# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Email:** Open a private security advisory via [GitHub Security Advisories](https://github.com/tradesdontlie/tradingview-mcp/security/advisories/new).

**Do not** open a public issue for security vulnerabilities.

## Scope

This project connects to a locally running TradingView Desktop instance via Chrome DevTools Protocol on `localhost:9222`. Security concerns in scope include:

- Code injection via crafted tool inputs
- Unintended data exposure through tool outputs
- Credential or session token leakage
- Vulnerabilities in the MCP server or CLI that could be exploited locally

## Out of Scope

- TradingView's own security (report to TradingView directly)
- Chrome DevTools Protocol security (report to Google/Chromium)
- Claude Code or MCP SDK security (report to Anthropic)

## Best Practices for Users

- Only run TradingView with `--remote-debugging-port=9222` on localhost
- Do not expose port 9222 to your network or the internet
- Do not pipe `tv stream` output to external services without reviewing the data
- Keep your TradingView Desktop and Node.js installations up to date

## Capability Boundaries

`ui_evaluate` can execute arbitrary JavaScript with the privileges of the active TradingView page. It is denied before any CDP call unless the MCP server or CLI is deliberately started with:

```text
TRADINGVIEW_MCP_ALLOW_ARBITRARY_PAGE_JS=I_UNDERSTAND_THIS_EXECUTES_ARBITRARY_JAVASCRIPT
```

`replay_trade` changes only TradingView's internal Bar Replay simulated position. It is independently denied before any CDP call unless the server or CLI is started with:

```text
TRADINGVIEW_MCP_ALLOW_REPLAY_TRADES=I_UNDERSTAND_THIS_CHANGES_SIMULATED_REPLAY_POSITIONS
```

`tv_update` fast-forwards the checkout to `origin/main` and runs `npm ci`, executing whatever remote code and dependencies arrive from the repository. It is denied before any git, network, or npm side effect unless the server or CLI is started with:

```text
TRADINGVIEW_MCP_ALLOW_SELF_UPDATE=I_UNDERSTAND_THIS_PULLS_AND_RUNS_REMOTE_CODE
```

Replay navigation (`replay_start`, `replay_step`, `replay_autoplay`, `replay_status`, and `replay_stop`) does not require this capability.

`alert_delete` with `delete_all` performs an irreversible bulk deletion of every price alert on the account. It is not env-gated (creating and deleting individual alerts is routine), but a bare `delete_all` is refused: the caller must pass `confirm: "DELETE_ALL_ALERTS"` so an assistant or injected prompt cannot wipe every alert from a single casual flag.

Do not enable dangerous capabilities for routine use. Other tools still control the TradingView UI, modify chart or cloud state, create alerts, launch a local process, and self-update this checkout. Treat MCP clients and prompts as trusted code, and review every state-changing request.

This repository has no broker-order integration. The Replay trade gate does not inspect account type, broker connectivity, or every TradingView UI state, so it cannot prove demo/paper isolation. Keep real brokers disconnected and do not use generic UI automation around order-entry surfaces.
