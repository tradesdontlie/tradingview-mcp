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

## MCP Trust Architecture

This project is a local bridge, not a security boundary. The trust model is intentionally narrow: the user controls the machine, the MCP server executes locally, and TradingView Desktop is the only runtime target on `localhost:9222`.

| Actor | Capability | Exposure | Mitigation | Residual limitation |
|---|---|---|---|---|
| Local user / operator | Can launch the server, pass CLI/MCP inputs, and edit the config | Can cause the bridge to read local chart state or issue UI actions in TradingView | Keep the bridge local-only; require explicit user setup; keep CDP on localhost | Any local user with machine access can still operate the bridge |
| Prompted LLM / agent | Can supply arbitrary tool arguments and text payloads | Could attempt injection through evaluated strings or malformed inputs | Escape user strings with `safeString()`, validate numeric inputs, prefer narrow tool scopes | Model output can still be wrong, incomplete, or overly confident |
| TradingView Desktop UI | Renders chart state, indicators, dialogs, and account/session content | MCP tools can observe and interact with whatever the UI exposes | Use explicit selectors, limit reads to visible UI, and verify results before acting | UI refactors can break selectors or change observed state without warning |
| Network-local attacker | Can only reach the bridge if the operator exposes CDP beyond localhost | Could observe or interfere with CDP traffic if the port is misconfigured | Bind CDP to localhost and do not expose port 9222 to the network | If the port is exposed, CDP is not protected by this project |

## Best Practices for Users

- Only run TradingView with `--remote-debugging-port=9222` on localhost
- Do not expose port 9222 to your network or the internet
- Do not pipe `tv stream` output to external services without reviewing the data
- Keep your TradingView Desktop and Node.js installations up to date

