import { createHash } from 'node:crypto';

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
  const parseSymbol = raw => {
    const parts = String(raw || '').trim().toUpperCase().split(':');
    if (parts.length < 2) return { ticker: parts[0] || '', exchange: null };
    const exchange = parts.shift();
    return { ticker: parts.join(':'), exchange: exchange === 'HSX' ? 'HOSE' : exchange };
  };
  const wanted = parseSymbol(expected);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const state = await getState().catch(() => ({}));
    const actual = parseSymbol(state?.symbol);
    if (wanted.ticker && actual.ticker === wanted.ticker &&
      (wanted.exchange === null || actual.exchange === null || wanted.exchange === actual.exchange)) return state;
    if (attempt + 1 < attempts) await wait();
  }
  throw new Error(`symbol confirmation failed for ${expected}`);
}

function studyMatches(values, match) {
  if (values == null) return false;
  if (typeof match === 'function') {
    return Array.isArray(values) ? values.some((value, index) => match(value, index, values)) : Boolean(match(values));
  }
  if (typeof match !== 'string') return false;
  const items = Array.isArray(values) ? values : [values];
  return items.some(value => String(value?.name ?? value ?? '').includes(match));
}

export async function waitForStudy(getStudyValues, { match, attempts = 12, wait = async () => {} } = {}) {
  let result;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      result = await getStudyValues();
    } catch {
      result = null; // transient CDP/read failures must not crash the scan/check; callers fail closed
    }
    if (studyMatches(result, match)) return result;
    if (attempt + 1 < attempts) await wait();
  }
  return result;
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

// ── Auto Key Levels Previous Month Profile ──

const AUTO_KEY_LEVELS_NAME = 'Auto Key Levels';
const PROFILE_KEYS = ['Prev Monthly POC', 'Prev Monthly VAH', 'Prev Monthly VAL'];
const THIN_SPACE = /\s/;
const DEFAULT_CLOCK_SKEW_MS = 60000; // 1 minute clock skew tolerance

/**
 * Parse a TradingView formatted number like "23.25 K" or "71,845" or "23.1 K"
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
 */
function profileMonth(marketDate) {
  const d = new Date(marketDate);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = d.getMonth();
  if (m === 0) return `${y - 1}-12`;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * Extract and validate the Previous Monthly Profile from Auto Key Levels.
 *
 * @param {Object} opts
 * @param {Array}  opts.studies
 * @param {string} opts.expectedSymbol    - Expected symbol, e.g. "HOSE:HCM"
 * @param {string} opts.marketDate        - Market date "YYYY-MM-DD"
 * @param {string|Date} opts.observedAt   - ISO-8601 observation timestamp
 * @param {number} [opts.maxAgeSeconds=7200]
 * @param {number|Date} [opts.now]        - Injection point for deterministic testing
 * @param {number} [opts.clockSkewMs=60000]
 * @returns {{
 *   valid: boolean,
 *   source: string|null,
 *   symbol: string|null,
 *   market_date: string|null,
 *   profile_month: string|null,
 *   poc: number|null,
 *   vah: number|null,
 *   val: number|null,
 *   observed_at: string|null,
 *   complete: boolean,
 *   error: string|null,
 *   evidence_hash_fields: Object|null
 * }}
 */
export function extractPreviousMonthProfile({ studies = [], expectedSymbol, observedSymbol, expectedCacheKey, marketDate, observedAt, maxAgeSeconds = 7200, now, clockSkewMs = DEFAULT_CLOCK_SKEW_MS }) {
  const nowMs = now ? +new Date(now) : Date.now();
  const obsMs = observedAt ? +new Date(observedAt) : NaN;
  const normSym = sym => String(sym || '').split(':').pop().toUpperCase();
  const fail = (err) => ({ valid: false, error: err, source: null, symbol: expectedSymbol || null, market_date: marketDate || null, profile_month: null, poc: null, vah: null, val: null, observed_at: observedAt || null, complete: false, cache_key: null, evidence_hash: null });

  // 0. Validate inputs
  if (!Number.isFinite(obsMs)) return fail('observedAt is invalid');
  if (obsMs > nowMs + clockSkewMs) return fail(`observedAt (${observedAt}) is in the future beyond clock skew`);
  if (expectedSymbol && observedSymbol && normSym(expectedSymbol) !== normSym(observedSymbol)) {
    return fail(`symbol mismatch: expected ${normSym(expectedSymbol)}, observed ${normSym(observedSymbol)}`);
  }

  // 1. Find Auto Key Levels studies
  const keyLevels = studies.filter(s => s?.name?.includes(AUTO_KEY_LEVELS_NAME));
  if (keyLevels.length === 0) return fail('Auto Key Levels study not found');
  if (keyLevels.length > 1) return fail(`Duplicate Auto Key Levels study (found ${keyLevels.length})`);

  // 2. Extract the three required fields
  const values = keyLevels[0].values || {};
  const poc = parseProfileNumber(values['Prev Monthly POC']);
  const vah = parseProfileNumber(values['Prev Monthly VAH']);
  const val = parseProfileNumber(values['Prev Monthly VAL']);

  const missing = [];
  if (poc === null) missing.push('Prev Monthly POC');
  if (vah === null) missing.push('Prev Monthly VAH');
  if (val === null) missing.push('Prev Monthly VAL');
  if (missing.length > 0) return fail(`Missing profile values: ${missing.join(', ')}`);

  // 3. Validate VAL < POC < VAH
  if (!(val < poc && poc < vah)) return fail(`Profile invariant violation: VAL=${val} POC=${poc} VAH=${vah}`);

  // 4. Derive profile_month
  const pMonth = profileMonth(marketDate);
  if (!pMonth) return fail(`Cannot derive profile_month from marketDate=${marketDate}`);

  // 5. Check staleness
  const ageSec = (nowMs - obsMs) / 1000;
  const stale = ageSec > maxAgeSeconds;

  // 6. Cache key
  const cacheKey = expectedSymbol ? `${normSym(expectedSymbol)}:${pMonth}` : null;
  if (expectedCacheKey != null && cacheKey !== expectedCacheKey) {
    return fail(`cache key mismatch: expected ${expectedCacheKey}, computed ${cacheKey}`);
  }

  // 7. SHA-256 evidence hash over canonical JSON with keys in exact order
  const evidenceSource = {
    source: AUTO_KEY_LEVELS_NAME,
    symbol: expectedSymbol || null,
    market_date: marketDate || null,
    profile_month: pMonth,
    poc,
    vah,
    val,
    observed_at: observedAt || null,
  };
  const canonicalJson = JSON.stringify(evidenceSource, Object.keys(evidenceSource).sort());
  const evidenceHash = createHash('sha256').update(canonicalJson).digest('hex');

  return {
    valid: !stale,
    source: AUTO_KEY_LEVELS_NAME,
    symbol: expectedSymbol || null,
    market_date: marketDate || null,
    profile_month: pMonth,
    poc, vah, val,
    observed_at: observedAt || null,
    complete: !stale,
    stale,
    cache_key: cacheKey,
    evidence_hash: evidenceHash,
    evidence_hash_fields: evidenceSource,
    error: stale ? `Observation stale: ${Math.round(ageSec)}s > ${maxAgeSeconds}s` : null,
  };
}

/**
 * MA anchor classification with strict SMA gate.
 *
 * Rules:
 * - Price below SMA100 → { allowed: false, blocker: 'BELOW_SMA100' }
 * - Price must be within 0% to maxExtensionPct above at least SMA20 or SMA100
 * - preferredAnchor only changes the candidate order, never bypasses limits
 * - Price > maxExtensionPct above both → OVEREXTENDED
 *
 * @param {Object} opts
 * @param {number} opts.price
 * @param {number|null} opts.sma20
 * @param {number|null} opts.sma100
 * @param {string} [opts.preferredAnchor] - 'sma20' or 'sma100'; affects ordering only
 * @param {number} [opts.maxExtensionPct=7]
 * @returns {{ allowed: boolean, anchor: string|null, extension_pct: number|null, reason: string, blocker: string|null }}
 */
export function classifyMaAnchor({ price, sma20, sma100, preferredAnchor, maxExtensionPct = 7 }) {
  if (price == null || !Number.isFinite(price)) {
    return { allowed: false, anchor: null, extension_pct: null, reason: 'missing price', blocker: 'PRICE_UNAVAILABLE' };
  }

  // Gate 0: SMA100 is required for VN long setup
  if (sma100 == null || !Number.isFinite(sma100)) {
    return { allowed: false, anchor: null, extension_pct: null, reason: 'SMA100 missing or non-finite', blocker: 'MA_DATA_MISSING' };
  }

  // Gate 1: price must be at or above SMA100
  if (price < sma100) {
    const belowPct = Math.round((sma100 - price) / sma100 * 10000) / 100;
    return { allowed: false, anchor: null, extension_pct: -belowPct, reason: `price ${price} below SMA100 ${sma100} (${belowPct}%)`, blocker: 'BELOW_SMA100' };
  }

  // Build candidate anchors ordered by preference
  const candidates = [];
  const preferred = preferredAnchor === 'sma20' ? 'sma20' : preferredAnchor === 'sma100' ? 'sma100' : null;

  if (sma20 != null && Number.isFinite(sma20)) {
    const extPct = Math.round((price - sma20) / sma20 * 10000) / 100;
    candidates.push({ anchor: 'sma20', extension_pct: extPct });
  }
  if (sma100 != null && Number.isFinite(sma100)) {
    const extPct = Math.round((price - sma100) / sma100 * 10000) / 100;
    candidates.push({ anchor: 'sma100', extension_pct: extPct });
  }

  // Sort: preferred first, then by smallest non-negative extension_pct
  candidates.sort((a, b) => {
    if (preferred) {
      if (a.anchor === preferred && b.anchor !== preferred) return -1;
      if (a.anchor !== preferred && b.anchor === preferred) return 1;
    }
    const aOk = a.extension_pct >= 0 ? a.extension_pct : Infinity;
    const bOk = b.extension_pct >= 0 ? b.extension_pct : Infinity;
    return aOk - bOk;
  });

  // Gate 2: must be within 0% to maxExtensionPct above at least one anchor
  for (const c of candidates) {
    if (c.extension_pct >= 0 && c.extension_pct <= maxExtensionPct) {
      return { allowed: true, anchor: c.anchor, extension_pct: c.extension_pct, reason: `${c.anchor} at +${c.extension_pct}%`, blocker: null };
    }
  }

  // Both anchors exist but price is overextended
  if (candidates.length > 0) {
    const minExt = Math.min(...candidates.map(c => c.extension_pct));
    return { allowed: false, anchor: null, extension_pct: minExt, reason: `price exceeds ${maxExtensionPct}% above all anchors (min extension ${minExt}%)`, blocker: 'OVEREXTENDED' };
  }

  return { allowed: false, anchor: null, extension_pct: null, reason: 'no MA data', blocker: 'MA_DATA_MISSING' };
}
