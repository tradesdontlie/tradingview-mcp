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
import { detectLatestSweep, detectReclaim } from '../engines/liquidityEngine.js';
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
 * Phase 3B: uses detectLatestSweep so only the most recent sweep within the
 * setup window is considered. Checks for newer opposite-direction sweeps that
 * invalidate the current setup. Computes bar freshness when nowMs is supplied.
 *
 * @param {{ "4H": Array, "1H": Array, "15m": Array, "5m": Array }} ohlcvByTimeframe
 * @param {object} [sessionConfig]
 * @param {object} [rules]   - parsed rules.json; used for setup window / reclaim window
 * @param {number} [nowMs]   - current wall-clock ms; when supplied, bar freshness is checked
 * @returns {object} engineOutputs suitable for buildSignal()
 */
export function runEngines(ohlcvByTimeframe, sessionConfig, rules, nowMs) {
  const biasResult = buildMtfBias(ohlcvByTimeframe);
  const bars5m     = ohlcvByTimeframe['5m']  ?? [];
  const bars15m    = ohlcvByTimeframe['15m'] ?? [];
  const sessionLevels = extractSessionLevels(bars5m, sessionConfig);

  const dir         = biasResult.permission;
  const sweepDir    = dir === 'long' ? 'low' : (dir === 'short' ? 'high' : null);
  const setupWindow = rules?.risk?.setup_window_bars_5m ?? 12;
  const reclaimWindow =
    (dir === 'long'  ? rules?.setup_requirements?.long?.reclaim_candle_window  : null) ??
    (dir === 'short' ? rules?.setup_requirements?.short?.reclaim_candle_window : null) ??
    rules?.risk?.reclaim_window_candles ?? 5;

  // Build same-direction session level candidates
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

  // Pick the LATEST eligible sweep across all candidates (highest sweepBarIndex)
  let sweepResult    = { swept: false, sweepBarIndex: null };
  let sweepLevel     = null;
  let sweepDirection = null;

  for (const cand of candidates) {
    const sr = detectLatestSweep(bars5m, cand.price, cand.dir, 0, setupWindow);
    if (sr.swept && (sweepResult.sweepBarIndex === null || sr.sweepBarIndex > sweepResult.sweepBarIndex)) {
      sweepResult    = sr;
      sweepLevel     = cand.price;
      sweepDirection = cand.dir;
    }
  }

  // Check for a newer opposite-direction sweep that invalidates the current setup
  const oppDir = sweepDir === 'low' ? 'high' : (sweepDir === 'high' ? 'low' : null);
  let oppositeInvalidated = false;

  if (sweepResult.swept && oppDir) {
    const oppCandidates = [];
    if (oppDir === 'high') {
      if (sessionLevels.asia.found)        oppCandidates.push({ price: sessionLevels.asia.high,        dir: 'high' });
      if (sessionLevels.london.found)      oppCandidates.push({ price: sessionLevels.london.high,      dir: 'high' });
      if (sessionLevels.nyOpenRange.found) oppCandidates.push({ price: sessionLevels.nyOpenRange.high, dir: 'high' });
      if (sessionLevels.priorDay.found)    oppCandidates.push({ price: sessionLevels.priorDay.high,    dir: 'high' });
    } else {
      if (sessionLevels.asia.found)        oppCandidates.push({ price: sessionLevels.asia.low,        dir: 'low' });
      if (sessionLevels.london.found)      oppCandidates.push({ price: sessionLevels.london.low,      dir: 'low' });
      if (sessionLevels.nyOpenRange.found) oppCandidates.push({ price: sessionLevels.nyOpenRange.low, dir: 'low' });
      if (sessionLevels.priorDay.found)    oppCandidates.push({ price: sessionLevels.priorDay.low,    dir: 'low' });
    }
    for (const cand of oppCandidates) {
      const sr = detectLatestSweep(bars5m, cand.price, cand.dir, 0, setupWindow);
      if (sr.swept && sr.sweepBarIndex > sweepResult.sweepBarIndex) {
        oppositeInvalidated = true;
        break;
      }
    }
  }

  const reclaimResult = sweepResult.swept
    ? detectReclaim(bars5m, sweepResult.sweepBarIndex, sweepLevel, sweepDirection, reclaimWindow)
    : { reclaimed: false, reclaimBarIndex: null, candlesToReclaim: null };

  // MSS requires confirmed reclaim; search starts strictly after reclaimBarIndex.
  // When reclaim is not confirmed, do not search for MSS at all.
  const mssDir    = sweepDirection === 'low' ? 'bullish' : 'bearish';
  const mssResult = (sweepResult.swept && reclaimResult.reclaimed)
    ? detectMss(bars5m, reclaimResult.reclaimBarIndex, mssDir)
    : { detected: false, mssBarIndex: null };

  // Displacement must start at or after the MSS bar; skip entirely when MSS not confirmed
  const dispAfterIdx       = mssResult.detected ? mssResult.mssBarIndex : -1;
  const displacementCandle = dispAfterIdx >= 0 ? findDisplacementCandle(bars5m, dispAfterIdx) : null;
  const lastIdx            = bars5m.length - 1;
  const volumeResult       = lastIdx >= 0 ? detectVolumeSurge(bars5m, lastIdx) : { surge: false, ratio: 0 };

  // Setup recency metadata
  const latestBarIndex  = lastIdx >= 0 ? lastIdx : null;
  const setupAgeBars    = (sweepResult.swept && latestBarIndex !== null)
    ? latestBarIndex - sweepResult.sweepBarIndex
    : null;
  const setupRecencyValid = sweepResult.swept
    ? (setupAgeBars !== null && setupAgeBars <= setupWindow)
    : false;

  // Bar freshness — only checked when nowMs is provided (omitted in offline tests)
  let barFreshnessReason = null;
  if (nowMs != null) {
    if (bars5m.length > 0) {
      const ts5m = bars5m[bars5m.length - 1].ts;
      if (ts5m && ts5m > 0 && nowMs - ts5m > 10 * 60 * 1000) {
        barFreshnessReason = `5m bar data stale: latest bar is ${Math.round((nowMs - ts5m) / 60000)}m old`;
      }
    }
    if (!barFreshnessReason && bars15m.length > 0) {
      const ts15m = bars15m[bars15m.length - 1].ts;
      if (ts15m && ts15m > 0 && nowMs - ts15m > 25 * 60 * 1000) {
        barFreshnessReason = `15m bar data stale: latest bar is ${Math.round((nowMs - ts15m) / 60000)}m old`;
      }
    }
  }

  const _setupMeta = {
    sweep_bar_index:        sweepResult.swept            ? sweepResult.sweepBarIndex        : null,
    reclaim_bar_index:      reclaimResult.reclaimed      ? reclaimResult.reclaimBarIndex    : null,
    mss_bar_index:          mssResult.detected           ? mssResult.mssBarIndex            : null,
    displacement_bar_index: displacementCandle           ? displacementCandle.index         : null,
    latest_bar_index:       latestBarIndex,
    setup_age_bars:         setupAgeBars,
    setup_recency_valid:    setupRecencyValid,
    setup_window_bars:      setupWindow,
    opposite_invalidated:   oppositeInvalidated,
    bar_freshness_reason:   barFreshnessReason,
  };

  return { biasResult, sessionLevels, sweepResult, sweepLevel, sweepDirection,
           reclaimResult, mssResult, displacementCandle, volumeResult, _setupMeta };
}

/**
 * Validates that sweep → reclaim → MSS → displacement indices are strictly ordered.
 *
 * Returns a rejection reason string when the sequence is broken, null when valid.
 * All four indices must be non-null before the check is applied.
 *
 * @param {object} meta - _setupMeta from engineOutputs
 * @returns {string|null}
 */
export function validateSetupSequence(meta) {
  const s = meta.sweep_bar_index;
  const r = meta.reclaim_bar_index;
  const m = meta.mss_bar_index;
  const d = meta.displacement_bar_index;
  if (s == null || r == null || m == null || d == null) return null;
  if (r <= s) return 'setup sequence invalid: reclaim at or before sweep';
  if (m <= r) return 'setup sequence invalid: MSS before reclaim';
  if (d < m)  return 'setup sequence invalid: displacement before MSS';
  return null;
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
          reclaimResult, mssResult, displacementCandle, volumeResult,
          _setupMeta } = engineOutputs;

  const w = (reason, fix) => {
    const base = makeWait(ts, symbol, biasResult, reason, fix);
    if (_setupMeta) {
      base._meta = {
        sweep_bar_index:        _setupMeta.sweep_bar_index        ?? null,
        reclaim_bar_index:      _setupMeta.reclaim_bar_index      ?? null,
        mss_bar_index:          _setupMeta.mss_bar_index          ?? null,
        displacement_bar_index: _setupMeta.displacement_bar_index ?? null,
        latest_bar_index:       _setupMeta.latest_bar_index       ?? null,
        setup_age_bars:         _setupMeta.setup_age_bars         ?? null,
        setup_recency_valid:    _setupMeta.setup_recency_valid     ?? false,
      };
    }
    return base;
  };

  // ── Phase 3B step 0a: bar freshness (only set by runEngines when nowMs is live) ──
  if (_setupMeta?.bar_freshness_reason) {
    return w(_setupMeta.bar_freshness_reason,
             'Ensure TradingView data feed is live and 5m/15m bars are current');
  }

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

  // ── Phase 3B step 2a: setup recency guard ─────────────────────────────────
  if (_setupMeta?.setup_recency_valid === false) {
    return w(
      `Sweep at bar ${_setupMeta.sweep_bar_index} is outside the valid setup window (age: ${_setupMeta.setup_age_bars} bars, window: ${_setupMeta.setup_window_bars ?? 12})`,
      'Wait for a fresh sweep within the last 12 bars on the 5m chart',
    );
  }

  // ── Phase 3B step 2b: opposite-direction invalidation ─────────────────────
  if (_setupMeta?.opposite_invalidated === true) {
    return w(
      'Newer opposite sweep invalidates setup — conflicting direction sweep detected',
      'Wait for a clean setup without a more recent opposing liquidity sweep',
    );
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

  // ── Phase 3B-FIX: event order validation ─────────────────────────────────
  if (_setupMeta) {
    const seqErr = validateSetupSequence(_setupMeta);
    if (seqErr) {
      return w(seqErr, 'Wait for a valid sweep → reclaim → MSS → displacement sequence in correct order');
    }
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
    ...(_setupMeta ? {
      _meta: {
        sweep_bar_index:        _setupMeta.sweep_bar_index        ?? null,
        reclaim_bar_index:      _setupMeta.reclaim_bar_index      ?? null,
        mss_bar_index:          _setupMeta.mss_bar_index          ?? null,
        displacement_bar_index: _setupMeta.displacement_bar_index ?? null,
        latest_bar_index:       _setupMeta.latest_bar_index       ?? null,
        setup_age_bars:         _setupMeta.setup_age_bars         ?? null,
        setup_recency_valid:    _setupMeta.setup_recency_valid     ?? false,
      },
    } : {}),
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
