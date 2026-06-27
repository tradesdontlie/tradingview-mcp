#!/usr/bin/env node
/**
 * Regime Agent — MNQ / MGC ranging vs trending, time-comparison display
 *
 * Run: node strategies/regime-agent.js [--interval 1000] [--symbols MNQ,MGC]
 *
 * Display: NOW | −1 min | −5 min | −10 min (one column per time snapshot)
 * Polling: every ~1s, but screen only redraws when something changes
 */

import { analyzeRegime } from '../src/core/regime.js';
import { parseArgs } from 'node:util';

const { values: argv } = parseArgs({
  options: {
    interval: { type: 'string', short: 'i', default: '1000' },
    symbols:  { type: 'string', short: 's', default: '' },
  },
  strict: false,
});

const INTERVAL    = Math.max(300, Number(argv.interval) || 1000);
const FILTER_SYMS = argv.symbols ? argv.symbols.split(',').map(s => s.trim().toUpperCase()) : [];

// Time offsets to compare against (seconds)
const TIME_COLS = [
  { label: 'NOW',   offset: 0 },
  { label: '−1 m',  offset: 60 },
  { label: '−5 m',  offset: 300 },
  { label: '−10 m', offset: 600 },
];

// ── ANSI ─────────────────────────────────────────────────────────────────────
const R   = '\x1b[0m';
const B   = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m'; const GRN = '\x1b[32m'; const YEL = '\x1b[33m';
const CYN = '\x1b[36m'; const MAG = '\x1b[35m';
const BG_MAG = '\x1b[45m'; const BG_CYN = '\x1b[46m'; const BG_YEL = '\x1b[43m';

function lj(s, n) {
  // strip ANSI codes for length calculation
  const raw = String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, n - raw.length);
  return String(s) + ' '.repeat(pad);
}
function fmt(n, dec) {
  if (n == null) return '--';
  dec = dec != null ? dec : 2;
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function ts() { return new Date().toLocaleTimeString('en-US', { hour12: false }); }
function hhmm(unixMs) {
  return new Date(unixMs).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

// ── History buffer ────────────────────────────────────────────────────────────
// Stores { ts: Date.now(), panes: [...] } snapshots for the last 12 minutes
const MAX_HISTORY_MS = 12 * 60 * 1000;
const history = [];  // newest last

function pushHistory(result) {
  history.push({ ts: result.ts || Date.now(), panes: result.panes });
  // prune old entries
  const cutoff = Date.now() - MAX_HISTORY_MS;
  while (history.length > 0 && history[0].ts < cutoff) history.shift();
}

// Find snapshot closest to (now - offsetSec * 1000)
function snapshotAt(offsetSec) {
  if (history.length === 0) return null;
  const target = Date.now() - offsetSec * 1000;
  let best = null, bestDelta = Infinity;
  for (const h of history) {
    const d = Math.abs(h.ts - target);
    if (d < bestDelta) { bestDelta = d; best = h; }
  }
  return best;
}

// Find pane by symbol substring from a snapshot
function findPane(snapshot, sym) {
  if (!snapshot) return null;
  return snapshot.panes.find(p => (p.symbol || '').toUpperCase().includes(sym.toUpperCase())) || null;
}

// ── Formatting helpers ────────────────────────────────────────────────────────
const COL_W = 14;  // width of each time column

function regimeStr(p) {
  if (!p || p.error) return DIM + 'no data' + R;
  if (p.regime === 'TRENDING') {
    const arrow = p.trendDir === 'UP' ? '↑' : p.trendDir === 'DOWN' ? '↓' : '';
    return BG_CYN + B + ' TREND' + arrow + ' ' + R;
  }
  if (p.regime === 'RANGING')       return BG_MAG + B + ' RANGE  ' + R;
  if (p.regime === 'TRANSITIONING') return BG_YEL + B + ' MIXED  ' + R;
  return '--';
}

function confStr(p) {
  if (!p || p.error) return DIM + '--' + R;
  const c = p.confidence;
  const col = c >= 75 ? B : c >= 55 ? '' : DIM;
  return col + c + '%' + R;
}

function scoreStr(p) {
  if (!p || p.error) return DIM + '--' + R;
  const s = p.adjustedScore;
  const col = s >= 62 ? CYN : s <= 35 ? MAG : YEL;
  return col + s + '/100' + R;
}

function bosStr(p) {
  if (!p || p.error) return DIM + '--' + R;
  const st = p.layers.structure;
  if (st.bos === 'up')   return GRN + 'BOS ↑' + R;
  if (st.bos === 'down') return RED + 'BOS ↓' + R;
  if (st.choch)          return YEL + 'CHoCH' + R;
  return DIM + 'no BOS' + R;
}

function seqStr(p) {
  if (!p || p.error) return DIM + '--' + R;
  const t = p.layers.structure.priorTrend;
  if (t === 'up')   return GRN + 'HH-HL ↑' + R;
  if (t === 'down') return RED + 'LH-LL ↓' + R;
  return DIM + 'mixed' + R;
}

function atrStr(p) {
  if (!p || p.error) return DIM + '--' + R;
  const r = p.layers.priceAction.atrRatio;
  if (r == null) return DIM + '--' + R;
  const col = r > 1.3 ? CYN : r < 0.85 ? MAG : '';
  return col + r.toFixed(2) + R;
}

function bodyStr(p) {
  if (!p || p.error) return DIM + '--' + R;
  const b = p.layers.priceAction.bodyRatio;
  if (b == null) return DIM + '--' + R;
  const col = b > 0.55 ? GRN : b < 0.35 ? RED : '';
  return col + b.toFixed(2) + R;
}

function vwapStr(p) {
  if (!p || p.error) return DIM + '--' + R;
  const d = p.layers.priceAction.vwapDev;
  if (d == null) return DIM + 'n/a' + R;
  const col = d > 0.5 ? CYN : d < 0.2 ? MAG : '';
  return col + d.toFixed(2) + '%' + R;
}

function volStr(p) {
  if (!p || p.error) return DIM + '--' + R;
  const v = p.layers.volume.ratio;
  if (v == null) return DIM + '--' + R;
  const col = v > 1.3 ? GRN : v < 0.7 ? DIM : '';
  return col + v.toFixed(2) + R;
}

function weeklyVolStr(p) {
  if (!p || p.error) return DIM + '--' + R;
  const v = p.layers.volume.weeklyRatio;
  if (v == null) return DIM + 'n/a' + R;
  const col = v > 1.4 ? GRN : v < 0.7 ? DIM : '';
  return col + v.toFixed(2) + 'x' + R;
}

function actionStr(p) {
  if (!p || p.error || !p.tradeBias) return DIM + '--' + R;
  const tb = p.tradeBias;
  const arrow = tb.direction === 'UP' ? '↑' : tb.direction === 'DOWN' ? '↓' : '';
  if (tb.action === 'CONTINUE') {
    const col = tb.strength === 'STRONG' ? GRN : tb.strength === 'WEAK' ? DIM : '';
    return col + B + 'CONTINUE' + arrow + R + ' ' + DIM + tb.strength + R;
  }
  if (tb.action === 'FADE') {
    const col = tb.strength === 'STRONG' ? RED : tb.strength === 'WEAK' ? DIM : YEL;
    return col + B + 'FADE' + arrow + R + ' ' + DIM + tb.strength + R;
  }
  return DIM + 'WAIT' + R;
}

function actionReasonStr(p) {
  if (!p || p.error || !p.tradeBias) return DIM + '--' + R;
  return DIM + p.tradeBias.reason + R;
}

function priceStr(p) {
  if (!p || p.error) return DIM + '--' + R;
  return fmt(p.close);
}

function reversalStr(p) {
  if (!p || p.error || !p.reversal) return DIM + '--' + R;
  const rv = p.reversal;
  if (!rv.probability) return DIM + 'none' + R;
  const dir   = rv.direction === 'UP' ? GRN + '↑' + R : rv.direction === 'DOWN' ? RED + '↓' + R : '';
  const prob  = rv.probability === 'HIGH'   ? RED   + B + 'HIGH'   + R :
                rv.probability === 'MEDIUM' ? YEL   + B + 'MED'    + R :
                                              DIM    +    'LOW'     + R;
  return prob + ' ' + dir;
}

function reversalTriggersStr(p) {
  if (!p || p.error || !p.reversal || !p.reversal.triggers.length) return DIM + '--' + R;
  return DIM + p.reversal.triggers.join(',') + R;
}

// ── Render ────────────────────────────────────────────────────────────────────

// One block per symbol: rows = metrics, cols = time snapshots
function renderBlock(sym, panes, snapshots) {
  // panes[i] is the pane data for TIME_COLS[i] (or null)
  // snapshots[i] is the raw snapshot object with .ts
  const lines = [];
  const LABEL_W = 12;

  // symbol header — show actual wall-clock time of each snapshot
  const symHeader = B + sym + R;
  const colHeaders = TIME_COLS.map((tc, i) => {
    const snap = snapshots[i];
    const label = snap ? hhmm(snap.ts) : tc.label;
    return lj(DIM + label + R, COL_W);
  }).join('  ');
  lines.push(lj(symHeader, LABEL_W + 2) + colHeaders);

  // row helper
  function row(label, fn) {
    const vals = panes.map(p => lj(fn(p), COL_W)).join('  ');
    lines.push(lj(DIM + label + R, LABEL_W + 6) + vals);  // +6 for DIM/R bytes
  }

  lines.push(DIM + '─'.repeat(LABEL_W + 2 + (COL_W + 2) * TIME_COLS.length) + R);
  row('Regime',    regimeStr);
  row('Conf',      confStr);
  row('Score',     scoreStr);
  lines.push(DIM + '·'.repeat(LABEL_W + 2 + (COL_W + 2) * TIME_COLS.length) + R);
  row('Structure', bosStr);
  row('Sequence',  seqStr);
  row('ATR ratio', atrStr);
  row('Body/Wick', bodyStr);
  row('VWAP dev',  vwapStr);
  row('Vol ratio', volStr);
  row('Wk-hr Vol', weeklyVolStr);
  lines.push(DIM + '·'.repeat(LABEL_W + 2 + (COL_W + 2) * TIME_COLS.length) + R);
  row('Price',     priceStr);
  lines.push(DIM + '·'.repeat(LABEL_W + 2 + (COL_W + 2) * TIME_COLS.length) + R);
  row('Reversal',  reversalStr);
  row('  Triggers',reversalTriggersStr);
  lines.push(DIM + '·'.repeat(LABEL_W + 2 + (COL_W + 2) * TIME_COLS.length) + R);
  row('Action',    actionStr);
  row('  Reason',   actionReasonStr);

  return lines;
}

function render(symbols) {
  const snapshots = TIME_COLS.map(tc => snapshotAt(tc.offset));
  const lines = [];

  // Header
  const hdr = B + 'REGIME AGENT' + R + DIM + '  ' + ts() +
    '  session ' + (snapshots[0]?.panes?.[0]?.session || '?') +
    '  poll ' + INTERVAL + 'ms' + R;
  lines.push(hdr);
  lines.push('');

  for (const sym of symbols) {
    const panes = snapshots.map(snap => snap ? findPane(snap, sym) : null);
    lines.push(...renderBlock(sym, panes, snapshots));
    lines.push('');
  }

  // State change history at the bottom
  if (stateLog.length > 0) {
    lines.push(DIM + 'Regime changes:' + R);
    for (const entry of stateLog) lines.push('  ' + entry);
  }

  // Clear screen and redraw from top
  process.stdout.write('\x1b[2J\x1b[0;0H');
  process.stdout.write(lines.join('\n') + '\n');
}

// ── State change log ──────────────────────────────────────────────────────────
const prevStates = {};
const stateLog = [];  // last 8 regime transitions, shown at bottom of display

function checkStateChanges(panes) {
  for (const p of panes) {
    if (!p || p.error) continue;
    const sym = p.symbol;
    const cur = p.regime + ':' + (p.trendDir || '');
    if (prevStates[sym] && prevStates[sym] !== cur) {
      const was = prevStates[sym].split(':')[0];
      const now = regimeStr(p);
      stateLog.push(
        DIM + ts() + R + '  ' + B + (p.symbol || sym) + R +
        '  ' + DIM + was + R + ' → ' + now +
        '  conf ' + p.confidence + '%  score ' + p.adjustedScore
      );
      if (stateLog.length > 8) stateLog.shift();
    }
    prevStates[sym] = cur;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
function shutdown() {
  process.stdout.write('\nStopped.\n');
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

process.stderr.write(
  '\x1b[2m⚠  tradingview-mcp  |  Not affiliated with TradingView Inc.\n' +
  '   Use subject to TradingView Terms of Use.\x1b[0m\n\n'
);

// Determine which symbols to show
const displaySymbols = FILTER_SYMS.length ? FILTER_SYMS : ['MGC', 'MNQ'];

process.stdout.write(
  B + 'Regime Agent' + R + ' starting — ' + displaySymbols.join(' + ') +
  '  poll ' + INTERVAL + 'ms  (Ctrl+C to stop)\n\n'
);

let errors = 0;

async function tick() {
  let result;
  try {
    result = await analyzeRegime();
    errors = 0;
  } catch (err) {
    errors++;
    if (errors === 1 || errors % 20 === 0) {
      process.stdout.write('\x1b[K' + DIM + '[' + ts() + '] error: ' + err.message + R + '\n');
      renderedLines = 0;
    }
    return;
  }

  if (!result?.panes?.length) return;

  pushHistory(result);
  checkStateChanges(result.panes);
  render(displaySymbols);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async function loop() {
  while (true) {
    const t0 = Date.now();
    await tick();
    await sleep(Math.max(0, INTERVAL - (Date.now() - t0)));
  }
})();
