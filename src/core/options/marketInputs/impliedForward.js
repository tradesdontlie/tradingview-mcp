// Phase 2B, Steps 6-10 — matched call/put pair extraction, synthetic
// forward estimation, and the parity-implied effective carry estimator.
// Pure, no TradingView/CDP imports. Diagnostic/calibration only — not
// wired into strategyScenarios.js / ranking / confidence.

import { assertPositiveFinite, assertFinite, CALIBRATION_WARNINGS } from './marketInputTypes.js';

/**
 * Step 6 — deterministic matched call/put pair extraction from a flat list
 * of contracts (as returned by options_get_chain). Requires exact
 * (expiration, strike) identity, both legs quoted with bid>0, ask>0,
 * ask>=bid, and spread_pct <= maxSpreadPct. Filters to a delta window by
 * default (calibration quality, Step 6).
 *
 * @param {Array<object>} contracts - { option_type, expiration, strike, bid, ask, delta, ... }
 * @param {object} [opts]
 * @param {number} [opts.maxSpreadPct] - default 5 (Step 6 calibration default)
 * @param {[number, number]} [opts.callDeltaWindow] - default [0.25, 0.75]
 * @param {[number, number]} [opts.putDeltaWindow] - default [-0.75, -0.25]
 * @returns {Array<{expiration, strike, call, put}>}
 */
export function extractMatchedPairs(contracts, opts = {}) {
  const maxSpreadPct = opts.maxSpreadPct ?? 5;
  const [callDeltaMin, callDeltaMax] = opts.callDeltaWindow ?? [0.25, 0.75];
  const [putDeltaMin, putDeltaMax] = opts.putDeltaWindow ?? [-0.75, -0.25];

  function legQualifies(c) {
    if (c.bid == null || c.ask == null) return false;
    if (!(c.bid > 0) || !(c.ask > 0)) return false;
    if (c.ask < c.bid) return false; // crossed market
    const spreadPct = ((c.ask - c.bid) / ((c.ask + c.bid) / 2)) * 100;
    if (spreadPct > maxSpreadPct) return false;
    if (c.option_type === 'call' && c.delta != null && (c.delta < callDeltaMin || c.delta > callDeltaMax)) return false;
    if (c.option_type === 'put' && c.delta != null && (c.delta < putDeltaMin || c.delta > putDeltaMax)) return false;
    return true;
  }

  const byKey = new Map();
  for (const c of contracts) {
    const key = `${c.expiration}::${c.strike}`;
    if (!byKey.has(key)) byKey.set(key, {});
    byKey.get(key)[c.option_type] = c;
  }

  const pairs = [];
  for (const [key, { call, put }] of byKey) {
    if (!call || !put) continue;
    if (!legQualifies(call) || !legQualifies(put)) continue;
    const [expiration, strikeStr] = key.split('::');
    pairs.push({ expiration, strike: Number(strikeStr), call, put });
  }
  return pairs;
}

/**
 * Step 7 — CALIBRATION_MARK_MID. Not an execution-price assumption.
 */
export function calibrationMid(contract) {
  assertFinite('bid', contract.bid);
  assertFinite('ask', contract.ask);
  return (contract.bid + contract.ask) / 2;
}

/**
 * Step 8 — diagnostic synthetic forward estimate via approximate American
 * put-call parity: F ≈ K + e^(rT) * (C - P). Labeled
 * AMERICAN_OPTIONS_SYNTHETIC_FORWARD_ESTIMATE, not "true_forward" — American
 * options do not obey exact European put-call parity, so this always
 * carries the AMERICAN_PARITY_APPROXIMATION warning.
 */
export function syntheticForwardEstimate({ strike, callMid, putMid, discountRate, timeToExpiryYears }) {
  assertPositiveFinite('strike', strike);
  assertFinite('callMid', callMid);
  assertFinite('putMid', putMid);
  assertFinite('discountRate', discountRate);
  assertPositiveFinite('timeToExpiryYears', timeToExpiryYears);
  const forward = strike + Math.exp(discountRate * timeToExpiryYears) * (callMid - putMid);
  return {
    forward_estimate: forward,
    estimate_type: 'AMERICAN_OPTIONS_SYNTHETIC_FORWARD_ESTIMATE',
    warnings: [CALIBRATION_WARNINGS.AMERICAN_PARITY_APPROXIMATION],
  };
}

/**
 * Step 9 — diagnostic continuous effective carry implied by a synthetic
 * forward: q_eff = r - ln(F / S) / T. NOT called dividend_yield or borrow
 * fee — see marketInputTypes.js / Step 21 (do not claim borrow rate).
 */
export function effectiveCarryFromForward({ spot, forward, discountRate, timeToExpiryYears }) {
  assertPositiveFinite('spot', spot);
  assertFinite('discountRate', discountRate);
  assertPositiveFinite('timeToExpiryYears', timeToExpiryYears);
  if (!(forward > 0)) {
    throw new Error(`forward must be > 0 to compute effective carry, got: ${forward}`);
  }
  return discountRate - Math.log(forward / spot) / timeToExpiryYears;
}

// --- Step 10 — robust cross-strike estimator -------------------------------

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function mad(values, med) {
  return median(values.map(v => Math.abs(v - med)));
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

/**
 * Step 10 — robust cross-strike q_eff estimator for one expiration. Takes
 * an array of { q_eff, weight } (weight typically inverse bid/ask width,
 * Step 10) and returns pair_count, median, weighted_mean, MAD, min, max, IQR.
 * Median is the recommended V1 primary estimator per spec.
 */
export function robustCrossStrikeCarry(estimates) {
  if (estimates.length === 0) {
    throw new Error('robustCrossStrikeCarry requires at least one estimate');
  }
  const qs = estimates.map(e => e.q_eff);
  const sorted = [...qs].sort((a, b) => a - b);
  const med = median(qs);

  const totalWeight = estimates.reduce((s, e) => s + (e.weight ?? 1), 0);
  const weightedMean = estimates.reduce((s, e) => s + e.q_eff * (e.weight ?? 1), 0) / totalWeight;

  return {
    pair_count: qs.length,
    median_q: med,
    weighted_mean_q: weightedMean,
    mad: mad(qs, med),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    iqr: quantile(sorted, 0.75) - quantile(sorted, 0.25),
  };
}

/**
 * Step 10 helper — inverse bid/ask-width weight for a matched pair
 * (tighter combined spread => higher weight). Caps the max weight ratio
 * so a single ultra-tight pair cannot dominate excessively (Step 10).
 */
export function inverseSpreadWeight(pair, { maxWeightRatio = 10 } = {}) {
  const callWidth = pair.call.ask - pair.call.bid;
  const putWidth = pair.put.ask - pair.put.bid;
  const totalWidth = Math.max(callWidth + putWidth, 1e-6);
  const raw = 1 / totalWidth;
  return raw; // caller normalizes; cap applied in caller via clampWeights
}

export function clampWeights(weights, { maxWeightRatio = 10 } = {}) {
  const minWeight = Math.min(...weights);
  const cap = minWeight * maxWeightRatio;
  return weights.map(w => Math.min(w, cap));
}
