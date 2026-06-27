# Change: Make the published npm package launch reliably via a single entrypoint

## Why
The README's recommended install — `npx -y @specialagentk/tradingview-mcp` and the
`claude mcp add tradingview -- npx -y @specialagentk/tradingview-mcp` one-liner — does not work on
every Node toolchain. `package.json` declares **two** bins (`tradingview-mcp` and
`tradingview-mcp-cli`), and some runners do not auto-select the package-name-matching bin for a
**scoped** package with multiple bins. Observed under Volta-managed Node on Windows: `npx` tries to
exec a bare `tradingview-mcp` command that is not on PATH and aborts with
`'tradingview-mcp' is not recognized as an internal or external command`.

The package code is correct — `node src/server.js` (and a global `npm i -g` + the `tradingview-mcp`
command) start the server fine. Only the `npx`-from-registry entrypoint resolution is broken, so the
*documented* install path fails for those users with no actionable error.

## What Changes
- **BREAKING**: collapse the two bins into a single `tradingview-mcp` entrypoint so `npx <package>`
  is unambiguous on every runner. With no subcommand it runs the MCP server over stdio;
  `tradingview-mcp cli <args>` runs the existing CLI. Remove the separate `tradingview-mcp-cli` bin.
- Update README and CLAUDE.md install/usage instructions to a runner-robust path: document the npx
  one-liner (now single-bin, so it resolves everywhere) **and** a global-install fallback
  (`npm i -g @specialagentk/tradingview-mcp`) launched via the `tradingview-mcp` command, including the
  Windows/Volta caveat and the `cmd /c tradingview-mcp` form for `claude mcp add`.
- Add a pre-publish smoke test that packs the tarball, installs it into a throwaway prefix, and asserts
  the `tradingview-mcp` bin starts the server (emits the startup banner and exits cleanly on stdin EOF),
  failing the release if the entrypoint is unresolvable or the tarball is missing imported files.

## Impact
- Affected specs: `npm-distribution` (new capability)
- Affected code: `package.json` (`bin`, `prepublishOnly`), `src/cli/index.js` + `src/server.js`
  (single-entry dispatch), `README.md`, `CLAUDE.md` (CLI invocation `tv ...` → `tradingview-mcp cli ...`),
  `tests/` (new packaging smoke test)
- Migration: users of the `tradingview-mcp-cli` bin (or a linked `tv`) switch to `tradingview-mcp cli`.

## Tracking
- Issue: SAK1337/tradingview-mcp#2
