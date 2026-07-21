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
