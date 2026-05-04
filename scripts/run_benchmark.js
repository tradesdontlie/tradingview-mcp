#!/usr/bin/env node
/**
 * CLI benchmark runner.
 *
 * Usage:
 *   node scripts/run_benchmark.js [options]
 *
 * Options:
 *   --symbol  <sym>     TradingView symbol (default: current chart symbol)
 *   --tf      <tf>      Timeframe e.g. 15, 60, D (default: current)
 *   --fee     <pct>     Fee per side as decimal, e.g. 0.001 (default: 0.001)
 *   --slip    <pct>     Slippage per side (default: 0.001)
 *   --save              Save result to SQLite (default: true)
 *   --print             Print full result JSON (default: false)
 *
 * Requires the TradingView MCP bridge to be running (port 9222).
 *
 * What it does:
 *   1. Reads trades, equity, bars from TradingView via core modules
 *   2. Reads the current Pine source (optional — for algoHash)
 *   3. Runs runBenchmark() → stores in data/bench.db
 *   4. Prints a summary table
 */

import { getOhlcv } from '../src/core/data.js';
import { getSource } from '../src/core/pine.js';
import { runBenchmark, hashSource } from '../scoring/index.js';
import { saveResult } from '../scoring/store.js';
import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dir, '..', 'data');

// Parse CLI args
const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const has = flag => args.includes(flag);

const symbol    = get('--symbol', null);
const timeframe = get('--tf', null);
const feePct    = parseFloat(get('--fee', '0.001'));
const slipPct   = parseFloat(get('--slip', '0.001'));
const shouldSave = !has('--no-save');
const shouldPrint = has('--print');

async function main() {
  console.log('[run_benchmark] fetching data from TradingView…');

  // Ensure data dir exists
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  // 1. Fetch data via existing MCP core modules
  const [ohlcvResult, tradesResult, equityResult, sourceResult] = await Promise.allSettled([
    getOhlcv({ count: 500 }),
    getTrades(),
    getEquity(),
    getSource().catch(() => null),
  ]);

  const bars   = ohlcvResult.status === 'fulfilled'  ? (ohlcvResult.value?.bars ?? [])   : [];
  const trades = tradesResult.status === 'fulfilled' ? (tradesResult.value?.trades ?? []) : [];
  const equity = equityResult.status === 'fulfilled' ? (equityResult.value?.data ?? [])   : [];
  const pine   = sourceResult.status === 'fulfilled' ? sourceResult.value : null;

  if (!trades.length) {
    console.error('[run_benchmark] ERROR: no trades found. Make sure a strategy is loaded and has run.');
    process.exit(1);
  }

  console.log(`[run_benchmark] ${trades.length} trades, ${bars.length} bars, ${equity.length} equity points`);

  // 2. Run scoring
  const algoHash = pine ? hashSource(pine) : `manual_${Date.now()}`;

  const result = runBenchmark(trades, bars, equity, {
    symbol: symbol || 'UNKNOWN',
    timeframe: timeframe || 'UNKNOWN',
    algoHash,
    pineSource: pine ?? undefined,
    costModel: { fee_pct: feePct, slippage_pct: slipPct, fill_model: 'worst' },
  });

  // 3. Save
  if (shouldSave) {
    const id = saveResult(result);
    console.log(`[run_benchmark] saved → ${id}`);
    console.log(`[run_benchmark] view at: http://localhost:4321/dashboard/${id}`);
  }

  // 4. Print summary
  printSummary(result);

  if (shouldPrint) {
    console.log('\nFull result:');
    console.log(JSON.stringify(result, null, 2));
  }
}

function printSummary(r) {
  const bar = (score) => {
    const filled = Math.round(score / 5);
    return '█'.repeat(filled) + '░'.repeat(20 - filled) + ` ${score}`;
  };

  console.log('\n╔══════════════════════════════════════╗');
  console.log(`║  BENCHMARK: ${r.symbol} ${r.timeframe}`.padEnd(40) + '║');
  console.log(`║  ${r.dateRange.start} → ${r.dateRange.end}`.padEnd(40) + '║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  COMPOSITE  ${bar(r.compositeScore)}`.padEnd(40) + '║');
  console.log('╠══════════════════════════════════════╣');

  for (const [dim, s] of Object.entries(r.scores)) {
    const label = dim.padEnd(10);
    console.log(`║  ${label} ${bar(s.score)}`.padEnd(40) + '║');
  }

  console.log('╠══════════════════════════════════════╣');
  const c = r.scores.returns.components;
  if (c.sharpe != null) {
    console.log(`║  Sharpe: ${c.sharpe.toFixed(2)}  Sortino: ${c.sortino.toFixed(2)}`.padEnd(40) + '║');
    console.log(`║  CAGR: ${(c.cagr * 100).toFixed(1)}%  MaxDD: ${(c.maxDrawdown * 100).toFixed(1)}%`.padEnd(40) + '║');
    console.log(`║  WinRate: ${(c.winRate * 100).toFixed(0)}%  Trades: ${c.tradeCount}`.padEnd(40) + '║');
  }
  console.log('╚══════════════════════════════════════╝');
}

// These would normally import from src/core — dynamic import to handle missing CDP gracefully
async function getTrades() {
  const { getTrades: fn } = await import('../src/core/data.js');
  return fn({ max_trades: 500 });
}

async function getEquity() {
  const { getEquity: fn } = await import('../src/core/data.js');
  return fn();
}

main().catch(err => {
  console.error('[run_benchmark] fatal:', err.message);
  process.exit(1);
});
