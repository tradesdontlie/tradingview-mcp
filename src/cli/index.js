#!/usr/bin/env node

/**
 * tv — CLI for TradingView Desktop via Chrome DevTools Protocol.
 * Outputs JSON to stdout. Errors to stderr.
 * Exit codes: 0 success, 1 error, 2 connection failure.
 *
 * All 70 MCP tools are accessible via CLI commands.
 * Pipe-friendly: every command outputs JSON for use with jq.
 */

// Register all commands
import './commands/health.js';
import './commands/chart.js';
import './commands/data.js';
import './commands/pine.js';
import './commands/capture.js';
import './commands/replay.js';
import './commands/drawing.js';
import './commands/alerts.js';
import './commands/watchlist.js';
import './commands/layout.js';
import './commands/indicator.js';
import './commands/ui.js';
import './commands/pane.js';
import './commands/tab.js';
import './commands/stream.js';

// Run
import { run } from './router.js';
import { disconnect } from '../connection.js';

export async function main(argv = process.argv, deps = {}) {
  const runCommand = deps.run ?? run;
  const closeConnection = deps.disconnect ?? disconnect;

  let exitCode = 1;

  try {
    exitCode = await runCommand(argv);
    return exitCode;
  } finally {
    await closeConnection();
  }
}

process.exitCode = await main(process.argv);
