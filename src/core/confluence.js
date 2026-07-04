/**
 * Multi-strategy confluence — the mechanical, codeable form of the
 * curriculum's repeated guidance that independent techniques COMPLEMENT each
 * other to produce more accurate, higher-probability setups:
 *
 *   - Divergence chapter: "Divergences are very reliable, adding further
 *     price movement confirmations leads to a more profitable setup."
 *   - Every worked trade example in the divergence master-class stacks the
 *     base signal with further confirmations (candle patterns, zone retests,
 *     S/R breaks, EMA support, volume, retracement...).
 *   - SFP chapter: a retest sweep is explicitly HIGHER conviction than a
 *     first hit, "not a lesser consolation entry" — agreement/repetition
 *     across independent reads raises conviction, it doesn't dilute it.
 *
 * Rather than trading on any single strategy's signal in isolation, this
 * layer requires AGREEMENT: at least two independently-coded strategies must
 * read the same symbol's direction the same way, within the same scan
 * window, before a setup is treated as accurate enough to execute.
 *
 * This also resolves the multi-strategy execution question raised earlier:
 * with confluence required, there is exactly one combined decision per
 * symbol per scan — no risk of two strategies independently claiming the
 * same risk budget, and no need for an arbitrary strategy-priority ranking.
 */

function requireSignals(signals) {
  if (!Array.isArray(signals) || signals.length === 0) {
    throw new Error('signals must be a non-empty array of {strategy, plan: {side}, confirmedAt} candidate signals');
  }
  for (const s of signals) {
    if (!s || typeof s.strategy !== 'string' || !s.strategy) throw new Error('each signal must include a non-empty "strategy" name');
    if (!s.plan || !['long', 'short'].includes(s.plan.side)) throw new Error('each signal must include plan: {side: "long"|"short", ...}');
  }
  return signals;
}

/**
 * Assess whether a set of independently-detected candidate signals (one slot
 * per strategy, e.g. SFP + RSI Divergence) for the SAME symbol/scan agree on
 * direction.
 *
 *   - Disagreement (one strategy reads long, another reads short): the
 *     curriculum gives no rule for resolving conflicting independent reads —
 *     forcing a call here would substitute a guess for a missing rule, so
 *     the mechanically correct response is to stand down (returns
 *     confluence:false, conflict:true).
 *   - Single-strategy agreement (only one strategy fired): no independent
 *     confirmation yet — stand down (confluence:false, conflict:false).
 *   - 2+ strategies agree: CONFLUENCE. The most recently confirmed signal's
 *     plan is used for execution (freshest price action — mirrors how the
 *     SFP scanner already breaks ties among same-strategy candidates), and
 *     the agreement itself is recorded as the conviction boost.
 */
export function assessConfluence({ signals } = {}) {
  requireSignals(signals);

  const bySide = { long: [], short: [] };
  for (const s of signals) bySide[s.plan.side].push(s);
  const sidesPresent = Object.entries(bySide).filter(([, list]) => list.length > 0);

  if (sidesPresent.length > 1) {
    return {
      confluence: false,
      conflict: true,
      reason: `strategies disagree on direction (${sidesPresent.map(([side, list]) => `${side}: ${list.map(s => s.strategy).join('+')}`).join(' vs ')}) — standing down rather than forcing a call no rule resolves`,
      signals,
    };
  }

  const [side, agreeing] = sidesPresent[0];

  if (agreeing.length < 2) {
    return {
      confluence: false,
      conflict: false,
      side,
      reason: `only one strategy (${agreeing[0].strategy}) signaled ${side} — no independent confirmation yet, standing down`,
      signals: agreeing,
    };
  }

  const sorted = [...agreeing].sort((a, b) => (b.confirmedAt ?? 0) - (a.confirmedAt ?? 0));
  const primary = sorted[0];

  return {
    confluence: true,
    conflict: false,
    side,
    agreeing_strategies: agreeing.map(s => s.strategy),
    plan: primary.plan,
    primary_strategy: primary.strategy,
    confidence: `confluence — ${agreeing.map(s => s.strategy).join(' + ')} independently agree on ${side}`,
    signals: agreeing,
  };
}
