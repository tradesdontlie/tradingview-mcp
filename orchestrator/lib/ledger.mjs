/**
 * Parse trade_ledger.jsonl (written by the futures bot) into resolved trades,
 * and aggregate per strategy-combo over a rolling window.
 *
 * Ledger semantics (see scripts/auto_trade_futures.mjs): one "open" record at
 * execution and one "close" record when the position is detected gone. We pair
 * by `id` and key everything off the close record (it carries win + realized_r).
 * Spot does NOT write a ledger (no exchange-side exit) — spot win% comes from the
 * backtest matrix instead. So this ledger is futures-only by design.
 */
import { readFileSync, existsSync } from 'node:fs';

export function readResolvedTrades(path, { sinceMs = 0 } = {}) {
  if (!existsSync(path)) return [];
  const trades = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { continue; }
    if (rec.phase !== 'close') continue;          // only resolved trades
    if (rec.win === null || rec.win === undefined) continue;  // skip 'manual'/unknown exits
    const closedMs = rec.closed_at ? Date.parse(rec.closed_at) : 0;
    if (closedMs < sinceMs) continue;
    trades.push(rec);
  }
  return trades;
}

/**
 * Normalize resolved close-records into the shared estimate trade shape
 * { strategies, win, r } — the same shape readBacktestTrades produces.
 */
export function ledgerTradesNormalized(closes) {
  return closes.map((c) => ({
    strategies: String(c.combo ?? '').split('+').filter(Boolean),
    win: !!c.win,
    r: typeof c.realized_r === 'number' ? c.realized_r : (c.win ? null : -1),
  })).filter((t) => t.strategies.length >= 2);
}

/**
 * Aggregate resolved trades into per-combo stats.
 * Returns a Map: combo -> { n, wins, losses, winRate, expectancy }.
 * expectancy = mean realized_r; winRate = wins / n.
 */
export function aggregateByCombo(trades) {
  const byCombo = new Map();
  for (const t of trades) {
    const key = t.combo ?? '(unknown)';
    if (!byCombo.has(key)) byCombo.set(key, { n: 0, wins: 0, sumR: 0 });
    const a = byCombo.get(key);
    a.n += 1;
    if (t.win) a.wins += 1;
    if (typeof t.realized_r === 'number') a.sumR += t.realized_r;
  }
  const out = new Map();
  for (const [combo, a] of byCombo) {
    out.set(combo, {
      n: a.n,
      wins: a.wins,
      losses: a.n - a.wins,
      winRate: a.n ? a.wins / a.n : 0,
      expectancy: a.n ? a.sumR / a.n : 0,
    });
  }
  return out;
}
