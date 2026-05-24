#!/usr/bin/env node
/**
 * watch/watchCli.js — Manual-only watch mode for futures-ai-chart-copilot.
 *
 * Polls MNQ1! and MES1! on a configurable interval, runs the engine pipeline,
 * and emits a loud alert to stdout/stderr when an A+ setup is detected.
 * Duplicate alerts for the same setup are suppressed via a stable signal key.
 *
 * Usage: node watch/watchCli.js [--symbols MNQ1!,MES1!] [--interval 20]
 *
 * No broker execution. No order placement. Manual use only.
 * live_trading_enabled must remain false.
 */

import { readFileSync }                           from 'node:fs';
import { fileURLToPath }                          from 'node:url';
import { join, dirname, resolve }                 from 'node:path';
import { McpDataProvider }                        from '../data/mcpDataProvider.js';
import { runEngines, buildSignal }                from '../strategies/mtfSessionLiquidityTrap.js';
import { checkStaleness, validate, rejectToWait } from '../risk/riskManager.js';
import { createSymbolState, transition }          from './watchStateMachine.js';
import { emitAlert, emitSummary }                 from './alertSink.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

let stopping  = false;
let pollTimer = null;

function stop(sig) {
  stopping = true;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  process.stderr.write(JSON.stringify({ type: 'shutdown', signal: sig ?? 'manual' }) + '\n');
  process.exitCode = 0;
}

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args        = argv.slice(2);
  const symbolIdx   = args.indexOf('--symbols');
  const intervalIdx = args.indexOf('--interval');
  const symbols     = (symbolIdx  !== -1 && args[symbolIdx  + 1])
    ? args[symbolIdx  + 1].split(',').map(s => s.trim()).filter(Boolean)
    : ['MNQ1!', 'MES1!'];
  const intervalSec = (intervalIdx !== -1 && args[intervalIdx + 1])
    ? parseInt(args[intervalIdx + 1], 10)
    : 20;
  return { symbols, interval: intervalSec * 1000 };
}

// ─── MCP fetch + signal build ─────────────────────────────────────────────────

/**
 * Connects to TradingView via MCP, collects multi-TF OHLCV, and builds a raw
 * signal. Does NOT apply staleness or risk validation — that is done in scanOnce.
 *
 * @param {string} symbol
 * @param {object} rules
 * @returns {Promise<{ signal: object|null, currentPrice: number|null }>}
 */
async function fetchAndBuild(symbol, rules) {
  const provider = new McpDataProvider();
  try {
    await provider.connect();
    const healthy = await provider.healthCheck();
    if (!healthy) {
      await provider.disconnect();
      return { signal: null, currentPrice: null };
    }

    let ohlcvByTimeframe = null;
    let savedState       = null;
    let quote            = null;

    try {
      const paramSupported = await provider.probeTimeframeParam();
      if (paramSupported) {
        ohlcvByTimeframe = await provider.fetchAllTfsWithParam();
      } else {
        savedState = await provider.getChartState();
        if (savedState?.symbol && savedState.symbol !== symbol) {
          await provider.setSymbol(symbol);
        }
        ohlcvByTimeframe = await provider.fetchAllTfsWithChartChange();
      }
      quote = await provider.getQuote();
    } finally {
      if (savedState) await provider.restoreState(savedState);
      await provider.disconnect();
    }

    if (!ohlcvByTimeframe) {
      return { signal: null, currentPrice: null };
    }

    const ts            = new Date().toISOString();
    const engineOutputs = runEngines(ohlcvByTimeframe, undefined, rules, Date.now());
    const signal        = buildSignal({ symbol, engineOutputs, rules, timestamp: ts });
    const currentPrice  = quote?.last ?? quote?.close ?? quote?.price ?? null;

    return { signal, currentPrice };
  } catch (err) {
    try { await provider.disconnect(); } catch { /* ignore */ }
    throw err;
  }
}

// ─── Core scan tick ───────────────────────────────────────────────────────────

/**
 * Performs a single scan tick for one symbol.
 * Exported for unit testing (overrideFetch bypasses MCP; sinks suppress output).
 *
 * @param {string}   symbol
 * @param {object}   symbolState          - current per-symbol watch state
 * @param {object}   rules                - parsed rules.json
 * @param {Function|null} [overrideFetch] - async (symbol, rules) → { signal, currentPrice }
 * @param {{ onAlert?: Function, onSummary?: Function }} [sinks]
 * @returns {Promise<{ newSymbolState: object, alerted: boolean }>}
 */
export async function scanOnce(symbol, symbolState, rules, overrideFetch = null, sinks = {}) {
  const onAlert   = sinks.onAlert   ?? emitAlert;
  const onSummary = sinks.onSummary ?? emitSummary;

  let signal       = null;
  let currentPrice = null;

  try {
    if (overrideFetch) {
      ({ signal, currentPrice } = await overrideFetch(symbol, rules));
    } else {
      ({ signal, currentPrice } = await fetchAndBuild(symbol, rules));
    }
  } catch (err) {
    process.stderr.write(`[watch] ${symbol} fetch error: ${err.message}\n`);
    const ts = new Date().toISOString();
    onSummary(symbol, symbolState.state, null, ts);
    return { newSymbolState: symbolState, alerted: false };
  }

  // Apply staleness / risk validation (mirrors cli/scan.js)
  let finalSignal   = signal;
  let stalenessHint = null;

  if (signal && signal.decision !== 'WAIT') {
    const staleReason = checkStaleness(signal, currentPrice);
    if (staleReason) {
      finalSignal   = rejectToWait(signal, staleReason, 'expired');
      stalenessHint = staleReason;
    } else {
      const { approved, rejection_reason } = validate(signal, rules);
      if (!approved) {
        finalSignal = rejectToWait(signal, rejection_reason ?? 'risk_validation_failed', 'pending');
      }
    }
  }

  const { newState, alert } = transition(symbolState, finalSignal, { staleness: stalenessHint });
  const ts = new Date().toISOString();

  if (alert) {
    onAlert(finalSignal, currentPrice, ts);
  } else {
    onSummary(symbol, newState.state, finalSignal?.decision !== 'WAIT' ? finalSignal : null, ts);
  }

  return { newSymbolState: newState, alerted: alert };
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  process.once('SIGINT',  () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  const { symbols, interval } = parseArgs(process.argv);

  const rulesPath = join(__dirname, '..', 'rules.json');
  let rules;
  try {
    rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`[watch] Could not read rules.json: ${err.message}\n`);
    process.exit(1);
  }

  if (rules?.risk?.live_trading_enabled === true) {
    process.stderr.write('[watch] Error: live_trading_enabled is true — blocked in v0.1\n');
    process.exit(1);
  }

  const validSymbols = ['MNQ1!', 'MES1!'];
  for (const sym of symbols) {
    if (!validSymbols.includes(sym)) {
      process.stderr.write(`[watch] Error: unsupported symbol "${sym}" — must be one of ${validSymbols.join(', ')}\n`);
      process.exit(1);
    }
  }

  const symbolStates = Object.fromEntries(symbols.map(s => [s, createSymbolState(s)]));

  process.stderr.write(`[watch] Starting: symbols=${symbols.join(',')} interval=${interval / 1000}s\n`);
  process.stderr.write('[watch] No broker execution. Manual use only.\n');

  while (!stopping) {
    for (const symbol of symbols) {
      if (stopping) break;
      const { newSymbolState } = await scanOnce(symbol, symbolStates[symbol], rules);
      symbolStates[symbol] = newSymbolState;
    }
    if (stopping) break;
    await new Promise(r => { pollTimer = setTimeout(r, interval); });
    pollTimer = null;
  }
}

// ─── ESM entry guard ─────────────────────────────────────────────────────────

const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase();

if (isMain) {
  main().catch((err) => {
    console.error(JSON.stringify({
      type:    'fatal',
      message: err?.message || String(err),
    }));
    process.exitCode = 1;
  });
}
