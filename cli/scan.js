#!/usr/bin/env node
/**
 * cli/scan.js — Manual signal scan with live MCP data (Phase 3A)
 *
 * Collects 4H / 1H / 15m / 5m OHLCV from a running TradingView Desktop via
 * MCP, runs the engine pipeline, and writes a schema-complete signal JSON to
 * stdout.
 *
 * Data collection strategy:
 *   Phase 1 (preferred, no chart mutation):
 *     Tries data_get_ohlcv with a timeframe argument. If supported, all four
 *     TF bar sets are returned without touching the visible chart.
 *   Phase 2 (fallback, temporary chart mutation):
 *     If Phase 1 probe fails, chart_set_timeframe is used temporarily.
 *     Original symbol + timeframe are restored in a finally block even if
 *     an error occurs mid-collection.
 *
 * Diagnostics go to stderr only. stdout contains exactly one JSON object.
 * No broker execution. No order placement. Manual use only.
 *
 * Usage: node cli/scan.js [--symbol MNQ1!|MES1!] [--help]
 */

import { readFileSync }            from 'fs';
import { fileURLToPath }           from 'url';
import { join, dirname }           from 'path';
import { McpDataProvider }         from '../data/mcpDataProvider.js';
import { runEngines, buildSignal } from '../strategies/mtfSessionLiquidityTrap.js';
import { validate, checkStaleness, rejectToWait } from '../risk/riskManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── helpers ─────────────────────────────────────────────────────────────────

function printHelp() {
  process.stdout.write([
    'Usage: node cli/scan.js [--symbol MNQ1!|MES1!] [--help]',
    '',
    'Collects live TradingView OHLCV data via MCP and outputs a LONG/SHORT/WAIT',
    'signal as JSON to stdout. Diagnostics are written to stderr only.',
    '',
    'Requires TradingView Desktop running with --remote-debugging-port=9222.',
    '',
    'Options:',
    '  --symbol  Target symbol (default: MNQ1!)',
    '  --help    Show this message and exit',
    '',
    'No broker execution. Manual use only.',
    '',
  ].join('\n'));
}

/**
 * Builds a schema-complete WAIT signal. Used for all failure paths so stdout
 * is always valid JSON.
 */
function makeWaitSignal(ts, symbol, reason, rules) {
  return {
    id:               `${ts}-${symbol}`,
    timestamp:        ts,
    date:             ts.slice(0, 10),
    time:             ts.slice(11, 16),
    symbol,
    decision:         'WAIT',
    bias:             { '4H': 'unknown', '1H': 'unknown', '15m': 'unknown', '5m': 'unknown' },
    setup:            'MTF Session Liquidity Trap',
    entry:            null,
    stop:             null,
    tp1:              null,
    tp2:              null,
    r:                null,
    confidence:       'Reject',
    reasons:          [reason],
    invalidation:     [],
    what_would_change: 'Ensure TradingView Desktop is running with --remote-debugging-port=9222',
    status:           'pending',
    outcome_r:        null,
    _meta: {
      strategy:             rules?.strategy?.name            ?? null,
      live_trading_enabled: rules?.risk?.live_trading_enabled ?? false,
    },
  };
}

function emit(signal) {
  process.stdout.write(JSON.stringify(signal, null, 2) + '\n');
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Parse --symbol
  const symbolIdx = args.indexOf('--symbol');
  const symbol = symbolIdx !== -1 && args[symbolIdx + 1]
    ? args[symbolIdx + 1]
    : 'MNQ1!';

  const validSymbols = ['MNQ1!', 'MES1!'];
  if (!validSymbols.includes(symbol)) {
    process.stderr.write(`Error: --symbol must be one of ${validSymbols.join(', ')}\n`);
    process.exit(1);
  }

  // Load rules.json
  const rulesPath = join(__dirname, '..', 'rules.json');
  let rules;
  try {
    rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`Error: could not read rules.json at ${rulesPath}: ${err.message}\n`);
    process.exit(1);
  }

  if (rules?.risk?.live_trading_enabled === true) {
    process.stderr.write('Error: live_trading_enabled is true in rules.json — blocked in v0.1\n');
    process.exit(1);
  }

  const ts       = new Date().toISOString();
  const provider = new McpDataProvider();

  // ── Connect to MCP server ──────────────────────────────────────────────────
  try {
    await provider.connect();
  } catch (err) {
    process.stderr.write(`[scan] MCP connect failed: ${err.message}\n`);
    await provider.disconnect();
    emit(makeWaitSignal(ts, symbol, 'MCP connection failed — is TradingView running on port 9222?', rules));
    process.exit(0);
  }

  // ── Verify TradingView reachability ───────────────────────────────────────
  const healthy = await provider.healthCheck();
  if (!healthy) {
    process.stderr.write('[scan] TradingView not reachable\n');
    await provider.disconnect();
    emit(makeWaitSignal(ts, symbol, 'TradingView not reachable on port 9222', rules));
    process.exit(0);
  }

  // ── Collect multi-TF OHLCV ────────────────────────────────────────────────
  let ohlcvByTimeframe = null;
  let savedState       = null;   // non-null only when Phase 2 (chart mutation) is used
  let quote            = null;

  try {
    // Phase 1: probe for non-mutating timeframe param
    const timeframeParamSupported = await provider.probeTimeframeParam();

    if (timeframeParamSupported) {
      process.stderr.write('[scan] Phase 1: collecting OHLCV via timeframe param (no chart changes)\n');
      ohlcvByTimeframe = await provider.fetchAllTfsWithParam();
    } else {
      // Phase 2: temporary chart state changes — restored in finally below
      process.stderr.write('[scan] Phase 2: timeframe param not supported — using temporary chart_set_timeframe\n');

      savedState = await provider.getChartState();

      if (savedState?.symbol && savedState.symbol !== symbol) {
        process.stderr.write(`[scan] Switching chart symbol: ${savedState.symbol} → ${symbol}\n`);
        await provider.setSymbol(symbol);
      }

      ohlcvByTimeframe = await provider.fetchAllTfsWithChartChange();
    }

    quote = await provider.getQuote();

  } catch (err) {
    process.stderr.write(`[scan] OHLCV collection error: ${err.message}\n`);
  } finally {
    // Always restore chart state if Phase 2 was used, even if an error occurred
    if (savedState) {
      process.stderr.write('[scan] Restoring original chart state\n');
      await provider.restoreState(savedState);
    }
    await provider.disconnect();
  }

  // ── Handle missing data ────────────────────────────────────────────────────
  if (!ohlcvByTimeframe) {
    emit(makeWaitSignal(
      ts, symbol,
      'multi-timeframe OHLCV unavailable — check TradingView chart data or retry',
      rules,
    ));
    process.exit(0);
  }

  // ── Run engine pipeline ───────────────────────────────────────────────────
  const engineOutputs = runEngines(ohlcvByTimeframe, undefined, rules, Date.now());
  const signal        = buildSignal({ symbol, engineOutputs, rules, timestamp: ts });

  const currentPrice = quote?.last ?? quote?.close ?? quote?.price ?? null;

  // ── Staleness / risk validation ───────────────────────────────────────────
  // For LONG/SHORT: check stale/chase first (requires current price), then
  // validate against hard risk rules. Either failure converts the signal to a
  // schema-complete WAIT — the original candidate is preserved under
  // _meta.rejected_candidate for audit.
  let finalSignal = signal;

  if (signal.decision !== 'WAIT') {
    const staleReason = checkStaleness(signal, currentPrice);
    if (staleReason) {
      finalSignal = rejectToWait(signal, staleReason, 'expired');
    } else {
      const { approved, rejection_reason } = validate(signal, rules);
      if (!approved) {
        finalSignal = rejectToWait(signal, rejection_reason ?? 'risk_validation_failed', 'pending');
      }
    }
  }

  // Attach metadata (spread preserves _meta.rejected_candidate set by rejectToWait)
  finalSignal._meta = {
    ...(finalSignal._meta ?? {}),
    strategy:             rules?.strategy?.name            ?? null,
    live_trading_enabled: rules?.risk?.live_trading_enabled ?? false,
    bars_collected: {
      '4H':  ohlcvByTimeframe['4H']?.length  ?? 0,
      '1H':  ohlcvByTimeframe['1H']?.length  ?? 0,
      '15m': ohlcvByTimeframe['15m']?.length ?? 0,
      '5m':  ohlcvByTimeframe['5m']?.length  ?? 0,
    },
    ...(currentPrice != null ? { current_price: currentPrice } : {}),
  };

  emit(finalSignal);
}

// Safety net — always emit valid JSON even on unexpected throws
main().catch(err => {
  const ts = new Date().toISOString();
  process.stderr.write(`[scan] Unhandled error: ${err.stack ?? err.message}\n`);
  process.stdout.write(JSON.stringify({
    id:               `${ts}-error`,
    timestamp:        ts,
    date:             ts.slice(0, 10),
    time:             ts.slice(11, 16),
    symbol:           'UNKNOWN',
    decision:         'WAIT',
    bias:             { '4H': 'unknown', '1H': 'unknown', '15m': 'unknown', '5m': 'unknown' },
    setup:            'MTF Session Liquidity Trap',
    entry:            null,
    stop:             null,
    tp1:              null,
    tp2:              null,
    r:                null,
    confidence:       'Reject',
    reasons:          [`Unhandled error: ${err.message}`],
    invalidation:     [],
    what_would_change: 'Fix the unhandled error and retry',
    status:           'pending',
    outcome_r:        null,
  }, null, 2) + '\n');
  process.exit(0);
});
