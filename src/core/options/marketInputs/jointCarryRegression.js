// Phase 2B.1 — joint discount-rate + effective-carry estimation for ONE
// symbol + ONE expiration from multiple matched call/put strikes. Pure, no
// TradingView/CDP imports. Diagnostic/calibration only — NOT wired into
// strategyScenarios.js / ranking / confidence / options_analyze_directional.
//
// IDENTIFIABILITY WARNING (Step 17): option_implied_discount_rate and
// effective_carry_yield are model-implied NUISANCE PARAMETERS — the pair
// of numbers that best reconciles observed option prices under the
// approximate parity/CRR model used here. Neither should be interpreted
// as the true risk-free rate or an actual borrow/dividend rate. They are
// named accordingly throughout this module.

import { priceCrrAmerican } from '../pricing/crrAmerican.js';
import { calibrationMid } from './impliedForward.js';
import {
  CALIBRATION_LIQUIDITY_TIERS, CALIBRATION_WARNINGS, JOINT_CARRY_ESTIMATORS, CARRY_CONFIDENCE,
  assertFinite, assertPositiveFinite,
} from './marketInputTypes.js';

// --- Step 2: calibration liquidity tiers ------------------------------------

const TIER_MAX_SPREAD_PCT = Object.freeze({
  [CALIBRATION_LIQUIDITY_TIERS.STRICT]: 5,
  [CALIBRATION_LIQUIDITY_TIERS.STANDARD]: 10,
  [CALIBRATION_LIQUIDITY_TIERS.DIAGNOSTIC]: 20,
});

function legSpreadPct(leg) {
  return ((leg.ask - leg.bid) / ((leg.ask + leg.bid) / 2)) * 100;
}

/**
 * Step 2 — selects the tightest (STRICT preferred) liquidity tier that
 * yields at least `minPairs` matched pairs from a list of { call, put,
 * strike } pairs (already matched by extractMatchedPairs elsewhere, or an
 * equivalent). Falls back STRICT -> STANDARD -> DIAGNOSTIC. Never silently
 * promotes a DIAGNOSTIC result as production-ready — callers must check
 * `tier` and treat DIAGNOSTIC as informal only.
 */
export function selectCalibrationTier(pairs, { minPairs = 5 } = {}) {
  for (const tier of [CALIBRATION_LIQUIDITY_TIERS.STRICT, CALIBRATION_LIQUIDITY_TIERS.STANDARD, CALIBRATION_LIQUIDITY_TIERS.DIAGNOSTIC]) {
    const maxSpreadPct = TIER_MAX_SPREAD_PCT[tier];
    const qualifying = pairs.filter(p => legSpreadPct(p.call) <= maxSpreadPct && legSpreadPct(p.put) <= maxSpreadPct);
    if (qualifying.length >= minPairs) return { tier, pairs: qualifying };
  }
  // Nothing reached minPairs — return the best (widest) tier's qualifying
  // set anyway so the caller can see how few pairs exist, but the tier is
  // still labeled DIAGNOSTIC so it's never mistaken for production-ready.
  const maxSpreadPct = TIER_MAX_SPREAD_PCT[CALIBRATION_LIQUIDITY_TIERS.DIAGNOSTIC];
  const qualifying = pairs.filter(p => legSpreadPct(p.call) <= maxSpreadPct && legSpreadPct(p.put) <= maxSpreadPct);
  return { tier: CALIBRATION_LIQUIDITY_TIERS.DIAGNOSTIC, pairs: qualifying };
}

// --- Step 3: pair quality weights --------------------------------------------

/**
 * Step 3 — deterministic calibration weight for one matched pair: higher
 * for tighter spreads and closer-to-ATM (call/put delta nearer 0.5 in
 * absolute value). No volume/OI. Weights are capped (maxWeightRatio) so a
 * single ultra-tight/ATM pair cannot dominate the regression.
 */
export function pairCalibrationWeight(pair, { maxWeightRatio = 8 } = {}) {
  const callSpreadPct = Math.max(legSpreadPct(pair.call), 0.01);
  const putSpreadPct = Math.max(legSpreadPct(pair.put), 0.01);
  const spreadScore = 1 / (callSpreadPct + putSpreadPct);
  const callDeltaDist = pair.call.delta != null ? Math.abs(Math.abs(pair.call.delta) - 0.5) : 0.5;
  const putDeltaDist = pair.put.delta != null ? Math.abs(Math.abs(pair.put.delta) - 0.5) : 0.5;
  const atmScore = 1 / (1 + callDeltaDist + putDeltaDist);
  return { raw_weight: spreadScore * atmScore, spread_score: spreadScore, atm_score: atmScore, _maxWeightRatio: maxWeightRatio };
}

export function normalizeWeights(rawWeights, { maxWeightRatio = 8 } = {}) {
  const minW = Math.min(...rawWeights);
  const cap = minW * maxWeightRatio;
  return rawWeights.map(w => Math.min(w, cap));
}

// --- Steps 4-5: joint parity regression (weighted OLS + outlier rejection) --

function weightedLinearFit(xs, ys, weights) {
  const sw = weights.reduce((a, b) => a + b, 0);
  const xbar = xs.reduce((s, x, i) => s + weights[i] * x, 0) / sw;
  const ybar = ys.reduce((s, y, i) => s + weights[i] * y, 0) / sw;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += weights[i] * (xs[i] - xbar) ** 2;
    sxy += weights[i] * (xs[i] - xbar) * (ys[i] - ybar);
  }
  const slope = sxy / sxx; // B, expect ≈ -DF
  const intercept = ybar - slope * xbar; // A
  const fitted = xs.map(x => intercept + slope * x);
  const residuals = ys.map((y, i) => y - fitted[i]);
  const ssRes = residuals.reduce((s, r, i) => s + weights[i] * r * r, 0);
  const ssTot = ys.reduce((s, y, i) => s + weights[i] * (y - ybar) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;
  return { intercept, slope, residuals, r2 };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function residualMad(residuals) {
  const med = median(residuals);
  return median(residuals.map(r => Math.abs(r - med)));
}

const DEFAULT_BOUNDS = Object.freeze({
  discountRateMin: -0.02, discountRateMax: 0.15,
  carryMin: -0.20, carryMax: 0.20,
});

/**
 * Steps 4-5 — RAW_PARITY_JOINT_ESTIMATE: fits Y = A - DF*K via weighted OLS
 * on Y_i = C_mid_i - P_mid_i, X_i = strike_i, then does one round of MAD-
 * based outlier rejection and refits once (never iterates to a desired
 * answer — exactly one refit, per Step 5).
 *
 * @param {Array<{strike, call, put}>} pairs - call/put each {bid, ask, delta}
 * @param {object} ctx - { spot, timeToExpiryYears }
 * @param {object} [opts] - { madThreshold=3, bounds }
 */
export function fitRawParityJoint(pairs, ctx, opts = {}) {
  const { spot, timeToExpiryYears: T } = ctx;
  assertPositiveFinite('spot', spot);
  assertPositiveFinite('timeToExpiryYears', T);
  const bounds = { ...DEFAULT_BOUNDS, ...(opts.bounds || {}) };
  const madThreshold = opts.madThreshold ?? 3;

  if (pairs.length < 2) {
    throw new Error(`fitRawParityJoint requires >=2 matched pairs, got ${pairs.length}`);
  }

  const xs = pairs.map(p => p.strike);
  const ys = pairs.map(p => calibrationMid(p.call) - calibrationMid(p.put));
  const rawWeights = normalizeWeights(pairs.map(p => pairCalibrationWeight(p).raw_weight));

  const initialFit = weightedLinearFit(xs, ys, rawWeights);
  const mad = residualMad(initialFit.residuals);

  // Step 5 — one round of MAD-based outlier rejection, one refit.
  let keptIdx = pairs.map((_, i) => i);
  let removedCount = 0;
  if (mad > 0) {
    keptIdx = initialFit.residuals.map((r, i) => [r, i]).filter(([r]) => Math.abs(r) <= madThreshold * mad).map(([, i]) => i);
    removedCount = pairs.length - keptIdx.length;
  }

  const finalXs = keptIdx.map(i => xs[i]);
  const finalYs = keptIdx.map(i => ys[i]);
  const finalWeights = keptIdx.map(i => rawWeights[i]);
  const fit = keptIdx.length >= 2 ? weightedLinearFit(finalXs, finalYs, finalWeights) : initialFit;

  const DF = -fit.slope;
  const A = fit.intercept;
  const warnings = [CALIBRATION_WARNINGS.AMERICAN_PARITY_APPROXIMATION];

  let discountRate = null, carryYield = null, boundHit = false;
  if (DF > 0 && A > 0) {
    discountRate = -Math.log(DF) / T;
    carryYield = -Math.log(A / spot) / T;
    if (discountRate < bounds.discountRateMin || discountRate > bounds.discountRateMax) {
      discountRate = Math.min(Math.max(discountRate, bounds.discountRateMin), bounds.discountRateMax);
      boundHit = true;
    }
    if (carryYield < bounds.carryMin || carryYield > bounds.carryMax) {
      carryYield = Math.min(Math.max(carryYield, bounds.carryMin), bounds.carryMax);
      boundHit = true;
    }
  } else {
    boundHit = true; // DF<=0 or A<=0: degenerate fit, cannot derive valid r/q
  }
  if (boundHit) warnings.push(CALIBRATION_WARNINGS.ESTIMATOR_BOUND_HIT);

  const finalResiduals = keptIdx.length >= 2 ? fit.residuals : initialFit.residuals;

  return {
    estimator: JOINT_CARRY_ESTIMATORS.RAW_PARITY_JOINT_ESTIMATE,
    discount_rate: discountRate,
    effective_carry_yield: carryYield,
    discount_factor: DF,
    forward_intercept: A,
    r2: fit.r2,
    initial_pair_count: pairs.length,
    retained_pair_count: keptIdx.length,
    removed_outlier_count: removedCount,
    residual_mad: residualMad(finalResiduals),
    max_residual: Math.max(...finalResiduals.map(Math.abs)),
    bound_hit: boundHit,
    warnings,
  };
}

// --- Step 6-7: American exercise correction + iterative fixed point --------

/**
 * Step 6 — computes each pair's early-exercise premium (American - CRR-
 * European) under a provisional (r, q) and Europeanizes the observed mids:
 * C_equiv = C_mid - EEP_call, P_equiv = P_mid - EEP_put. Returns a NEW
 * array of equivalent pairs for regression; never mutates market mids.
 */
export function europeanizePairs(pairs, ctx) {
  const { spot, timeToExpiryYears: T, discountRate, carryYield, steps = 200 } = ctx;
  return pairs.map(p => {
    const callIv = p.call.iv, putIv = p.put.iv;
    const americanCall = priceCrrAmerican({ option_type: 'call', spot, strike: p.strike, time_to_expiry_years: T, volatility: callIv, risk_free_rate: discountRate, dividend_yield: carryYield, steps }).price;
    // CRR European mode: same tree without the intrinsic-floor comparison —
    // reuse the closed-form-equivalent by disabling early exercise via a
    // local re-derivation identical in spirit to Phase 2A.1's diagnostic
    // CRR_European (kept local here to avoid a cross-module diagnostic-only export).
    const europeanCall = crrEuropeanPrice({ option_type: 'call', spot, strike: p.strike, time_to_expiry_years: T, volatility: callIv, risk_free_rate: discountRate, dividend_yield: carryYield, steps });
    const americanPut = priceCrrAmerican({ option_type: 'put', spot, strike: p.strike, time_to_expiry_years: T, volatility: putIv, risk_free_rate: discountRate, dividend_yield: carryYield, steps }).price;
    const europeanPut = crrEuropeanPrice({ option_type: 'put', spot, strike: p.strike, time_to_expiry_years: T, volatility: putIv, risk_free_rate: discountRate, dividend_yield: carryYield, steps });

    const eepCall = americanCall - europeanCall;
    const eepPut = americanPut - europeanPut;
    const callMid = calibrationMid(p.call), putMid = calibrationMid(p.put);
    return {
      strike: p.strike,
      call: { ...p.call, equiv_mid: callMid - eepCall },
      put: { ...p.put, equiv_mid: putMid - eepPut },
      eep_call: eepCall,
      eep_put: eepPut,
    };
  });
}

function crrEuropeanPrice({ option_type, spot, strike, time_to_expiry_years: T, volatility, risk_free_rate: r, dividend_yield: q, steps }) {
  if (T === 0) return option_type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const dt = T / steps;
  const u = Math.exp(volatility * Math.sqrt(dt));
  const d = 1 / u;
  const discount = Math.exp(-r * dt);
  const growth = Math.exp((r - q) * dt);
  const p = (growth - d) / (u - d);
  const terminal = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const s = spot * Math.pow(u, i) * Math.pow(d, steps - i);
    terminal[i] = option_type === 'call' ? Math.max(s - strike, 0) : Math.max(strike - s, 0);
  }
  let values = terminal;
  for (let step = steps - 1; step >= 0; step--) {
    const next = new Float64Array(step + 1);
    for (let i = 0; i <= step; i++) next[i] = discount * (p * values[i + 1] + (1 - p) * values[i]);
    values = next;
  }
  return values[0];
}

/**
 * Fits the raw-parity regression on Europeanized mids (equiv_mid instead
 * of market mids) — same math as fitRawParityJoint, different Y source.
 */
function fitOnEquivPairs(equivPairs, ctx, opts) {
  const asMidPairs = equivPairs.map(p => ({
    strike: p.strike,
    call: { ...p.call, bid: p.call.equiv_mid, ask: p.call.equiv_mid },
    put: { ...p.put, bid: p.put.equiv_mid, ask: p.put.equiv_mid },
  }));
  return fitRawParityJoint(asMidPairs, ctx, opts);
}

/**
 * Step 7 — iterative fixed point: alternates (a) computing CRR early-
 * exercise premiums under the current (r, q) estimate and Europeanizing
 * mids, and (b) re-fitting the joint parity regression on the Europeanized
 * mids, until both |Δr| and |Δq| < 1bp or maxIterations is hit. Does NOT
 * fabricate a converged HIGH-confidence result if it fails to converge —
 * returns converged:false and the JOINT_ESTIMATOR_NOT_CONVERGED warning.
 */
export function fitAmericanCorrectedJointCarry(pairs, ctx, opts = {}) {
  const { spot, timeToExpiryYears: T } = ctx;
  const maxIterations = opts.maxIterations ?? 10;
  const tolBp = opts.tolBp ?? 1;

  let r = ctx.initialDiscountRate ?? 0.04;
  let q = ctx.initialCarryYield ?? 0;
  let converged = false;
  let iterations = 0;
  let lastFit = null;

  for (; iterations < maxIterations; iterations++) {
    const equiv = europeanizePairs(pairs, { spot, timeToExpiryYears: T, discountRate: r, carryYield: q, steps: ctx.steps ?? 200 });
    const fit = fitOnEquivPairs(equiv, { spot, timeToExpiryYears: T }, opts);
    lastFit = fit;
    if (fit.discount_rate == null || fit.effective_carry_yield == null) break; // degenerate fit, stop iterating
    const dR = Math.abs(fit.discount_rate - r) * 10000;
    const dQ = Math.abs(fit.effective_carry_yield - q) * 10000;
    r = fit.discount_rate;
    q = fit.effective_carry_yield;
    if (dR < tolBp && dQ < tolBp) { converged = true; iterations++; break; }
  }

  const warnings = [...(lastFit?.warnings ?? []), CALIBRATION_WARNINGS.AMERICAN_PARITY_APPROXIMATION];
  if (!converged) warnings.push(CALIBRATION_WARNINGS.JOINT_ESTIMATOR_NOT_CONVERGED);

  return {
    estimator: JOINT_CARRY_ESTIMATORS.AMERICAN_CORRECTED_JOINT_CARRY,
    discount_rate: r,
    effective_carry_yield: q,
    converged,
    iterations,
    r2: lastFit?.r2 ?? null,
    retained_pair_count: lastFit?.retained_pair_count ?? null,
    removed_outlier_count: lastFit?.removed_outlier_count ?? null,
    residual_mad: lastFit?.residual_mad ?? null,
    bound_hit: lastFit?.bound_hit ?? true,
    warnings: [...new Set(warnings)],
  };
}

// --- Step 10: term structure ------------------------------------------------

/**
 * Step 10 — flags large jumps between adjacent expiries' fitted r/q. Both
 * thresholds are explicit, documented, configurable constants (not a
 * vague "large jump" judgment).
 */
export function checkTermStructureStability(expiryPoints, { rJumpThresholdBp = 150, qJumpThresholdBp = 150 } = {}) {
  const sorted = [...expiryPoints].sort((a, b) => a.dte - b.dte);
  const flags = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    if (prev.option_implied_discount_rate == null || cur.option_implied_discount_rate == null) continue;
    const dR = Math.abs(cur.option_implied_discount_rate - prev.option_implied_discount_rate) * 10000;
    const dQ = Math.abs(cur.effective_carry_yield - prev.effective_carry_yield) * 10000;
    if (dR > rJumpThresholdBp || dQ > qJumpThresholdBp) {
      flags.push({ from: prev.expiration, to: cur.expiration, delta_r_bp: dR, delta_q_bp: dQ, warning: CALIBRATION_WARNINGS.TERM_STRUCTURE_DISCONTINUITY });
    }
  }
  return flags;
}

// --- Step 16: confidence V2 -------------------------------------------------

/**
 * Step 16 — Confidence V2, thresholds frozen before live evaluation:
 *   HIGH:   retained_pairs>=8 AND tier in {STRICT,STANDARD} AND r2>=0.95
 *           AND residual_mad<=0.05 AND converged AND !bound_hit
 *   MEDIUM: retained_pairs>=5 AND converged AND residual_mad<=0.15
 *   LOW:    otherwise
 */
export function classifyJointConfidence({ retainedPairs, tier, r2, residualMad: rmad, converged, boundHit }) {
  if (
    retainedPairs >= 8
    && (tier === CALIBRATION_LIQUIDITY_TIERS.STRICT || tier === CALIBRATION_LIQUIDITY_TIERS.STANDARD)
    && r2 >= 0.95 && rmad <= 0.05 && converged && !boundHit
  ) return CARRY_CONFIDENCE.HIGH;
  if (retainedPairs >= 5 && converged && rmad <= 0.15) return CARRY_CONFIDENCE.MEDIUM;
  return CARRY_CONFIDENCE.LOW;
}

// --- Step 13: calibration/holdout split + evaluation ------------------------

/**
 * Step 13 — deterministic strike-based calibration/holdout split
 * (alternating sorted strikes, not random) targeting ~60-70% calibration.
 */
export function splitCalibrationHoldout(pairs) {
  const sorted = [...pairs].sort((a, b) => a.strike - b.strike);
  const calibration = [], holdout = [];
  sorted.forEach((p, i) => {
    // Keep 2 of every 3 (≈67%) for calibration, alternating deterministically.
    if (i % 3 === 2) holdout.push(p); else calibration.push(p);
  });
  return { calibration, holdout };
}

/**
 * Step 13/14 — prices holdout call+put legs with CRR_AMERICAN_V1 under a
 * given (r, q) and reports call/put/all MAE against market mid.
 */
export function evaluateJointHoldout(holdoutPairs, { spot, timeToExpiryYears: T, discountRate, carryYield, steps = 200 }) {
  const rows = [];
  for (const p of holdoutPairs) {
    for (const [type, leg] of [['call', p.call], ['put', p.put]]) {
      const mid = calibrationMid(leg);
      const { price } = priceCrrAmerican({ option_type: type, spot, strike: p.strike, time_to_expiry_years: T, volatility: leg.iv, risk_free_rate: discountRate, dividend_yield: carryYield, steps });
      rows.push({ type, strike: p.strike, mid, price, abs_error: Math.abs(price - mid) });
    }
  }
  const calls = rows.filter(r => r.type === 'call');
  const puts = rows.filter(r => r.type === 'put');
  const mean = arr => arr.length ? arr.reduce((s, r) => s + r.abs_error, 0) / arr.length : null;
  const callMae = mean(calls), putMae = mean(puts), allMae = mean(rows);
  return { call_mae: callMae, put_mae: putMae, all_mae: allMae, cp_ratio: (callMae && putMae) ? callMae / putMae : null, n: rows.length, rows };
}
