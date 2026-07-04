/**
 * Parse strategy_matrix_results.csv (produced by scripts/strategy_matrix.mjs).
 * Columns: step,group,strategy,timeframe,win_rate_pct,total_trades,
 *          profit_factor,max_drawdown_R,net_R,avg_R,wins,losses,open
 *
 * The `strategy` field is the combo identifier and is QUOTED when it contains the
 * filter separator. Shapes seen in the wild:
 *   "divergence+levels"            → 2-strategy pair, no filter
 *   "divergence+levels | vwap"     → that pair with the vwap confirmation filter
 *   "market_structure"             → single strategy
 * Strategy order is NOT alphabetical in the file ("divergence+cvd_divergence"),
 * so we canonicalize to a sorted key for order-independent lookup.
 *
 * This is the authoritative win%/expectancy source for SPOT (no live ledger) and
 * a cross-check for futures. It's a neutral both-directions sim — raw edge, not
 * the live bot model — so treat it as the prior and the live ledger as posterior.
 */
import { readFileSync, existsSync } from 'node:fs';
import { WINRATE_ONLY_TFS } from '../config.mjs';

// Minimal RFC-4180-ish field parser: handles double-quoted fields with doubled-quote escaping.
function parseCsvLine(line) {
  const out = [];
  let field = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

// "divergence+levels | vwap" -> { strategies: [...sorted], filter: 'vwap', key: 'divergence+levels' }
function parseCombo(raw) {
  const [stratPart, filterPart] = raw.split('|').map((s) => s.trim());
  const strategies = stratPart.split('+').map((s) => s.trim()).filter(Boolean).sort();
  return { strategies, filter: filterPart || null, key: strategies.join('+') };
}

export function readMatrix(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const combo = parseCombo(c[idx.strategy] ?? '');
    rows.push({
      step: c[idx.step],
      group: c[idx.group],
      comboRaw: c[idx.strategy],
      comboKey: combo.key,          // sorted strategy set, e.g. "cvd_divergence+divergence"
      filter: combo.filter,         // 'vwap' | 'vpvr' | 'levels' | null
      timeframe: c[idx.timeframe],
      winRate: num(c[idx.win_rate_pct]) === null ? null : num(c[idx.win_rate_pct]) / 100,
      totalTrades: num(c[idx.total_trades]),
      avgR: num(c[idx.avg_R]),
      netR: num(c[idx.net_R]),
      profitFactor: num(c[idx.profit_factor]),
    });
  }
  return rows;
}

/**
 * Look up matrix stats for a combo at a timeframe (default 15m, the execution TF),
 * matching by canonical (order-independent) strategy set. `filter` defaults to null
 * — the bare pair row, no confirmation filter applied.
 * On 1m/5m rows avg_R/PF are simulation artifacts and are nulled: win% only there.
 */
export function lookupCombo(rows, combo, { timeframe = '15m', filter = null } = {}) {
  const key = combo.split('+').map((s) => s.trim()).filter(Boolean).sort().join('+');
  const row = rows.find((r) => r.comboKey === key && r.filter === filter && r.timeframe === timeframe);
  if (!row) return null;
  const artifactTf = WINRATE_ONLY_TFS.has(timeframe);
  return {
    combo: key,
    timeframe,
    winRate: row.winRate,
    sample: row.totalTrades,
    expectancy: artifactTf ? null : row.avgR,
    trustExpectancy: !artifactTf,
  };
}
