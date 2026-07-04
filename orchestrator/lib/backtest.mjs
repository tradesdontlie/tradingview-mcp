/**
 * Read the confluence-bot backtest output (backtest_results.json for spot,
 * backtest_futures_results.json for futures) into normalized resolved trades.
 *
 * This is the LIVE-MODEL source: it ran the actual bot pipeline (confluence + the
 * bias-filter stack + Ch.6 guard), includes the `levels` strategy, and is on the
 * same scale as the 60% objective (spot ~65%, futures ~66%). It replaces the
 * neutral strategy-matrix sweep as the estimate's primary source. Regenerate via
 * `node scripts/run_backtest.mjs` / `run_backtest_futures.mjs`.
 *
 * Normalized trade shape (shared with the live ledger): { strategies, win, r }
 * where r is the fixed-R outcome (win → planned rr, loss → -1).
 */
import { readFileSync, existsSync } from 'node:fs';

export function readBacktestTrades(path) {
  if (!existsSync(path)) return [];
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  const out = [];
  for (const t of data.trades ?? []) {
    if (t.outcome === 'open') continue;            // unresolved
    if (!Array.isArray(t.strategies) || t.strategies.length < 2) continue;
    const win = t.outcome === 'win';
    const rr = typeof t.rr === 'number' ? t.rr : null;
    out.push({ strategies: t.strategies, win, r: win ? rr : -1 });
  }
  return out;
}

/** Per-combo aggregation for the read_backtest tool (transparency for the agent). */
export function aggregateTradesByCombo(trades) {
  const by = new Map();
  for (const t of trades) {
    const k = [...t.strategies].sort().join('+');
    if (!by.has(k)) by.set(k, { n: 0, wins: 0, sumR: 0, rN: 0 });
    const a = by.get(k);
    a.n += 1;
    if (t.win) a.wins += 1;
    if (typeof t.r === 'number') { a.sumR += t.r; a.rN += 1; }
  }
  const out = {};
  for (const [k, a] of by) out[k] = { n: a.n, winRate: a.n ? a.wins / a.n : 0, expectancy: a.rN ? a.sumR / a.rN : null };
  return out;
}
