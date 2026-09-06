/**
 * IHSG technical screener.
 *
 * Connects once to the already-running TradingView Desktop (via the same
 * CDP connection the tv CLI / MCP server uses), loops through every symbol
 * in idx_all.csv, pulls daily OHLCV, and runs it through the detectors in
 * ./lib. Symbols with at least one match are written to a JSON + Markdown
 * report under ./results.
 *
 * Usage:
 *   node screener/scan.js                # full IHSG universe
 *   node screener/scan.js --limit 10      # first 10 symbols only (smoke test)
 *   node screener/scan.js --symbols BBCA,BBRI,TLKM
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSymbol } from '../src/core/chart.js';
import { getOhlcv } from '../src/core/data.js';
import { disconnect } from '../src/connection.js';

import { findPivots, avgValueTraded } from './lib/zigzag.js';
import { findSrZones, nearestResistanceAbove, nearestSupportBelow } from './lib/support_resistance.js';
import { detectDowntrendBreak } from './lib/trendline.js';
import { detectElliottImpulse, detectElliottWave2Support, detectPullbackReversal } from './lib/elliott.js';
import { detectAllPatterns } from './lib/patterns.js';
import { detectBreakoutWithVolume, detectVolumeSpikeGreenCandle, detectConfirmedUptrend } from './lib/volume.js';
import { buildTradingPlan } from './lib/levels.js';
import { generateExcel } from './excel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Liquidity gate: skip anything whose average daily transaction value over
// the last 50 trading days is too thin. Sized off a Rp 20 juta order — a
// position that size should stay at ~2% of average daily value or less, so
// it doesn't move the price against itself or get stuck unable to exit.
// Rp 20.000.000 / 0.02 = Rp 1.000.000.000.
const MIN_AVG_VALUE_TRX_50D = 1_000_000_000; // Rp 1 miliar

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
  const lines = csv.trim().split('\n').slice(1); // skip header
  let codes = lines.map(l => l.split(',')[0].trim()).filter(Boolean);
  if (limit) codes = codes.slice(0, limit);
  return codes;
}

async function analyzeSymbol(code) {
  const symbol = `IDX:${code}`;
  await setSymbol({ symbol });
  const { bars } = await getOhlcv({ count: 500 });
  if (!bars || bars.length < 60) {
    return { symbol: code, skipped: true, reason: 'not_enough_bars' };
  }

  const avgValTrx = avgValueTraded(bars, 50);
  if (avgValTrx < MIN_AVG_VALUE_TRX_50D) {
    return { symbol: code, skipped: true, reason: 'illiquid', avg_value_trx_50d: Math.round(avgValTrx) };
  }

  const pivots = findPivots(bars, 0.04);
  const srZones = findSrZones(pivots);
  const lastClose = bars[bars.length - 1].close;

  const matches = [];
  // buildTradingPlan() returns null for a stale/already-extended setup (target
  // already behind price, or the entry reference too far below it) — only
  // push a match when a valid, actionable plan actually comes back.
  const tryAdd = (criterion, detail) => {
    if (!detail) return;
    const plan = buildTradingPlan(criterion, detail, bars, srZones);
    if (!plan) return;
    matches.push({ criterion, detail, plan });
  };

  tryAdd('downtrend_break', detectDowntrendBreak(bars, pivots));

  tryAdd('elliott_wave', detectElliottImpulse(bars, pivots));
  tryAdd('elliott_wave2', detectElliottWave2Support(bars, pivots));
  tryAdd('pullback_reversal', detectPullbackReversal(bars, pivots));

  for (const pattern of detectAllPatterns(bars, pivots)) {
    tryAdd(pattern.pattern, pattern);
  }

  tryAdd('breakout_resistance_with_volume', detectBreakoutWithVolume(bars, srZones));
  tryAdd('volume_spike_green_candle', detectVolumeSpikeGreenCandle(bars));
  tryAdd('confirmed_uptrend', detectConfirmedUptrend(bars, pivots));

  if (matches.length === 0) return { symbol: code, skipped: false, matches: [] };

  return {
    symbol: code,
    skipped: false,
    last_close: lastClose,
    nearest_resistance: nearestResistanceAbove(srZones, lastClose)?.price ?? null,
    nearest_support: nearestSupportBelow(srZones, lastClose)?.price ?? null,
    matches,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const codes = loadSymbols(args);
  const startedAt = Date.now();

  console.log(`Screening ${codes.length} IHSG symbols...`);

  const results = [];
  const errors = [];
  let skippedIlliquid = 0;

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    try {
      const result = await analyzeSymbol(code);
      if (result.skipped && result.reason === 'illiquid') skippedIlliquid++;
      if (!result.skipped && result.matches.length > 0) results.push(result);
    } catch (err) {
      errors.push({ symbol: code, error: err.message });
    }

    if ((i + 1) % 25 === 0 || i === codes.length - 1) {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`[${i + 1}/${codes.length}] elapsed=${elapsedSec}s matches_so_far=${results.length} errors_so_far=${errors.length}`);
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = {
    generated_at: new Date().toISOString(),
    total_scanned: codes.length,
    total_matches: results.length,
    total_errors: errors.length,
    total_skipped_illiquid: skippedIlliquid,
    min_avg_value_trx_50d: MIN_AVG_VALUE_TRX_50D,
    elapsed_seconds: Number(elapsedSec),
    results,
    errors,
  };

  mkdirSync(join(__dirname, 'results'), { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const jsonPath = join(__dirname, 'results', `scan-${dateStr}.json`);
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  const excelPath = join(__dirname, 'results', `scan-${dateStr}.xlsx`);
  await generateExcel(summary, excelPath);

  console.log(`\nDone. ${results.length}/${codes.length} symbols matched at least one criterion. ${errors.length} errors. Elapsed ${elapsedSec}s.`);
  console.log(`Report (JSON): ${jsonPath}`);
  console.log(`Report (Excel): ${excelPath}`);
}

main()
  .catch(err => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The CDP WebSocket (chrome-remote-interface) keeps its own connection
    // alive and never unrefs it, so without an explicit disconnect() the
    // event loop never empties and this process hangs forever after
    // printing "Done" — fine when run by hand (Ctrl+C ends it), but fatal
    // for the scheduled daily run: execFileSync in daily.js would block
    // waiting for a child that never exits.
    try { await disconnect(); } catch { /* already gone */ }
});
