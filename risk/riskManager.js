/**
 * Validates a candidate signal against the hard risk rules in rules.json.
 *
 * Phase 2A checks all conditions derivable from the signal object itself.
 * Runtime state checks (daily count, news lockout, duplicate detection) are
 * stubbed and noted for Phase 3 wiring.
 *
 * @module riskManager
 */

/** Tick size in index points for each supported symbol. */
const TICK_SIZE = { 'MNQ1!': 0.25, 'MES1!': 0.25 };

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
  // Sanity: live trading flag must be explicitly false
  if (rules?.risk?.live_trading_enabled === true) {
    return { approved: false, rejection_reason: 'live_trading_enabled is true — blocked in v0.1' };
  }

  // WAIT signals are never approved for execution
  if (candidateSignal.decision === 'WAIT') {
    return { approved: false, rejection_reason: 'decision_is_WAIT' };
  }

  // Grade gate
  const grade = candidateSignal.confidence;
  if (grade === 'Reject' || grade === 'C') {
    return { approved: false, rejection_reason: `signal_grade_${grade}_below_threshold` };
  }

  // Entry and stop must both be defined
  if (candidateSignal.entry == null || candidateSignal.stop == null) {
    return { approved: false, rejection_reason: 'entry_or_stop_undefined' };
  }

  // R must meet minimum
  const minR = rules?.risk?.min_reward_risk ?? 1.5;
  if (candidateSignal.r != null && candidateSignal.r < minR) {
    return { approved: false, rejection_reason: `r_below_minimum: ${candidateSignal.r} < ${minR}` };
  }

  // Stop width check
  const sym      = candidateSignal.symbol;
  const maxTicks = rules?.risk?.max_stop_ticks?.[sym] ?? 40;
  const stopTicks = computeStopWidthTicks(candidateSignal.entry, candidateSignal.stop, sym);
  if (stopTicks > maxTicks) {
    return { approved: false, rejection_reason: `stop_too_wide: ${stopTicks} ticks > max ${maxTicks}` };
  }

  // TODO Phase 3: daily trade count check
  // TODO Phase 3: news lockout check (requires external event calendar)
  // TODO Phase 3: duplicate active signal check (requires journal.readAll())

  return { approved: true, rejection_reason: null };
}
