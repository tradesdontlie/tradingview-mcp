## Context
`@specialagentk/tradingview-mcp@2.0.0` ships two bins:

```json
"bin": {
  "tradingview-mcp": "src/server.js",
  "tradingview-mcp-cli": "src/cli/index.js"
}
```

`npx <pkg>` must choose a default bin. The documented convention is "the bin whose name equals the
package's unscoped name" (`tradingview-mcp`), which exists — so on stock npm this resolves. But the
behavior is **not guaranteed across runners**: under Volta-managed Node on Windows, `npx -y
@specialagentk/tradingview-mcp` failed to auto-select and tried to run a bare `tradingview-mcp` PATH
command (`'tradingview-mcp' is not recognized`). The package itself is intact: a clean
`npm i -g` followed by the `tradingview-mcp` shim, and `node src/server.js` directly, both start the
server and print the banner.

## Goals / Non-Goals
- Goals: the documented install command works on macOS, Linux, and Windows, including Volta/nvm-managed
  Node; failures are actionable; releases can't ship a tarball whose entrypoint won't launch.
- Non-Goals: changing the MCP tool surface or CLI command set; fixing Volta itself; supporting runners
  that cannot execute any package bin.

## Decisions
- **Decision: single `tradingview-mcp` bin; CLI becomes a subcommand.** Removing the second bin removes
  the auto-selection ambiguity at the source — `npx <pkg>` has exactly one bin to run on every runner.
  No args → MCP stdio server (unchanged behavior); `tradingview-mcp cli <args>` → the existing router.
- **Decision: keep a documented global-install fallback.** Even with a single bin, on-the-fly `npx`
  can be blocked by registry/proxy/offline constraints. `npm i -g` + `tradingview-mcp` (and
  `cmd /c tradingview-mcp` for `claude mcp add` on Windows) is the durable path.
- **Decision: gate releases on a real tarball smoke test.** `npm pack` → install the tarball into a temp
  prefix → run the bin with EOF stdin → assert banner + clean exit. This catches both unresolvable-bin
  and missing-`files` regressions before publish, not after.

## Alternatives considered
- **Keep both bins, rely on name-matching.** Lowest effort, but leaves the documented one-liner broken
  on the very toolchain (Volta) that surfaced the bug. Rejected — doesn't fix the user-visible failure.
- **Keep both bins, document `npx -p <pkg> tradingview-mcp`.** The `-p` form is explicit, but verbose,
  easy to get wrong, and still failed in some shells during diagnosis. Rejected as the primary fix;
  acceptable only as a footnote.
- **Drop the CLI from the published package.** Removes ambiguity but loses the pipe-friendly `tv`
  surface the repo documents. Rejected.

## Risks / Trade-offs
- BREAKING for anyone invoking `tradingview-mcp-cli` (or a linked `tv`). Mitigation: call it out in the
  proposal and README migration note; the subcommand mapping is mechanical (`tv X` → `tradingview-mcp
  cli X`). The `tv` dev alias / `npm run tv` script can remain for local use.
- Single-entry dispatch adds a thin arg check at the top of the entrypoint. Mitigation: keep it to a
  first-arg switch (`cli` → CLI router, else → server); no new dependency.

## Migration Plan
1. Add the dispatch shim and point the single `tradingview-mcp` bin at it.
2. Update README/CLAUDE.md commands and add the migration note.
3. Add the smoke test and wire it into `prepublishOnly`.
4. Publish a new major; verify `npx -y @specialagentk/tradingview-mcp` on macOS, Linux, and
   Volta-Windows before announcing.

## Open Questions
- Keep `tradingview-mcp-cli` as a temporary deprecated alias for one minor, or remove immediately?
- Should the dispatch live in `src/server.js`, `src/cli/index.js`, or a new `src/bin.js` wrapper?
