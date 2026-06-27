#!/usr/bin/env node

/**
 * tradingview-mcp — single package entrypoint.
 *
 * With no subcommand (the default used by `npx @specialagentk/tradingview-mcp` and by MCP
 * clients) this starts the MCP server over stdio. `tradingview-mcp cli <args>` runs the
 * pipe-friendly CLI instead.
 *
 * Why one bin: a scoped package that declares multiple bins forces `npx <package>` to guess a
 * default, and some runners (e.g. Volta) guess wrong and fail to launch. A single bin makes
 * `npx <package>` unambiguous on every runner.
 * See openspec/changes/fix-npm-install-resolution.
 */

if (process.argv[2] === 'cli') {
  // Drop the 'cli' token so the CLI router sees argv exactly as if it were invoked directly.
  process.argv.splice(2, 1);
  await import('./cli/index.js');
} else {
  await import('./server.js');
}
