/**
 * Historical backtest of the screening criteria.
 *
 * For each symbol, pulls its full available OHLCV history ONCE (same CDP
 * call the live scanner uses), then replays the screening detectors against
 * every historical day locally in pure JS (no further network calls) —
 * `bars.slice(0, t+1)` simulates "what the screener would have seen if it
 * ran as-of day t," using the exact same detector code as production so the
 * backtest can't silently drift from what actually ships.
 *
 * For every historical match, walks forward up to LOOKFORWARD_BARS to see
 * whether price hit take_profit_1 before hitting cutloss (a "win"), the
 * reverse (a "loss"), or neither within the window ("unresolved").
 *
 * LIMITATIONS (read before trusting the win rate):
 *   - Only ~500 bars (~2 years) of daily history are available per symbol —
 *     no longer sample without manually scrolling each chart back further.
 *   - This is a mechanical TP-vs-cutloss race, not a real trading
 *     simulation — no transaction costs, slippage, partial fills, or
 *     capital/position-sizing constraints.
 *   - Small per-criterion sample sizes (N) make the win rate unreliable —
 *     always read N alongside the percentage, not the percentage alone.
 *   - Survivorship bias: only currently-listed symbols are tested; any
 *     stock that got delisted during the window is invisible here.
 *
 * Usage:
 *   node screener/backtest.js --limit 50
 *   node screener/backtest.js --symbols BBCA,BBRI,TLKM
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSymbol } from '../src/core/chart.js';
import { getOhlcv } from '../src/core/data.js';
import { disconnect } from '../src/connection.js';

import { findPivots, avgValueTraded } from './lib/zigzag.js';
import { findSrZones } from './lib/support_resistance.js';
import { detectDowntrendBreak } from './lib/trendline.js';
import { detectElliottImpulse, detectElliottWave2Support, detectPullbackReversal } from './lib/elliott.js';
import { detectAllPatterns } from './lib/patterns.js';
import { detectBreakoutWithVolume, detectVolumeSpikeGreenCandle, detectConfirmedUptrend } from './lib/volume.js';
import { buildTradingPlan } from './lib/levels.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIN_AVG_VALUE_TRX_50D = 1_000_000_000;
const MIN_HISTORY_BARS = 150; // need enough history before the first as-of day to let pivots/SMA200 etc. form
const LOOKFORWARD_BARS = 60; // ~3 trading months to let TP/cutloss resolve

function parseArgs(argv) {
  const args = { limit: null, symbols: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    if (argv[i] === '--symbols') args.symbols = argv[++i].split(',').map(s => s.trim().toUpperCase());
  }
  return args;
}

function loadSymbols({ limit, symbols }) {
  if (symbols) return symbols;
  const csv = readFileSync(join(__dirname, 'idx_all.csv'), 'utf8');
  const lines = csv.trim().split('\n').slice(1);
  let codes = lines.map(l => l.split(',')[0].trim()).filter(Boolean);
  if (limit) codes = codes.slice(0, limit);
  return codes;
}

function runDetectorsAsOf(asOfBars) {
  const pivots = findPivots(asOfBars, 0.04);
  const srZones = findSrZones(pivots);
  const matches = [];

  const tryAdd = (criterion, detail) => {
    if (!detail) return;
    const plan = buildTradingPlan(criterion, detail, asOfBars, srZones);
    if (!plan) return;
    matches.push({ criterion, plan });
  };

  tryAdd('downtrend_break', detectDowntrendBreak(asOfBars, pivots));
  tryAdd('elliott_wave', detectElliottImpulse(asOfBars, pivots));
  tryAdd('elliott_wave2', detectElliottWave2Support(asOfBars, pivots));
  tryAdd('pullback_reversal', detectPullbackReversal(asOfBars, pivots));
  for (const pattern of detectAllPatterns(asOfBars, pivots)) tryAdd(pattern.pattern, pattern);
  tryAdd('breakout_resistance_with_volume', detectBreakoutWithVolume(asOfBars, srZones));
  tryAdd('volume_spike_green_candle', detectVolumeSpikeGreenCandle(asOfBars));
  tryAdd('confirmed_uptrend', detectConfirmedUptrend(asOfBars, pivots));

  return matches;
}

/** Walk forward from entryIdx+1, race TP1 vs cutloss. Same-day double-touch is resolved by which side the open sat closer to (a rough tie-break, not exact intraday sequencing). */
function resolveOutcome(bars, entryIdx, plan) {
  const end = Math.min(bars.length, entryIdx + 1 + LOOKFORWARD_BARS);
  for (let i = entryIdx + 1; i < end; i++) {
    const bar = bars[i];
    const hitCutloss = plan.cutloss != null && bar.low <= plan.cutloss;
    const hitTp = plan.take_profit_1 != null && bar.high >= plan.take_profit_1;
    if (hitCutloss && hitTp) {
      const midpoint = (plan.cutloss + plan.take_profit_1) / 2;
      return { outcome: bar.open <= midpoint ? 'loss' : 'win', resolvedIdx: i };
    }
    if (hitCutloss) return { outcome: 'loss', resolvedIdx: i };
    if (hitTp) return { outcome: 'win', resolvedIdx: i };
  }
  return { outcome: 'unresolved', resolvedIdx: end - 1 };
}

async function backtestSymbol(code) {
  await setSymbol({ symbol: `IDX:${code}` });
  const { bars } = await getOhlcv({ count: 500 });
  if (!bars || bars.length < MIN_HISTORY_BARS + LOOKFORWARD_BARS) return [];

  const avgValTrx = avgValueTraded(bars, 50);
  if (avgValTrx < MIN_AVG_VALUE_TRX_50D) return []; // same liquidity gate as live screening

  const records = [];
  const lastUsableIdx = bars.length - 1 - LOOKFORWARD_BARS;
  // One open "position" per criterion at a time — the same underlying setup
  // (e.g. one wave-2 pullback) re-triggers on every subsequent green-candle
  // day until it resolves, since the pivots/pullback-low it's built on barely
  // change day to day. Counting each of those re-triggers as an independent
  // signal was massively inflating N and — because a losing setup keeps
  // re-firing right up until the day it actually breaks down — was skewing
  // the win rate down (many near-duplicate "losses" for one real trade).
  // A new signal for a given criterion only counts once any prior one has
  // resolved (won, lost, or expired unresolved).
  const busyUntil = new Map(); // criterion -> bar index its last open trade resolves at

  for (let t = MIN_HISTORY_BARS; t <= lastUsableIdx; t++) {
    const asOfBars = bars.slice(0, t + 1);
    const matches = runDetectorsAsOf(asOfBars);
    for (const m of matches) {
      if ((busyUntil.get(m.criterion) ?? -1) >= t) continue; // still holding a prior trade for this criterion
      const { outcome, resolvedIdx } = resolveOutcome(bars, t, m.plan);
      busyUntil.set(m.criterion, resolvedIdx);
      records.push({ symbol: code, criterion: m.criterion, date: bars[t].time, outcome });
    }
  }
  return records;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const codes = loadSymbols(args);
  const startedAt = Date.now();

  console.log(`Backtesting ${codes.length} symbols over up to ~${500 - MIN_HISTORY_BARS - LOOKFORWARD_BARS} historical as-of days each...`);

  const allRecords = [];
  const errors = [];

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    try {
      const records = await backtestSymbol(code);
      allRecords.push(...records);
    } catch (err) {
      errors.push({ symbol: code, error: err.message });
    }

    if ((i + 1) % 10 === 0 || i === codes.length - 1) {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`[${i + 1}/${codes.length}] elapsed=${elapsedSec}s signals_so_far=${allRecords.length} errors_so_far=${errors.length}`);
    }
  }

  // Aggregate per criterion.
  const byCriterion = new Map();
  for (const r of allRecords) {
    if (!byCriterion.has(r.criterion)) byCriterion.set(r.criterion, { win: 0, loss: 0, unresolved: 0 });
    byCriterion.get(r.criterion)[r.outcome]++;
  }

  const perCriterion = [...byCriterion.entries()].map(([criterion, c]) => {
    const resolved = c.win + c.loss;
    return {
      criterion,
      total_signals: c.win + c.loss + c.unresolved,
      resolved,
      win: c.win,
      loss: c.loss,
      unresolved: c.unresolved,
      win_rate_pct: resolved > 0 ? Math.round((c.win / resolved) * 1000) / 10 : null,
    };
  }).sort((a, b) => b.total_signals - a.total_signals);

  const totalResolved = perCriterion.reduce((s, c) => s + c.resolved, 0);
  const totalWins = perCriterion.reduce((s, c) => s + c.win, 0);

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = {
    generated_at: new Date().toISOString(),
    symbols_tested: codes.length,
    lookforward_bars: LOOKFORWARD_BARS,
    min_history_bars: MIN_HISTORY_BARS,
    total_errors: errors.length,
    elapsed_seconds: Number(elapsedSec),
    overall_win_rate_pct: totalResolved > 0 ? Math.round((totalWins / totalResolved) * 1000) / 10 : null,
    overall_resolved_signals: totalResolved,
    per_criterion: perCriterion,
    errors,
  };

  mkdirSync(join(__dirname, 'results'), { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const jsonPath = join(__dirname, 'results', `backtest-${dateStr}.json`);
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  console.log(`\nDone. ${allRecords.length} total historical signals across ${codes.length} symbols. Elapsed ${elapsedSec}s.`);
  console.log(`Overall win rate: ${summary.overall_win_rate_pct}% (${totalWins}/${totalResolved} resolved signals)`);
  console.log('\nPer criterion:');
  for (const c of perCriterion) {
    console.log(`  ${c.criterion}: ${c.win_rate_pct}% win rate (${c.win}W/${c.loss}L, ${c.unresolved} unresolved, ${c.total_signals} total)`);
  }
  console.log(`\nReport: ${jsonPath}`);
}

main()
  .catch(err => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await disconnect(); } catch { /* already gone */ }
  });
