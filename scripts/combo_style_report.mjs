// Aggregates backtest trades by strategy combo, tags each combo with a
// trading-style category (Scalp / Day / Swing, or cross-bucket mixes), and
// rolls the net stats up by style. Reads the JSON written by the two harnesses.
// Standalone analysis tool — not part of the bot/test surface.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Per-strategy style buckets (from project_strategy_style_grouping.md)
const SCALP = new Set(['market_structure', 'cvd_divergence']);
const DAY   = new Set(['divergence', 'levels', 'fibonacci', 'sfp', 'pinbar']);
const SWING = new Set(['chart_pattern']);

function comboStyle(strategies) {
  let s = false, d = false, w = false;
  for (const leg of strategies) {
    if (SCALP.has(leg)) s = true;
    else if (DAY.has(leg)) d = true;
    else if (SWING.has(leg)) w = true;
  }
  const parts = [];
  if (w) parts.push('Swing');
  if (s) parts.push('Scalp');
  if (d) parts.push('Day');
  return parts.join('+') || 'Other';
}

const round2 = n => Math.round(n * 100) / 100;
const round3 = n => Math.round(n * 1000) / 1000;
const mean   = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

function aggregate(trades, keyFn) {
  const groups = {};
  for (const t of trades) {
    if (t.netR == null) continue; // resolved trades only
    const k = keyFn(t);
    (groups[k] ||= []).push(t);
  }
  const rows = Object.entries(groups).map(([k, ts]) => {
    const netWins = ts.filter(t => t.netR > 0).length;
    return {
      key: k,
      n: ts.length,
      grossWinRate: Math.round(ts.filter(t => t.grossR > 0).length / ts.length * 100),
      netWinRate: Math.round(netWins / ts.length * 100),
      netExp: round2(mean(ts.map(t => t.netR))),
      totalNetR: round2(ts.reduce((x, t) => x + t.netR, 0)),
    };
  });
  rows.sort((a, b) => b.totalNetR - a.totalNetR);
  return rows;
}

function report(label, file) {
  const data = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  const trades = data.trades.filter(t => t.netR != null);

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`  ${label} — ${trades.length} resolved trades`);
  console.log(`${'═'.repeat(78)}`);

  // By style category
  console.log(`\n  BY STYLE CATEGORY`);
  console.log(`  ${'style'.padEnd(18)} ${'n'.padStart(4)}  ${'grossWR'.padStart(7)} ${'netWR'.padStart(6)} ${'netExp'.padStart(7)} ${'totNetR'.padStart(8)}`);
  for (const r of aggregate(trades, t => comboStyle(t.strategies))) {
    console.log(`  ${r.key.padEnd(18)} ${String(r.n).padStart(4)}  ${(r.grossWinRate + '%').padStart(7)} ${(r.netWinRate + '%').padStart(6)} ${(r.netExp + 'R').padStart(7)} ${(r.totalNetR + 'R').padStart(8)}`);
  }

  // By individual combo, with its style tag
  console.log(`\n  BY COMBO  (min 3 trades)`);
  console.log(`  ${'combo'.padEnd(42)} ${'style'.padEnd(15)} ${'n'.padStart(3)} ${'netWR'.padStart(6)} ${'netExp'.padStart(7)} ${'totNetR'.padStart(8)}`);
  const combos = aggregate(trades, t => t.strategies.join('+'));
  for (const r of combos.filter(c => c.n >= 3)) {
    console.log(`  ${r.key.padEnd(42)} ${comboStyle(r.key.split('+')).padEnd(15)} ${String(r.n).padStart(3)} ${(r.netWinRate + '%').padStart(6)} ${(r.netExp + 'R').padStart(7)} ${(r.totalNetR + 'R').padStart(8)}`);
  }
}

report('SPOT', 'backtest_results.json');
report('FUTURES', 'backtest_futures_results.json');
