// Phase 0B — LOCAL_GREEK_APPROXIMATION single-option repricer. Pure, no I/O.
//
// This is explicitly NOT Black-Scholes and NOT a full American-option
// pricer. It is a local Taylor-style extrapolation anchored to TradingView's
// current native theoretical_price, using the contract's own delta/gamma/
// theta/vega. It degrades for large moves, large time steps, and near
// expiration — see the warning flags below, which are generated rather than
// silently trusted.
//
// GREEK UNIT CONVENTIONS (verified against live NVDA data, Phase 0B):
//   theta: already expressed as dollars of decay PER CALENDAR DAY.
//     Verified via Black-Scholes cross-check on OPRA:NVDA260918C227.5
//     (21 DTE, iv=37.67%): estimated per-day theta -0.1951 vs observed
//     contract theta -0.1932 (within ~1%). The annualized alternative
//     (-71.2) is wildly inconsistent with the observed value, ruling it out.
//     => theta_effect = theta * days_forward (no /365 needed).
//   vega: dollars of price change PER 1 PERCENTAGE POINT of IV (i.e. per
//     0.01 change in decimal volatility) — the standard retail convention,
//     not the raw Black-Scholes dV/dsigma (which would be ~100x larger).
//     Verified on the same contract: estimated vega-per-point 0.2175 vs
//     observed contract vega 0.2206 (within ~1.5%).
//     => vega_effect = vega * (iv_change_decimal * 100).
//
// IV is handled in DECIMAL form internally (0.334, not 33.4) per Phase 0B
// Step 6 — callers passing a normalized options_get_chain contract (whose
// `iv` field is already *100, percentage-scaled) must divide by 100 first.

import { PRICING_MODELS, ANCHOR_PRICE_SOURCES, SCENARIO_WARNINGS } from './strategyTypes.js';

function round2(v) {
  if (v == null || !Number.isFinite(v)) return null;
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r; // normalize -0 to 0
}

export function intrinsicValue(optionType, spot, strike) {
  return optionType === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
}

const LARGE_SPOT_MOVE_PCT = 0.15;
const LARGE_IV_CHANGE_POINTS = 15;
const NEAR_EXPIRATION_DTE = 5;

/**
 * Reprices one option under a hypothetical spot/time/IV scenario using a
 * local Greek (Taylor-series) approximation anchored to the contract's
 * current native theoretical_price.
 *
 * @param {object} p
 * @param {'call'|'put'} p.optionType
 * @param {number} p.strike
 * @param {number|null} p.currentTheoreticalPrice
 * @param {number|null} p.delta
 * @param {number|null} p.gamma
 * @param {number|null} p.theta
 * @param {number|null} p.vega
 * @param {number} p.currentUnderlyingPrice
 * @param {number} p.scenarioUnderlyingPrice
 * @param {number} p.daysForward - >= 0
 * @param {number} p.daysToExpiry - contract's current DTE
 * @param {number} p.currentIv - DECIMAL (e.g. 0.334)
 * @param {number} p.scenarioIv - DECIMAL (e.g. 0.384)
 */
export function repriceOptionLocalGreeks({
  optionType, strike, currentTheoreticalPrice, delta, gamma, theta, vega,
  currentUnderlyingPrice, scenarioUnderlyingPrice, daysForward, daysToExpiry,
  currentIv, scenarioIv,
}) {
  if (currentTheoreticalPrice == null) {
    return { available: false, warnings: [SCENARIO_WARNINGS.MISSING_THEORETICAL_PRICE] };
  }
  if (delta == null || gamma == null || theta == null || vega == null) {
    return { available: false, warnings: [SCENARIO_WARNINGS.MISSING_GREEKS] };
  }
  if (!Number.isFinite(daysForward) || daysForward < 0) {
    throw new Error(`Invalid days_forward "${daysForward}". Must be >= 0.`);
  }
  if (!Number.isFinite(currentIv) || currentIv <= 0) {
    throw new Error(`Invalid current_iv "${currentIv}". Must be a positive decimal volatility.`);
  }
  if (!Number.isFinite(scenarioIv) || scenarioIv <= 0) {
    throw new Error(`Invalid scenario_iv "${scenarioIv}". Must be a positive decimal volatility.`);
  }

  // Step 5: horizon at/beyond expiration falls back to exact expiration
  // intrinsic payoff, never the Greek approximation.
  if (daysForward >= daysToExpiry) {
    const intrinsic = intrinsicValue(optionType, scenarioUnderlyingPrice, strike);
    return {
      available: true,
      pricing_model: PRICING_MODELS.EXPIRATION_INTRINSIC,
      anchor_price_source: ANCHOR_PRICE_SOURCES.TRADINGVIEW_THEORETICAL_PRICE,
      current_theoretical_price: round2(currentTheoreticalPrice),
      spot_effect: null,
      gamma_effect: null,
      theta_effect: null,
      vega_effect: null,
      raw_estimated_value: round2(intrinsic),
      intrinsic_floor: round2(intrinsic),
      final_estimated_value: round2(intrinsic),
      warnings: [],
    };
  }

  const remainingDte = daysToExpiry - daysForward;
  const spotChange = scenarioUnderlyingPrice - currentUnderlyingPrice;
  const ivChangeDecimal = scenarioIv - currentIv;
  const ivChangePoints = ivChangeDecimal * 100;

  const spotEffect = delta * spotChange;
  const gammaEffect = 0.5 * gamma * spotChange * spotChange;
  const thetaEffect = theta * daysForward;
  const vegaEffect = vega * ivChangePoints;

  const rawEstimatedValue = currentTheoreticalPrice + spotEffect + gammaEffect + thetaEffect + vegaEffect;
  const intrinsic = intrinsicValue(optionType, scenarioUnderlyingPrice, strike);
  const flooredAtIntrinsic = Math.max(rawEstimatedValue, intrinsic);
  const finalValue = Math.max(flooredAtIntrinsic, 0);

  const warnings = [];
  if (rawEstimatedValue < intrinsic) warnings.push(SCENARIO_WARNINGS.INTRINSIC_FLOOR_APPLIED);
  if (Math.abs(spotChange / currentUnderlyingPrice) > LARGE_SPOT_MOVE_PCT) warnings.push(SCENARIO_WARNINGS.LARGE_SPOT_MOVE);
  if (Math.abs(ivChangePoints) > LARGE_IV_CHANGE_POINTS) warnings.push(SCENARIO_WARNINGS.LARGE_IV_CHANGE);
  if (daysForward > Math.min(30, 0.5 * daysToExpiry)) warnings.push(SCENARIO_WARNINGS.LARGE_TIME_STEP);
  if (remainingDte <= NEAR_EXPIRATION_DTE) warnings.push(SCENARIO_WARNINGS.NEAR_EXPIRATION);

  return {
    available: true,
    pricing_model: PRICING_MODELS.LOCAL_GREEK_APPROXIMATION,
    anchor_price_source: ANCHOR_PRICE_SOURCES.TRADINGVIEW_THEORETICAL_PRICE,
    current_theoretical_price: round2(currentTheoreticalPrice),
    spot_effect: round2(spotEffect),
    gamma_effect: round2(gammaEffect),
    theta_effect: round2(thetaEffect),
    vega_effect: round2(vegaEffect),
    raw_estimated_value: round2(rawEstimatedValue),
    intrinsic_floor: round2(intrinsic),
    final_estimated_value: round2(finalValue),
    warnings,
  };
}

export { round2 };
