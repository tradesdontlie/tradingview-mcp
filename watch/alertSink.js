/**
 * Alert output sinks for watch mode.
 *
 * emitAlert  → loud stderr banner + one-line JSON to stdout (A+ signals only)
 * emitSummary → quiet one-line JSON to stdout (every non-alert tick)
 *
 * No broker execution. No order placement. Manual use only.
 *
 * @module alertSink
 */

const LIVE_TRADING_ENABLED = false;

/**
 * Emits an A+ alert: a loud banner to stderr and a structured JSON line to stdout.
 * Returns the payload object for testing.
 *
 * @param {object}      signal
 * @param {number|null} [currentPrice]
 * @param {string}      [ts]
 * @returns {object}
 */
export function emitAlert(signal, currentPrice = null, ts = new Date().toISOString()) {
  const payload = {
    type:                  'ALERT',
    timestamp:             ts,
    symbol:                signal.symbol,
    decision:              signal.decision,
    confidence:            signal.confidence,
    entry:                 signal.entry,
    stop:                  signal.stop,
    tp1:                   signal.tp1,
    tp2:                   signal.tp2  ?? null,
    r:                     signal.r,
    current_price:         currentPrice,
    reasons:               signal.reasons      ?? [],
    invalidation:          signal.invalidation  ?? [],
    setup_meta:            signal._meta         ?? null,
    manual_execution_only: true,
    live_trading_enabled:  LIVE_TRADING_ENABLED,
  };

  const line = `** ALERT ${ts} | ${signal.symbol} ${signal.decision} ${signal.confidence} | entry=${signal.entry} **`;
  const bar  = '='.repeat(line.length);
  process.stderr.write(`\n${bar}\n${line}\n${bar}\n`);
  process.stdout.write(JSON.stringify(payload) + '\n');
  return payload;
}

/**
 * Emits a quiet per-tick summary JSON line to stdout.
 * Used for every tick that does not trigger an alert.
 *
 * @param {string}      symbol
 * @param {string}      watchState  - current STATE value
 * @param {object|null} [signal]    - current signal (null for WAIT)
 * @param {string}      [ts]
 * @returns {object}
 */
export function emitSummary(symbol, watchState, signal = null, ts = new Date().toISOString()) {
  const payload = {
    type:                 'SUMMARY',
    timestamp:            ts,
    symbol,
    watch_state:          watchState,
    decision:             signal?.decision  ?? 'WAIT',
    confidence:           signal?.confidence ?? 'Reject',
    live_trading_enabled: LIVE_TRADING_ENABLED,
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
  return payload;
}
