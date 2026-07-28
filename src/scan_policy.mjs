export const SCAN_ENGINE_VERSION = 'h6-footprint-v3';
export const MARKET_ADJ = Object.freeze({ RISK_ON: 5, NEUTRAL: -5, RISK_OFF: -15 });

const PHASES = new Set(['IMPULSE', 'PULLBACK', 'DOWNTREND', 'SIDEWAYS']);
const REGIMES = new Set(Object.keys(MARKET_ADJ));
const SESSION_TRUST = new Set(['HIGH', 'LOW']);
const BASE_FIELDS = ['conf', 'cumDelta', 'buyPct', 'divSignal', 'maxBuyStack', 'price', 'ma20', 'ma100'];

const finite = value => Number.isFinite(value);

function parseStudyNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseFloat(String(value).replace(/[,\s]/g, '').replace(/[−–—]/g, '-'));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstStudyNumber(values, aliases) {
  for (const alias of aliases) {
    const parsed = parseStudyNumber(values?.[alias]);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function extractMovingAverages(studies = []) {
  const movingAverages = { ma20: null, ma100: null, ppSignal: null };
  for (const study of studies) {
    const values = study?.values || {};
    if (study?.name?.includes('Pocket Pivot PRO')) {
      movingAverages.ma20 ??= firstStudyNumber(values, [
        'MA Nhanh (Tím)', 'MA Nhanh (Tim)', 'MA Nhanh (TÃƒÂ­m)', 'MA Fast', 'MA Nhanh',
      ]);
      movingAverages.ma100 ??= firstStudyNumber(values, [
        'MA Chậm', 'MA Cham', 'MA ChÃ¡ÂºÂ­m', 'MA Slow', 'MA Macro',
      ]);
      movingAverages.ppSignal ??= firstStudyNumber(values, ['Pocket Pivot PRO']);
    }
    if (study?.name?.includes('Price Action GEM')) {
      movingAverages.ma20 ??= firstStudyNumber(values, ['MA Fast']);
      movingAverages.ma100 ??= firstStudyNumber(values, ['MA Macro', 'MA Slow']);
    }
  }
  return movingAverages;
}

export function assertH6Resolution(resolution) {
  if (resolution !== '360') throw new Error(`H6 resolution required: expected 360, got ${resolution ?? 'unknown'}`);
  return true;
}

export async function confirmSymbol(expected, getState, { attempts = 12, wait = async () => {} } = {}) {
  const wanted = String(expected || '').split(':').pop().toUpperCase();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const state = await getState().catch(() => ({}));
    const actual = String(state?.symbol || '').split(':').pop().toUpperCase();
    if (wanted && actual === wanted) return state;
    if (attempt + 1 < attempts) await wait();
  }
  throw new Error(`symbol confirmation failed for ${expected}`);
}

export function scoreSignal(fp = {}, ma = {}, price, phase = 'UNKNOWN', volRatio = null, churn, context = {}) {
  const regime = context.regime;
  const sessionTrust = context.sessionTrust;
  const barClosed = context.barClosed;
  const values = { ...fp, price, ma20: ma.ma20, ma100: ma.ma100 };
  const missingFields = BASE_FIELDS.filter(field => !finite(values[field]));
  if (!PHASES.has(phase)) missingFields.push('phase');
  if (!REGIMES.has(regime)) missingFields.push('market_regime');
  if (!SESSION_TRUST.has(sessionTrust)) missingFields.push('session_trust');
  if (typeof barClosed !== 'boolean') missingFields.push('bar_closed');
  if (typeof churn !== 'boolean') missingFields.push('churn');
  if ((phase === 'IMPULSE' || phase === 'PULLBACK') && !finite(volRatio)) missingFields.push('vol_ratio');

  const c = {
    conf: finite(fp.conf) ? fp.conf >= 60 : null,
    cumD: finite(fp.cumDelta) ? fp.cumDelta > 0 : null,
    buyPct: finite(fp.buyPct) ? fp.buyPct >= 55 : null,
    noDIV: finite(fp.divSignal) ? fp.divSignal === 0 : null,
    buyIMB: finite(fp.maxBuyStack) ? fp.maxBuyStack >= 1 : null,
    aboveMA20: finite(price) && finite(ma.ma20) ? price > ma.ma20 : null,
    ma20vsMa100: finite(ma.ma20) && finite(ma.ma100) ? ma.ma20 > ma.ma100 : null,
  };
  const passed = Object.values(c).filter(Boolean).length;
  const scorePct = Math.round(passed / 7 * 1000) / 10;
  const signalQuality = typeof barClosed === 'boolean'
    ? (barClosed ? 'CONFIRMED' : 'PROVISIONAL') : null;
  const decisionReasons = [];
  if (missingFields.length) decisionReasons.push(`missing_evidence:${missingFields.join(',')}`);
  const common = {
    pct: scorePct, scorePct, rankScore: scorePct + (MARKET_ADJ[regime] ?? 0), passed,
    total: 7, c, phase, vol_ratio: volRatio, churn, market_regime: regime,
    market_adj: MARKET_ADJ[regime] ?? 0, signalQuality, missingFields,
    score: scorePct, score_pct: scorePct, rank_score: scorePct + (MARKET_ADJ[regime] ?? 0),
    signal_quality: signalQuality, missing_fields: missingFields, decision_reasons: decisionReasons,
  };
  if (missingFields.length) return { ...common, sig: 'N/A' };

  let sig = passed >= 5 && c.cumD ? 'BUY' : passed >= 3 ? 'WATCH' : 'AVOID';
  if (fp.divSignal === 1 && fp.cumDelta < 0) { sig = 'LOAI'; decisionReasons.push('bearish_divergence_negative_delta'); }
  if (sig === 'BUY' && phase === 'PULLBACK' && volRatio >= 1.0) { sig = 'WATCH'; decisionReasons.push('pullback_volume_not_exhausted'); }
  if (sig === 'BUY' && phase === 'IMPULSE' && volRatio < 1.5) { sig = 'WATCH'; decisionReasons.push('impulse_volume_unconfirmed'); }
  if (sig === 'BUY' && churn) { sig = 'WATCH'; decisionReasons.push('vsa_churn'); }
  if (sig === 'BUY' && regime === 'RISK_OFF') { sig = 'WATCH'; decisionReasons.push('risk_off_cap'); }
  if (sig === 'BUY' && sessionTrust === 'LOW') { sig = 'WATCH'; decisionReasons.push('low_session_trust_cap'); }
  if (!decisionReasons.length) decisionReasons.push(`base_score:${passed}/7`);
  return { ...common, sig };
}

// ── Task 1: Auto Key Levels Previous Month Profile ──

const AUTO_KEY_LEVELS_NAME = 'Auto Key Levels';
const MONTHLY_KEYS = ['Prev Monthly POC', 'Prev Monthly VAH', 'Prev Monthly VAL'];
const THIN_SPACE = /\s/g; // handle thin spaces, regular spaces, non-breaking spaces

/**
 * Parse a TradingView formatted number like "23.25 K" or "71,845" or "23.1 K"
 * Handles: K suffix (×1000), thin spaces, commas as thousands separators
 */
function parseProfileNumber(val) {
  if (val == null || val === '' || val === '∅') return null;
  let s = val.toString().replace(THIN_SPACE, '').replace(/,/g, '').replace(/[−–—]/g, '-').trim();
  let multiplier = 1;
  if (/[kKＭ]$/.test(s)) { multiplier = 1000; s = s.slice(0, -1).trim(); }
  if (/万$/.test(s)) { multiplier = 10000; s = s.slice(0, -1).trim(); }
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * multiplier) : null;
}

/**
 * Derive the previous calendar month string "YYYY-MM" from a market date.
 * Handles year rollover (January → previous December).
 */
function previousMonth(marketDate) {
  const d = new Date(marketDate);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = d.getMonth(); // 0=Jan
  if (m === 0) return `${y - 1}-12`;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * Extract and validate the Previous Monthly Profile (POC, VAH, VAL) from
 * an Auto Key Levels study on a TradingView chart.
 *
 * @param {Object} options
 * @param {Array}  options.studies       - Study array from TradingView chart state
 * @param {string} options.symbol        - Expected symbol (e.g. "HOSE:HCM")
 * @param {string} options.marketDate    - Market date string (e.g. "2026-07-28")
 * @param {string|Date} options.observedAt - When the observation was made
 * @param {number} options.maxAgeSeconds  - Max allowed age of the observation
 * @returns {{ valid: boolean, poc, vah, val, prevMonth, source, error?, stale? }}
 */
export function extractPreviousMonthProfile({ studies = [], symbol, marketDate, observedAt, maxAgeSeconds = 7200 }) {
  // 1. Find Auto Key Levels studies
  const keyLevels = studies.filter(s => s?.name?.includes(AUTO_KEY_LEVELS_NAME));
  if (keyLevels.length === 0) {
    return { valid: false, error: `Auto Key Levels study not found`, poc: null, vah: null, val: null, prevMonth: null, source: null, symbol };
  }
  if (keyLevels.length > 1) {
    return { valid: false, error: `Duplicate Auto Key Levels study (found ${keyLevels.length})`, poc: null, vah: null, val: null, prevMonth: null, source: null, symbol };
  }

  const values = keyLevels[0].values || {};

  // 2. Extract the three required fields
  const poc = parseProfileNumber(values['Prev Monthly POC']);
  const vah = parseProfileNumber(values['Prev Monthly VAH']);
  const val = parseProfileNumber(values['Prev Monthly VAL']);

  // 3. Validate all three are present and finite
  const missing = [];
  if (poc === null) missing.push('Prev Monthly POC');
  if (vah === null) missing.push('Prev Monthly VAH');
  if (val === null) missing.push('Prev Monthly VAL');
  if (missing.length > 0) {
    return { valid: false, error: `Missing profile values: ${missing.join(', ')}`, poc, vah, val, prevMonth: null, source: AUTO_KEY_LEVELS_NAME, symbol };
  }

  // 4. Validate VAL < POC < VAH
  if (!(val < poc && poc < vah)) {
    return { valid: false, error: `Profile invariant violation: VAL=${val} POC=${poc} VAH=${vah} (expected VAL < POC < VAH)`, poc, vah, val, prevMonth: null, source: AUTO_KEY_LEVELS_NAME, symbol };
  }

  // 5. Derive previous month from market date
  const prevMon = previousMonth(marketDate);
  if (!prevMon) {
    return { valid: false, error: `Cannot derive previous month from marketDate=${marketDate}`, poc, vah, val, prevMonth: null, source: AUTO_KEY_LEVELS_NAME, symbol };
  }

  // 6. Check staleness
  const observed = new Date(observedAt);
  const ageSeconds = (Date.now() - observed.getTime()) / 1000;
  const stale = ageSeconds > maxAgeSeconds;

  return {
    valid: !stale,
    poc, vah, val,
    prevMonth: prevMon,
    source: AUTO_KEY_LEVELS_NAME,
    symbol,
    stale,
    error: stale ? `Observation stale: ${Math.round(ageSeconds)}s > ${maxAgeSeconds}s` : null,
  };
}

/**
 * Classify which moving average to anchor to based on price proximity.
 *
 * @param {Object} options
 * @param {number} options.price            - Current price
 * @param {number|null} options.sma20       - SMA20 value
 * @param {number|null} options.sma100      - SMA100 value
 * @param {string|null} options.preferredAnchor - Preferred anchor ('sma20' or 'sma100')
 * @param {number} options.maxExtensionPct  - Max allowed extension from SMA100 (default 7)
 * @returns {{ anchor: string|null, distancePct: number|null, overextended: boolean }}
 */
export function classifyMaAnchor({ price, sma20, sma100, preferredAnchor, maxExtensionPct = 7 }) {
  if (price == null || !Number.isFinite(price)) {
    return { anchor: null, distancePct: null, overextended: false };
  }

  // Check SMA100 proximity
  if (sma100 != null && Number.isFinite(sma100)) {
    const distancePct = Math.round((price - sma100) / sma100 * 10000) / 100;
    const overextended = distancePct > maxExtensionPct;

    if (preferredAnchor === 'sma100' || (!overextended && distancePct >= -maxExtensionPct)) {
      return { anchor: 'sma100', distancePct, overextended };
    }
  }

  // Check SMA20 proximity
  if (sma20 != null && Number.isFinite(sma20)) {
    const distancePct = Math.round((price - sma20) / sma20 * 10000) / 100;
    if (preferredAnchor === 'sma20' || Math.abs(distancePct) <= maxExtensionPct) {
      return { anchor: 'sma20', distancePct, overextended: false };
    }
  }

  // Overextended from SMA100, no good SMA20 proximity
  if (sma100 != null && Number.isFinite(sma100)) {
    const distancePct = Math.round((price - sma100) / sma100 * 10000) / 100;
    return { anchor: 'none', distancePct, overextended: true };
  }

  return { anchor: null, distancePct: null, overextended: false };
}
