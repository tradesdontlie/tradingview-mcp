/**
 * Estimate a candidate config's win% and expectancy by REPLAYING a resolved
 * trade log filtered to the candidate's active strategies.
 *
 * A logged trade is RETAINED if at least 2 of its agreeing strategies are still
 * active in the candidate (confluence needs ≥2). Disabling a strategy drops the
 * trades that depended on it to reach confluence; trades still supported by ≥2
 * active strategies survive. This is a sound first-order estimate: removing a
 * strategy can only remove signals, never invent them, so it never overstates.
 *
 * Source preference: the live ledger (futures) when it has ≥ MIN_SAMPLE retained
 * trades — it's the truest signal — otherwise the confluence-bot backtest (the
 * live-model prior, on the same scale as the objective). Spot has no ledger, so
 * spot always falls through to its backtest.
 *
 * Trade shape (from lib/backtest.mjs and lib/ledger.mjs): { strategies, win, r }.
 */
import { THRESHOLDS } from '../config.mjs';

function retain(trades, active) {
  const set = new Set(active);
  return trades.filter((t) => t.strategies.filter((s) => set.has(s)).length >= 2);
}

function aggregate(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.win).length;
  const withR = trades.filter((t) => typeof t.r === 'number');
  return {
    sample: n,
    winRate: n ? wins / n : null,
    expectancy: withR.length ? withR.reduce((s, t) => s + t.r, 0) / withR.length : null,
  };
}

export function estimatePerformance(candidate, { ledgerTrades = [], backtestTrades = [] } = {}) {
  const active = candidate.active_strategies ?? [];

  const fromLedger = retain(ledgerTrades, active);
  if (fromLedger.length >= THRESHOLDS.MIN_SAMPLE) {
    return { source: 'ledger', ...aggregate(fromLedger) };
  }

  const fromBacktest = retain(backtestTrades, active);
  return { source: 'backtest', ...aggregate(fromBacktest) };
}
