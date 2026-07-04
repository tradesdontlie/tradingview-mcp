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
import './commands/binance.js';
import './commands/binance_live.js';
import './commands/risk.js';
import './commands/sfp.js';
import './commands/divergence.js';
import './commands/levels.js';
import './commands/fibonacci.js';
import './commands/market_structure.js';
import './commands/pinbar.js';
import './commands/chart_patterns.js';
import './commands/laddering.js';
import './commands/confluence.js';
import './commands/volume_profile.js';

// Run
import { run } from './router.js';
await run(process.argv);
