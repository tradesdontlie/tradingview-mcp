## ADDED Requirements

### Requirement: Single unambiguous package entrypoint
The published package SHALL declare exactly one bin (`tradingview-mcp`) so that `npx <package>` resolves
to the MCP server on every Node runner, independent of how the runner selects a default bin for scoped
packages. The CLI SHALL remain available as a subcommand of that single entrypoint.

#### Scenario: npx launches the server with no subcommand
- **WHEN** `npx -y @specialagentk/tradingview-mcp` is run with no additional arguments
- **THEN** the MCP server starts over stdio and emits its startup banner on stderr

#### Scenario: CLI reached through the single bin
- **WHEN** `tradingview-mcp cli status` is run
- **THEN** the CLI router executes the `status` command and prints its JSON result

#### Scenario: Multi-bin ambiguity is removed
- **WHEN** the published `package.json` `bin` field is inspected
- **THEN** it contains a single `tradingview-mcp` key and no separate `tradingview-mcp-cli` key

### Requirement: Runner-robust install instructions
The documentation SHALL describe an install path that works on macOS, Linux, and Windows — including
Volta- and nvm-managed Node — and SHALL provide a global-install fallback for environments where
on-the-fly `npx` execution is blocked.

#### Scenario: Documented npx one-liner works cross-platform
- **WHEN** a user follows the README `claude mcp add` / `npx` install instruction on a supported platform
- **THEN** the instruction launches the server without a manual bin-resolution workaround

#### Scenario: Global-install fallback for Windows/Volta
- **WHEN** a user is on Volta-managed Node on Windows where on-the-fly npx bin resolution is unreliable
- **THEN** the docs direct them to `npm i -g @specialagentk/tradingview-mcp` and to register the server
  with `cmd /c tradingview-mcp`

### Requirement: Release gated on a launchable tarball
The release process SHALL verify, before publishing, that the packed tarball installs and that its
`tradingview-mcp` bin starts the server. A tarball whose entrypoint cannot launch — because the bin is
unresolvable or an imported file is excluded by the `files` whitelist — SHALL fail the pre-publish check.

#### Scenario: Broken entrypoint blocks publish
- **WHEN** the packed tarball's `tradingview-mcp` bin fails to start the server (unresolvable bin or a
  missing imported module)
- **THEN** the pre-publish smoke test fails and the package is not published

#### Scenario: Healthy entrypoint passes
- **WHEN** the packed tarball is installed into a clean prefix and its bin is run with EOF on stdin
- **THEN** the server prints its startup banner and exits cleanly, and the check passes
