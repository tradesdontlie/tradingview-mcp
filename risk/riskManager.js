/**
 * Validates a candidate signal against the hard risk rules in rules.json.
 *
 * Phase 2A checks all conditions derivable from the signal object itself.
 * Runtime state checks (daily count, news lockout, duplicate detection) are
 * stubbed and noted for Phase 3 wiring.
 *
 * Phase 3A-FIX adds: checkStaleness (stale/chase price guard) and
 * rejectToWait (schema-complete WAIT conversion with rejected_candidate).
 *
 * @module riskManager
 */

/** Tick size in index points for each supported symbol. */
export const TICK_SIZE = { 'MNQ1!': 0.25, 'MES1!': 0.25 };

/** Ticks of allowed slippage before a signal is considered chased. */
export const ALLOWED_SLIPPAGE_TICKS = 4;

/**
 * Computes the stop width in ticks between entry and stop prices.
 *
 * @param {number} entry
 * @param {number} stop
 * @param {string} symbol - e.g. "MNQ1!"
 * @returns {number} number of ticks (always positive)
 */
export function computeStopWidthTicks(entry, stop, symbol) {
  const tick = TICK_SIZE[symbol] ?? 0.25;
  return Math.abs(entry - stop) / tick;
}

/**
 * Checks whether a LONG or SHORT signal is stale or being chased based on
 * the current live price.
 *
 * LONG stale when:
 *   current_price >= tp1            (target already reached without entry)
 *   current_price > entry + 4 ticks (entry opportunity already passed)
 *
 * SHORT stale when:
 *   current_price <= tp1            (target already reached without entry)
 *   current_price < entry - 4 ticks (entry opportunity already passed)
 *
 * Returns null when the signal is still fresh or when currentPrice is unknown.
 *
 * @param {object}      signal       - SignalObject (decision, entry, tp1, symbol)
 * @param {number|null} currentPrice - live price from quote_get
 * @returns {string|null} rejection reason, or null if signal is fresh
 */
export function checkStaleness(signal, currentPrice) {
  if (signal.decision === 'WAIT' || currentPrice == null) return null;

  const tick        = TICK_SIZE[signal.symbol] ?? 0.25;
  const slippagePts = ALLOWED_SLIPPAGE_TICKS * tick;
  const { decision, entry, tp1 } = signal;

  if (decision === 'LONG') {
    if (tp1 != null && currentPrice >= tp1) {
      return 'signal stale: current price already beyond TP1';
    }
    if (entry != null && currentPrice > entry + slippagePts) {
      return 'signal stale: current price too far from entry';
    }
  } else if (decision === 'SHORT') {
    if (tp1 != null && currentPrice <= tp1) {
      return 'signal stale: current price already beyond TP1';
    }
    if (entry != null && currentPrice < entry - slippagePts) {
      return 'signal stale: current price too far from entry';
    }
  }

  return null;
}

/**
 * Converts a LONG/SHORT candidate signal into a schema-complete WAIT signal.
 * The original candidate's trading fields are preserved under _meta.rejected_candidate
 * so the reason for rejection is auditable.
 *
 * @param {object}              signal - original LONG/SHORT SignalObject
 * @param {string}              reason - human-readable rejection reason
 * @param {'expired'|'pending'} [status='expired'] - resulting signal status
 * @returns {object} schema-complete WAIT SignalObject
 */
export function rejectToWait(signal, reason, status = 'expired') {
  return {
    id:                signal.id,
    timestamp:         signal.timestamp,
    date:              signal.date,
    time:              signal.time,
    symbol:            signal.symbol,
    decision:          'WAIT',
    bias:              signal.bias ?? { '4H': 'unknown', '1H': 'unknown', '15m': 'unknown', '5m': 'unknown' },
    setup:             signal.setup ?? 'MTF Session Liquidity Trap',
    entry:             null,
    stop:              null,
    tp1:               null,
    tp2:               null,
    r:                 null,
    confidence:        'Reject',
    reasons:           [reason],
    invalidation:      signal.invalidation ?? [],
    what_would_change: signal.what_would_change ?? '',
    status,
    outcome_r:         null,
    _meta: {
      ...(signal._meta ?? {}),
      rejected_candidate: {
        decision:   signal.decision,
        entry:      signal.entry,
        stop:       signal.stop,
        tp1:        signal.tp1,
        tp2:        signal.tp2,
        r:          signal.r,
        confidence: signal.confidence,
        reasons:    signal.reasons,
      },
    },
  };
}

/**
 * @typedef {{ approved: boolean, rejection_reason: string|null }} ValidationResult
 */

/**
 * Validates a candidate signal against the rules.json hard limits.
 *
 * Checked in this call:
 *   ✓ live_trading_enabled must be false
 *   ✓ decision must be LONG or SHORT (WAIT signals are never approved)
 *   ✓ confidence must not be "Reject" or "C"
 *   ✓ entry and stop must be defined
 *   ✓ tp1 must be defined
 *   ✓ r must not be null
 *   ✓ r >= rules.risk.min_reward_risk (default 1.5)
 *   ✓ stop width in ticks <= rules.risk.max_stop_ticks[symbol] (default 40)
 *
 * Deferred to Phase 3 (require runtime state):
 *   - daily trade count check
 *   - news lockout window check (requires external news time source)
 *   - duplicate active signal check (requires journal query)
 *
 * @param {object} candidateSignal - SignalObject
 * @param {object} rules - parsed rules.json object
 * @returns {ValidationResult}
 */
export function validate(candidateSignal, rules) {
  if (rules?.risk?.live_trading_enabled === true) {
    return { approved: false, rejection_reason: 'live_trading_enabled is true — blocked in v0.1' };
  }

  if (candidateSignal.decision === 'WAIT') {
    return { approved: false, rejection_reason: 'decision_is_WAIT' };
  }

  const grade = candidateSignal.confidence;
  if (grade === 'Reject' || grade === 'C') {
    return { approved: false, rejection_reason: `signal_grade_${grade}_below_threshold` };
  }

  if (candidateSignal.entry == null || candidateSignal.stop == null) {
    return { approved: false, rejection_reason: 'entry_or_stop_undefined' };
  }

  if (candidateSignal.tp1 == null) {
    return { approved: false, rejection_reason: 'tp1_undefined' };
  }

  if (candidateSignal.r == null) {
    return { approved: false, rejection_reason: 'r_is_null' };
  }

  const minR = rules?.risk?.min_reward_risk ?? 1.5;
  if (candidateSignal.r < minR) {
    return { approved: false, rejection_reason: `r_below_minimum: ${candidateSignal.r} < ${minR}` };
  }

  const sym       = candidateSignal.symbol;
  const maxTicks  = rules?.risk?.max_stop_ticks?.[sym] ?? 40;
  const stopTicks = computeStopWidthTicks(candidateSignal.entry, candidateSignal.stop, sym);
  if (stopTicks > maxTicks) {
    return { approved: false, rejection_reason: `stop_too_wide: ${stopTicks} ticks > max ${maxTicks}` };
  }

  // TODO Phase 3: daily trade count check
  // TODO Phase 3: news lockout check (requires external event calendar)
  // TODO Phase 3: duplicate active signal check (requires journal.readAll())

  return { approved: true, rejection_reason: null };
}
