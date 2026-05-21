/**
 * MTF Session Liquidity Trap Scalper — signal orchestrator.
 *
 * buildSignal() accepts pre-computed engine outputs and runs the 8-step
 * LONG/SHORT checklist from strategy.md to produce a structured signal object.
 *
 * runEngines() is the production helper that runs all five engines from raw
 * OHLCV data. Tests inject engine outputs directly via buildSignal().
 *
 * @module mtfSessionLiquidityTrap
 */

import { buildMtfBias }            from '../engines/biasEngine.js';
import { extractSessionLevels }    from '../engines/sessionEngine.js';
import { detectSweep, detectReclaim } from '../engines/liquidityEngine.js';
import { detectMss, findDisplacementCandle } from '../engines/structureEngine.js';
import { detectVolumeSurge }       from '../engines/volumeEngine.js';
import { scoreSetup }              from './confluenceScorer.js';

const TICK_SIZE = 0.25;   // MNQ and MES share the same 0.25 tick size
const DEFAULT_STOP_TICKS = 10;

/** @param {string} ts @param {string} symbol @returns {string} */
function makeId(ts, symbol) { return `${ts}-${symbol}`; }

/**
 * Constructs a WAIT signal with a rejection reason.
 * Used internally when any checklist step fails.
 *
 * @param {string} ts
 * @param {string} symbol
 * @param {object} biasResult
 * @param {string} reason
 * @param {string} whatWouldChange
 * @returns {object} SignalObject
 */
function makeWait(ts, symbol, biasResult, reason, whatWouldChange) {
  return {
    id:        makeId(ts, symbol),
    timestamp: ts,
    date:      ts.slice(0, 10),
    time:      ts.slice(11, 16),
    symbol,
    decision:  'WAIT',
    bias: {
      '4H':  biasResult?.['4H']  ?? 'unknown',
      '1H':  biasResult?.['1H']  ?? 'unknown',
      '15m': biasResult?.['15m'] ?? 'unknown',
      '5m':  biasResult?.['5m']  ?? 'unknown',
    },
    setup:      'MTF Session Liquidity Trap',
    entry:      null,
    stop:       null,
    tp1:        null,
    tp2:        null,
    r:          null,
    confidence: 'Reject',
    reasons:    [reason],
    invalidation: [],
    what_would_change: whatWouldChange,
    status:     'expired',
    outcome_r:  null,
  };
}

/**
 * Runs all five engines from raw OHLCV data.
 * Production use. Tests should call buildSignal() directly with injected outputs.
 *
 * @param {{ "4H": Array, "1H": Array, "15m": Array, "5m": Array }} ohlcvByTimeframe
 * @param {object} [sessionConfig]
 * @returns {object} engineOutputs suitable for buildSignal()
 */
export function runEngines(ohlcvByTimeframe, sessionConfig) {
  const biasResult = buildMtfBias(ohlcvByTimeframe);
  const bars5m     = ohlcvByTimeframe['5m'] ?? [];
  const sessionLevels = extractSessionLevels(bars5m, sessionConfig);

  const dir     = biasResult.permission;
  const sweepDir = dir === 'long' ? 'low' : (dir === 'short' ? 'high' : null);

  // Build candidate session levels in sweep direction order
  const candidates = [];
  if (sweepDir === 'low') {
    if (sessionLevels.asia.found)        candidates.push({ price: sessionLevels.asia.low,        dir: 'low' });
    if (sessionLevels.london.found)      candidates.push({ price: sessionLevels.london.low,      dir: 'low' });
    if (sessionLevels.nyOpenRange.found) candidates.push({ price: sessionLevels.nyOpenRange.low, dir: 'low' });
    if (sessionLevels.priorDay.found)    candidates.push({ price: sessionLevels.priorDay.low,    dir: 'low' });
  } else if (sweepDir === 'high') {
    if (sessionLevels.asia.found)        candidates.push({ price: sessionLevels.asia.high,        dir: 'high' });
    if (sessionLevels.london.found)      candidates.push({ price: sessionLevels.london.high,      dir: 'high' });
    if (sessionLevels.nyOpenRange.found) candidates.push({ price: sessionLevels.nyOpenRange.high, dir: 'high' });
    if (sessionLevels.priorDay.found)    candidates.push({ price: sessionLevels.priorDay.high,    dir: 'high' });
  }

  let sweepResult    = { swept: false, sweepBarIndex: null };
  let sweepLevel     = null;
  let sweepDirection = null;

  for (const cand of candidates) {
    const sr = detectSweep(bars5m, cand.price, cand.dir);
    if (sr.swept) { sweepResult = sr; sweepLevel = cand.price; sweepDirection = cand.dir; break; }
  }

  const reclaimResult = sweepResult.swept
    ? detectReclaim(bars5m, sweepResult.sweepBarIndex, sweepLevel, sweepDirection)
    : { reclaimed: false, reclaimBarIndex: null, candlesToReclaim: null };

  const mssDir = sweepDirection === 'low' ? 'bullish' : 'bearish';
  const mssResult = sweepResult.swept
    ? detectMss(bars5m, sweepResult.sweepBarIndex, mssDir)
    : { detected: false, mssBarIndex: null };

  const afterIdx        = sweepResult.swept ? sweepResult.sweepBarIndex : 0;
  const displacementCandle = findDisplacementCandle(bars5m, afterIdx);
  const lastIdx         = bars5m.length - 1;
  const volumeResult    = lastIdx >= 0 ? detectVolumeSurge(bars5m, lastIdx) : { surge: false, ratio: 0 };

  return { biasResult, sessionLevels, sweepResult, sweepLevel, sweepDirection,
           reclaimResult, mssResult, displacementCandle, volumeResult };
}

/**
 * Runs the 8-step checklist and returns a structured signal object.
 *
 * Accepts pre-computed engine outputs so tests can inject specific scenarios
 * without requiring a live TradingView connection.
 *
 * @param {{ symbol: string,
 *            engineOutputs: object,
 *            rules: object,
 *            timestamp?: string }} params
 * @returns {object} SignalObject
 */
export function buildSignal({ symbol, engineOutputs, rules, timestamp }) {
  const ts = timestamp ?? new Date().toISOString();
  const { biasResult, sessionLevels, sweepResult, sweepLevel, sweepDirection,
          reclaimResult, mssResult, displacementCandle, volumeResult } = engineOutputs;

  const w = (reason, fix) => makeWait(ts, symbol, biasResult, reason, fix);

  // ── Step 1: directional permission ────────────────────────────────────────
  if (!biasResult || biasResult.permission === 'none') {
    return w('HTF bias conflict — no directional permission',
             '4H and 1H must agree on direction before any setup is valid');
  }

  // ── Step 2: sweep ─────────────────────────────────────────────────────────
  if (!sweepResult?.swept) {
    return w('No session level sweep detected',
             'Wait for price to wick through Asia/London/NY/PDH/PDL level');
  }

  // ── Step 3: reclaim ───────────────────────────────────────────────────────
  if (!reclaimResult?.reclaimed) {
    return w('Sweep detected but reclaim failed',
             'Price must close back above swept low (LONG) within 5 candles');
  }

  // ── Step 4: MSS ───────────────────────────────────────────────────────────
  if (!mssResult?.detected) {
    return w('No 5m MSS/CHoCH confirmed after reclaim',
             'Need higher high (bullish) or lower low (bearish) on 5m to confirm control shift');
  }

  // ── Step 5: displacement ─────────────────────────────────────────────────
  if (!displacementCandle) {
    return w('No displacement candle detected',
             'Need strong-body, above-average-volume candle in signal direction');
  }

  // ── Step 6: confluence score ──────────────────────────────────────────────
  const dir = biasResult.permission;
  const h4  = biasResult['4H'] ?? 'neutral';
  const h1  = biasResult['1H'] ?? 'neutral';
  const h15 = biasResult['15m'] ?? 'neutral';
  const dirBias = dir === 'long' ? 'bullish' : 'bearish';

  const allThreeHtfAligned =
    (h4  === dirBias || h4  === 'neutral') &&
    (h1  === dirBias || h1  === 'neutral') &&
    (h15 === dirBias || h15 === 'neutral');

  const { grade, factors, missing } = scoreSetup({
    biasResult, sweepResult, reclaimResult, mssResult,
    displacementCandle, volumeResult, allThreeHtfAligned,
  });

  if (grade === 'Reject' || grade === 'C') {
    return w(`Setup grade ${grade} — below execution threshold`, missing.join(', ') || 'review confluence factors');
  }

  // ── Step 7: compute entry / stop / TP proxies ────────────────────────────
  const decision = sweepDirection === 'low' ? 'LONG' : 'SHORT';
  const entry    = sweepLevel;
  const stop     = decision === 'LONG'
    ? +(entry - DEFAULT_STOP_TICKS * TICK_SIZE).toFixed(2)
    : +(entry + DEFAULT_STOP_TICKS * TICK_SIZE).toFixed(2);

  // TP1: nearest session level beyond entry in signal direction
  let tp1 = null;
  const sl = sessionLevels;
  if (decision === 'LONG') {
    const cands = [sl?.asia?.high, sl?.london?.high, sl?.nyOpenRange?.high, sl?.priorDay?.high]
      .filter(p => p != null && p > entry);
    tp1 = cands.length ? +(Math.min(...cands)).toFixed(2) : +(entry + DEFAULT_STOP_TICKS * TICK_SIZE * 3).toFixed(2);
  } else {
    const cands = [sl?.asia?.low, sl?.london?.low, sl?.nyOpenRange?.low, sl?.priorDay?.low]
      .filter(p => p != null && p < entry);
    tp1 = cands.length ? +(Math.max(...cands)).toFixed(2) : +(entry - DEFAULT_STOP_TICKS * TICK_SIZE * 3).toFixed(2);
  }

  const rr = tp1 !== null
    ? +(Math.abs(tp1 - entry) / Math.abs(entry - stop)).toFixed(2)
    : null;

  // ── Step 8: assemble signal ───────────────────────────────────────────────
  const expiry = rules?.risk?.signal_expiry_candles ?? 3;
  const reasons = [
    `MTF bias: 4H=${h4} | 1H=${h1} | 15m=${h15}`,
    `Session sweep: ${sweepDirection} level at ${sweepLevel}`,
    `Reclaim: confirmed in ${reclaimResult.candlesToReclaim} candle(s)`,
    `MSS: confirmed at bar index ${mssResult.mssBarIndex}`,
    `Volume: ${volumeResult?.surge ? `surge ${volumeResult.ratio}x avg` : 'no surge detected'}`,
    ...factors,
  ];

  return {
    id:        makeId(ts, symbol),
    timestamp: ts,
    date:      ts.slice(0, 10),
    time:      ts.slice(11, 16),
    symbol,
    decision,
    bias:      { '4H': h4, '1H': h1, '15m': h15, '5m': biasResult['5m'] ?? 'neutral' },
    setup:     'MTF Session Liquidity Trap',
    entry,
    stop,
    tp1,
    tp2:       null,
    r:         rr,
    confidence: grade,
    reasons,
    invalidation: [
      `Close back ${sweepDirection === 'low' ? 'below' : 'above'} swept level ${sweepLevel}`,
      `Setup expires after ${expiry} candles without entry fill`,
    ],
    what_would_change: missing.length ? `Still needs: ${missing.join(', ')}` : 'All confirmations present',
    status:    'pending',
    outcome_r: null,
  };
}

/**
 * Marks a pending signal as expired if it has not been filled within the candle window.
 *
 * @param {object} signal - SignalObject with status "pending"
 * @param {number} barsSinceTrigger - candles elapsed since signal was issued
 * @param {number} [window=3] - expiry window (rules.risk.signal_expiry_candles)
 * @returns {object} signal with status updated to "expired" if applicable
 */
export function checkExpiry(signal, barsSinceTrigger, window = 3) {
  if (signal.status === 'pending' && barsSinceTrigger > window) {
    return { ...signal, status: 'expired' };
  }
  return signal;
}
