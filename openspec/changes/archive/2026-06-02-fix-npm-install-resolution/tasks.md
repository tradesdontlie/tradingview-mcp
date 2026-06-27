## 1. Single entrypoint
- [x] 1.1 Add first-arg dispatch: `tradingview-mcp` with no args (or stdio) runs the MCP server;
      `tradingview-mcp cli <args>` delegates to the existing CLI router. (`src/bin.js`)
- [x] 1.2 Update `package.json` `bin` to a single `tradingview-mcp` entry; remove `tradingview-mcp-cli`.
- [x] 1.3 Ensure the entrypoint keeps its `#!/usr/bin/env node` shebang and stays executable.

## 2. Docs
- [x] 2.1 README: keep the npx one-liner, add the `npm i -g` + `tradingview-mcp` fallback, document the
      Windows/Volta caveat and the `cmd /c tradingview-mcp` form for `claude mcp add`.
- [x] 2.2 README + CLAUDE.md: replace `tv <cmd>` / `node src/cli/index.js <cmd>` usages with the single
      entrypoint (`tradingview-mcp cli` / `node src/bin.js cli`); add a migration note for the removed
      `tradingview-mcp-cli` bin.

## 3. Release smoke test
- [x] 3.1 Add a test that runs `npm pack`, installs the tarball into a temp prefix, launches the
      `tradingview-mcp` bin with EOF stdin, and asserts the startup banner appears and the process exits
      cleanly (catches unresolvable-bin and missing-`files` regressions). (`tests/packaging.test.js`)
- [x] 3.2 Wire the smoke test into `prepublishOnly` (`npm run test:unit && npm run test:smoke`).

## 4. Verify
- [x] 4.1 Confirm `npx -y @specialagentk/tradingview-mcp` launches the server. Verified against the
      published 3.0.0 on Volta-managed Node on Windows — the exact prior failure case now launches
      cleanly; macOS/Linux rely on the same single-bin resolution.
- [x] 4.2 `openspec validate fix-npm-install-resolution --strict`.
