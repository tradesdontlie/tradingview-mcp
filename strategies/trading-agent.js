#!/usr/bin/env node
/**
 * Trading Agent — real-time regime detection + signal alerts
 *
 * Run: node strategies/trading-agent.js [--interval 1000]
 *
 * What it does:
 *   • Polls TradingView every ~1s via CDP (one JS eval per tick)
 *   • Detects regime: RANGING (ADX ≤ 25) vs TRENDING (ADX > 25)
 *   • Ranging signals:  LIQUIDITY_SWEEP_HIGH/LOW, VWAP_UPPER2/LOWER2
 *   • Trending signals: EMA9_TOUCH
 *   • Displays live status header + scrolling signal log
 */

import { analyzeChart } from '../src/core/agent.js';
import { parseArgs } from 'node:util';

// ── CLI args ──────────────────────────────────────────────────────────────────
const { values: argv } = parseArgs({
  options: {
    interval: { type: 'string',  short: 'i', default: '1000' },
    quiet:    { type: 'boolean', short: 'q', default: false  },
  },
  strict: false,
});
const INTERVAL = Math.max(200, Number(argv.interval) || 1000);

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const R = '\x1b[0m';
const B = '\x1b[1m';
const DIM = '\x1b[2m';
const RED     = '\x1b[31m';
const GREEN   = '\x1b[32m';
const YELLOW  = '\x1b[33m';
const CYAN    = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const WHITE   = '\x1b[37m';
const BG_RED  = '\x1b[41m';
const BG_GRN  = '\x1b[42m';
const BG_YEL  = '\x1b[43m';
const BG_CYN  = '\x1b[46m';

function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }
function fmt(n) { return n != null ? Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'N/A'; }
function ts() { return new Date().toLocaleTimeString('en-US', { hour12: false }); }
function barDate(unixSec) {
  if (!unixSec) return '--';
  return new Date(unixSec * 1000).toLocaleTimeString('en-US', { hour12: false });
}

// ── Status header (6 fixed lines, redrawn each tick) ─────────────────────────
const HEADER_LINES = 8;
let headerDrawn = false;

function drawHeader(d) {
  const regimeColor = d.regime === 'trending' ? CYAN : MAGENTA;
  const regimeLabel = d.regime === 'trending'
    ? `${CYAN}${B}◆ TRENDING${R}`
    : `${MAGENTA}${B}◇ RANGING${R}`;
  const adxStr = d.adx != null
    ? (d.adx > 25 ? `${CYAN}${d.adx}${R}` : `${MAGENTA}${d.adx}${R}`)
    : 'N/A';

  const vwapStr = d.vwap
    ? `${fmt(d.vwap.vwap)}  +2SD ${YELLOW}${fmt(d.vwap.upper2)}${R}  -2SD ${YELLOW}${fmt(d.vwap.lower2)}${R}`
    : `${DIM}(intraday only)${R}`;

  const ema9Str = d.ema9 != null ? fmt(d.ema9) : 'N/A';
  const swingStr = `H ${YELLOW}${fmt(d.swing_high)}${R}  L ${YELLOW}${fmt(d.swing_low)}${R}`;

  const lines = [
    `${DIM}${'─'.repeat(62)}${R}`,
    `  ${B}TRADING AGENT${R}  │  ${B}${d.symbol || '--'}${R}  │  ${d.resolution || '--'}m  │  ${ts()}`,
    `  Price ${B}${fmt(d.close)}${R}   H ${fmt(d.high)}  L ${fmt(d.low)}`,
    `  Regime ${regimeLabel}   ADX ${adxStr}   Bar ${barDate(d.bar_time)}`,
    `  EMA9  ${B}${ema9Str}${R}   Swing ${swingStr}`,
    `  VWAP  ${vwapStr}`,
    `${DIM}${'─'.repeat(62)}${R}`,
    '',
  ];

  if (headerDrawn) {
    // Move cursor up HEADER_LINES lines and overwrite
    process.stdout.write(`\x1b[${HEADER_LINES}A`);
  }
  process.stdout.write(lines.map(l => l + '\x1b[K\n').join(''));
  headerDrawn = true;
}

// ── Signal rendering ──────────────────────────────────────────────────────────
const SIGNAL_ICONS = {
  LIQUIDITY_SWEEP_HIGH: `${BG_RED}${B}  SWEEP HIGH  ${R}`,
  LIQUIDITY_SWEEP_LOW:  `${BG_GRN}${B}  SWEEP LOW   ${R}`,
  VWAP_UPPER2:          `${BG_YEL}${B}  VWAP +2SD   ${R}`,
  VWAP_LOWER2:          `${BG_YEL}${B}  VWAP -2SD   ${R}`,
  EMA9_TOUCH:           `${BG_CYN}${B}  EMA9 TOUCH  ${R}`,
};

const BIAS_COLOR = { LONG: GREEN, SHORT: RED };

function printSignal(sig) {
  const icon  = SIGNAL_ICONS[sig.type] || `${B}[SIGNAL]${R}`;
  const bias  = sig.bias ? `${BIAS_COLOR[sig.bias] || ''}${B}${sig.bias}${R}` : '';
  const entry = sig.entry != null ? `entry ${B}${fmt(sig.entry)}${R}` : '';
  const level = sig.level != null ? `level ${B}${fmt(sig.level)}${R}` : '';
  console.log(`${DIM}${ts()}${R}  ${icon}  ${bias}  ${entry}  ${level}`);
  console.log(`         ${sig.desc}`);
  console.log('');
}

// ── Dedup: don't re-fire the same signal type on the same bar ─────────────────
// Key: `${signal_type}:${bar_time}`
const fired = new Set();
const FIRED_TTL_MS = 60_000; // prune keys older than 1 min
let lastPrune = Date.now();

function pruneOldKeys() {
  if (Date.now() - lastPrune < FIRED_TTL_MS) return;
  lastPrune = Date.now();
  // bar_time is in unix seconds; prune keys where bar is older than 1 min
  const cutoff = Math.floor((Date.now() - FIRED_TTL_MS) / 1000);
  for (const k of fired) {
    const parts = k.split(':');
    const bt = Number(parts[1]);
    if (bt < cutoff) fired.delete(k);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
let errors = 0;

process.stderr.write(
  `\x1b[2m⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n` +
  `   Ensure your usage complies with TradingView's Terms of Use.\x1b[0m\n\n`
);

console.log(`${B}Trading Agent${R} starting… polling every ${INTERVAL}ms  (Ctrl+C to stop)\n`);

async function tick() {
  let data;
  try {
    data = await analyzeChart();
    errors = 0;
  } catch (err) {
    errors++;
    if (errors <= 3 || errors % 10 === 0) {
      // Print error below header without disturbing it
      process.stdout.write(`\x1b[K${DIM}[${ts()}] connection error (${errors}): ${err.message}${R}\n`);
    }
    return;
  }

  if (!data || data.error) {
    process.stdout.write(`\x1b[K${DIM}[${ts()}] ${data?.error || 'null result'}${R}\n`);
    return;
  }

  // Draw live status header
  drawHeader(data);

  // Process signals
  pruneOldKeys();
  for (const sig of (data.signals || [])) {
    const key = `${sig.type}:${sig.bar_time}`;
    if (!fired.has(key)) {
      fired.add(key);
      printSignal(sig);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let running = true;
function shutdown() {
  running = false;
  process.stdout.write('\nStopped.\n');
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

while (running) {
  const t0 = Date.now();
  await tick();
  const elapsed = Date.now() - t0;
  const wait = Math.max(0, INTERVAL - elapsed);
  if (running) await sleep(wait);
}

