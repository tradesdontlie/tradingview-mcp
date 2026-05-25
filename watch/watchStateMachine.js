/**
 * Watch-mode state machine for the futures-ai-chart-copilot.
 *
 * Pure functions — no I/O, no side effects.
 * State lifecycle: IDLE → TRACKING → ALERTED → (reset to IDLE on WAIT/stale)
 *
 * @module watchStateMachine
 */

export const STATE = Object.freeze({
  IDLE:        'IDLE',
  TRACKING:    'TRACKING',
  ALERTED:     'ALERTED',
  EXPIRED:     'EXPIRED',
  INVALIDATED: 'INVALIDATED',
});

/**
 * Creates a fresh per-symbol watch state.
 *
 * @param {string} symbol
 * @returns {{ symbol: string, state: string, lastAlertedKey: string|null, lastSignal: object|null }}
 */
export function createSymbolState(symbol) {
  return { symbol, state: STATE.IDLE, lastAlertedKey: null, lastSignal: null };
}

/**
 * Builds a stable deduplication key from a LONG/SHORT signal.
 * Returns null for WAIT signals (they are never deduplicated).
 *
 * The key encodes all fields that define a unique trade opportunity so that
 * the same setup on the same bars never fires a second alert.
 *
 * @param {object|null} signal
 * @returns {string|null}
 */
export function makeSignalKey(signal) {
  if (!signal || signal.decision === 'WAIT') return null;
  const m = signal._meta ?? {};
  return [
    signal.symbol    ?? '',
    signal.decision  ?? '',
    signal.entry     ?? '',
    signal.stop      ?? '',
    signal.tp1       ?? '',
    signal.setup     ?? '',
    m.sweep_bar_index        ?? '',
    m.reclaim_bar_index      ?? '',
    m.mss_bar_index          ?? '',
    m.displacement_bar_index ?? '',
  ].join('|');
}

/**
 * Returns true only for A+ LONG or A+ SHORT signals.
 * All other confidence grades (A, A-, B+, B, C, Reject) and all non-LONG/SHORT
 * decisions return false.
 *
 * @param {object|null} signal
 * @returns {boolean}
 */
export function isActionableAPlus(signal) {
  return (
    signal != null &&
    signal.confidence === 'A+' &&
    (signal.decision === 'LONG' || signal.decision === 'SHORT')
  );
}

/**
 * Advances the state machine by one scan tick.
 *
 * Rules:
 *   - EXPIRED / INVALIDATED auto-reset to IDLE at the start of each tick
 *   - WAIT or stale signal resets any non-IDLE state back to IDLE
 *   - A+ LONG/SHORT signal with new key → ALERTED + alert=true
 *   - A+ LONG/SHORT signal with same key as last alert → ALERTED + alert=false (duplicate suppressed)
 *   - Non-A+ actionable signal → TRACKING, no alert
 *
 * @param {{ symbol:string, state:string, lastAlertedKey:string|null, lastSignal:object|null }} symbolState
 * @param {object|null} signal - current signal (may be WAIT)
 * @param {{ staleness?: string|null }} [opts]
 * @returns {{ newState: object, alert: boolean, event: string }}
 */
export function transition(symbolState, signal, opts = {}) {
  const { staleness = null } = opts;
  let st = symbolState;

  // Auto-reset transient terminal states
  if (st.state === STATE.EXPIRED || st.state === STATE.INVALIDATED) {
    st = { ...st, state: STATE.IDLE, lastAlertedKey: null, lastSignal: null };
  }

  const effectiveWait = !signal || signal.decision === 'WAIT' || !!staleness;
  const isAPlus       = !effectiveWait && isActionableAPlus(signal);

  if (effectiveWait) {
    if (st.state === STATE.IDLE) {
      return { newState: st, alert: false, event: 'idle_wait' };
    }
    const event = staleness
      ? 'staleness_reset'
      : st.state === STATE.ALERTED ? 'signal_expired' : 'signal_lost';
    return {
      newState: { ...st, state: STATE.IDLE, lastAlertedKey: null, lastSignal: null },
      alert: false,
      event,
    };
  }

  if (isAPlus) {
    const key = makeSignalKey(signal);
    if (key && key === st.lastAlertedKey) {
      return {
        newState: { ...st, state: STATE.ALERTED, lastSignal: signal },
        alert: false,
        event: 'duplicate_suppressed',
      };
    }
    return {
      newState: { ...st, state: STATE.ALERTED, lastAlertedKey: key, lastSignal: signal },
      alert: true,
      event: 'new_alert',
    };
  }

  // Non-A+ actionable signal (A, B, Reject, etc.)
  return {
    newState: { ...st, state: STATE.TRACKING, lastSignal: signal },
    alert: false,
    event: st.state === STATE.ALERTED ? 'grade_degraded' : 'tracking',
  };
}
