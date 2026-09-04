// Phase 2C, Steps 10-13 — CRR_AMERICAN_SHADOW single-option repricer.
// Pure, no I/O. Mirrors optionRepricer.js's repriceOptionLocalGreeks
// input/output SHAPE exactly (Step 10's "side-by-side shadow pathway")
// so the two can be compared leg-for-leg, but this file does NOT import
// or modify optionRepricer.js / strategyScenarios.js — production values
// are untouched.
//
// Unlike LOCAL_GREEK_APPROXIMATION (anchored to TradingView's current
// theoretical_price), this shadow repricer is fully independent: it
// reprices from spot/strike/remaining-time/IV/discount-rate/carry via
// CRR_AMERICAN_V1 (Step 12 — never anchored to theoretical_price).

import { priceCrrAmerican } from './crrAmerican.js';
import { intrinsicValue, round2 } from '../optionRepricer.js';

export const CRR_SHADOW_WARNINGS = Object.freeze({
  CONSTANT_CONTRACT_IV_SHIFT: 'CONSTANT_CONTRACT_IV_SHIFT',
  MARKET_INPUT_MEDIUM_CONFIDENCE: 'MARKET_INPUT_MEDIUM_CONFIDENCE',
  MARKET_INPUT_LOW_CONFIDENCE: 'MARKET_INPUT_LOW_CONFIDENCE',
});

/**
 * Reprices one option under a hypothetical spot/time/IV scenario using
 * full CRR_AMERICAN_V1 repricing, given externally-sourced discount rate
 * and effective carry yield (Phase 2C's productionMarketInputs.js — never
 * the option-implied joint r/q from Phase 2B.1, which was found
 * NOT_RELIABLE for production use).
 *
 * @param {object} p
 * @param {'call'|'put'} p.optionType
 * @param {number} p.strike
 * @param {number} p.currentUnderlyingPrice
 * @param {number} p.scenarioUnderlyingPrice
 * @param {number} p.daysForward - >= 0
 * @param {number} p.daysToExpiry - contract's current DTE
 * @param {number} p.currentIv - DECIMAL (e.g. 0.334)
 * @param {number} p.scenarioIv - DECIMAL (e.g. 0.384) — same scenario IV
 *   convention as Phase 0B (Step 11): current IV + iv_change_points/100.
 * @param {number} p.discountRate - externally sourced, decimal continuous
 * @param {number} p.effectiveCarryYield - externally sourced, decimal (may be negative)
 * @param {number} [p.steps] - CRR tree steps, default 200 (Phase 2A recommendation)
 */
export function repriceOptionCrrShadow({
  optionType, strike, currentUnderlyingPrice, scenarioUnderlyingPrice,
  daysForward, daysToExpiry, currentIv, scenarioIv,
  discountRate, effectiveCarryYield, steps = 200,
}) {
  if (discountRate == null || effectiveCarryYield == null) {
    return { available: false, warnings: ['MARKET_INPUT_UNAVAILABLE'] };
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

  // Step 15 — exact expiration reconciliation: at/beyond expiry, CRR
  // shadow must fall back to exact intrinsic, identical in kind to
  // LOCAL_GREEK_APPROXIMATION's own expiration handling.
  if (daysForward >= daysToExpiry) {
    const intrinsic = intrinsicValue(optionType, scenarioUnderlyingPrice, strike);
    return {
      available: true,
      pricing_model: 'CRR_AMERICAN_SHADOW',
      final_estimated_value: round2(intrinsic),
      raw_estimated_value: round2(intrinsic),
      intrinsic_floor: round2(intrinsic),
      market_input_confidence: null,
      warnings: [],
    };
  }

  const remainingDte = daysToExpiry - daysForward;
  const T = remainingDte / 365;

  const { price } = priceCrrAmerican({
    option_type: optionType, spot: scenarioUnderlyingPrice, strike,
    time_to_expiry_years: T, volatility: scenarioIv,
    risk_free_rate: discountRate, dividend_yield: effectiveCarryYield, steps,
  });

  const warnings = [CRR_SHADOW_WARNINGS.CONSTANT_CONTRACT_IV_SHIFT];

  return {
    available: true,
    pricing_model: 'CRR_AMERICAN_SHADOW',
    final_estimated_value: round2(price),
    raw_estimated_value: round2(price),
    intrinsic_floor: round2(intrinsicValue(optionType, scenarioUnderlyingPrice, strike)),
    market_input_confidence: null, // filled in by the caller, which knows the market-input record
    warnings,
  };
}
