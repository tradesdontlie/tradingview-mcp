#!/usr/bin/env node
/**
 * cli/scan.js — Manual signal scan entry point (Phase 2A skeleton)
 *
 * TODO Phase 3: integrate MCP data tools:
 *   chart_get_state → symbol + timeframe
 *   data_get_ohlcv(summary:true) on 4H/1H/15m/5m → bias + OHLCV
 *   data_get_pine_labels/lines/boxes → session levels, FVG zones
 *   quote_get → current price
 *   Pass data to runEngines() → buildSignal() → riskManager.validate()
 *
 * Current behavior:
 *   Reads rules.json, validates it, then prints a placeholder WAIT signal to stdout.
 *   No network calls. No TradingView connection. No broker API. No trade execution.
 *
 * Usage: node cli/scan.js [--symbol MNQ1!|MES1!] [--help]
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function printHelp() {
  console.log('Usage: node cli/scan.js [--symbol MNQ1!|MES1!] [--help]');
  console.log('');
  console.log('Reads rules.json and prints a WAIT signal to stdout.');
  console.log('Phase 3 will connect this to live TradingView MCP data.');
  console.log('');
  console.log('Options:');
  console.log('  --symbol  Target symbol. Default: MNQ1!');
  console.log('  --help    Show this message and exit.');
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const symbolIdx = args.indexOf('--symbol');
  const symbol = symbolIdx !== -1 && args[symbolIdx + 1]
    ? args[symbolIdx + 1]
    : 'MNQ1!';

  const valid = ['MNQ1!', 'MES1!'];
  if (!valid.includes(symbol)) {
    console.error(`Error: --symbol must be one of ${valid.join(', ')}`);
    process.exit(1);
  }

  // Load and validate rules.json
  const rulesPath = join(__dirname, '..', 'rules.json');
  let rules;
  try {
    rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
  } catch (err) {
    console.error(`Error: could not read rules.json at ${rulesPath}: ${err.message}`);
    process.exit(1);
  }

  if (rules?.risk?.live_trading_enabled === true) {
    console.error('Error: live_trading_enabled is true in rules.json — blocked in v0.1');
    process.exit(1);
  }

  const ts = new Date().toISOString();

  // Placeholder signal — all fields present, schema-compliant WAIT
  const signal = {
    id:        `${ts}-${symbol}`,
    timestamp: ts,
    date:      ts.slice(0, 10),
    time:      ts.slice(11, 16),
    symbol,
    decision:  'WAIT',
    bias:      { '4H': 'unknown', '1H': 'unknown', '15m': 'unknown', '5m': 'unknown' },
    setup:     'MTF Session Liquidity Trap',
    entry:     null,
    stop:      null,
    tp1:       null,
    tp2:       null,
    r:         null,
    confidence: 'Reject',
    reasons:   ['Phase 2A skeleton — no live MCP data connected yet (see TODO in cli/scan.js)'],
    invalidation: [],
    what_would_change: 'Connect MCP data tools in Phase 3',
    status:    'pending',
    outcome_r: null,
    _meta: {
      strategy:             rules.strategy?.name,
      symbols:              rules.symbols?.primary,
      live_trading_enabled: rules.risk?.live_trading_enabled,
      min_reward_risk:      rules.risk?.min_reward_risk,
      max_trades_per_day:   rules.risk?.max_trades_per_day,
    },
  };

  console.log(JSON.stringify(signal, null, 2));
}

main();
