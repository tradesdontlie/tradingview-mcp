// Phase 2B — shared types/constants for the pure market-input / implied-
// carry calibration modules. No TradingView/CDP imports anywhere under
// src/core/options/marketInputs/ — these modules take plain numeric
// inputs (quotes already retrieved elsewhere) and return plain structured
// output. NOT wired into strategyScenarios.js / ranking / confidence /
// options_analyze_directional in this phase — calibration/benchmark only.

export const DISCOUNT_RATE_SOURCES = Object.freeze({
  US_TREASURY_BILL_COUPON_EQUIVALENT: 'US_TREASURY_BILL_COUPON_EQUIVALENT',
  SOFR_OVERNIGHT_ANCHOR: 'SOFR_OVERNIGHT_ANCHOR',
  USER_OVERRIDE: 'USER_OVERRIDE',
});

export const CARRY_ESTIMATORS = Object.freeze({
  // Step 8/9 — derived from a synthetic forward via approximate American
  // put-call parity. Explicitly NOT exact (see AMERICAN_PARITY_APPROXIMATION).
  PARITY_IMPLIED_CARRY: 'PARITY_IMPLIED_CARRY',
  // Step 12 — one common carry fit to minimize CRR_AMERICAN_V1 pricing
  // error across a set of call+put mids for one expiration.
  CRR_IMPLIED_CARRY_FIT: 'CRR_IMPLIED_CARRY_FIT',
});

export const CARRY_CONFIDENCE = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
});

export const CALIBRATION_WARNINGS = Object.freeze({
  AMERICAN_PARITY_APPROXIMATION: 'AMERICAN_PARITY_APPROXIMATION',
  EXTREME_EFFECTIVE_CARRY: 'EXTREME_EFFECTIVE_CARRY',
  CARRY_ESTIMATORS_DISAGREE: 'CARRY_ESTIMATORS_DISAGREE',
  INSUFFICIENT_PAIRS: 'INSUFFICIENT_PAIRS',
  // Phase 2B.1 additions:
  ESTIMATOR_BOUND_HIT: 'ESTIMATOR_BOUND_HIT',
  JOINT_ESTIMATOR_NOT_CONVERGED: 'JOINT_ESTIMATOR_NOT_CONVERGED',
  TERM_STRUCTURE_DISCONTINUITY: 'TERM_STRUCTURE_DISCONTINUITY',
  DISCRETE_DIVIDEND_WINDOW: 'DISCRETE_DIVIDEND_WINDOW',
});

// Phase 2B.1, Step 2 — calibration-quality liquidity tiers, distinct from
// Phase 0A's execution gates. STRICT is preferred; DIAGNOSTIC must never
// be treated as a production-ready result (see impliedCarryConfidence.js).
export const CALIBRATION_LIQUIDITY_TIERS = Object.freeze({
  STRICT: 'STRICT',       // max leg spread 5%
  STANDARD: 'STANDARD',   // max leg spread 10%
  DIAGNOSTIC: 'DIAGNOSTIC', // max leg spread 20%, diagnostic only
});

export const JOINT_CARRY_ESTIMATORS = Object.freeze({
  RAW_PARITY_JOINT_ESTIMATE: 'RAW_PARITY_JOINT_ESTIMATE',
  AMERICAN_CORRECTED_JOINT_CARRY: 'AMERICAN_CORRECTED_JOINT_CARRY',
});

// Step 7 — mid prices used for calibration are explicitly NOT an execution
// price assumption (Phase 0A's conservative/mid execution_model is a
// separate, already-defined concept for actual strategy economics).
export const CALIBRATION_MARK_LABEL = 'CALIBRATION_MARK_MID';

/**
 * Step 2 — normalized per-expiration market input record. This is the
 * target shape rateNormalization.js / impliedCarry.js populate; not a
 * class, just documentation of the expected object shape.
 *
 * @typedef {object} NormalizedMarketInput
 * @property {number} discount_rate - decimal, continuously compounded
 * @property {'CONTINUOUS'} discount_rate_compounding
 * @property {string} discount_rate_source - one of DISCOUNT_RATE_SOURCES
 * @property {string} discount_rate_as_of - ISO date the source rate was observed
 * @property {number|null} effective_carry_yield - decimal, continuous; null if not estimated
 * @property {string|null} effective_carry_source - one of CARRY_ESTIMATORS
 * @property {string|null} effective_carry_confidence - one of CARRY_CONFIDENCE
 * @property {string} expiration - ISO date
 * @property {number} time_to_expiry_years
 * @property {object} diagnostics
 */

/**
 * Step 22 — future full market-input snapshot shape (design only, not
 * implemented/wired as a provider in this phase).
 *
 * @typedef {object} MarketInputSnapshot
 * @property {string} symbol
 * @property {number} spot
 * @property {string} as_of_utc
 * @property {string} discount_curve_source
 * @property {Array<{expiration: string, discount_rate: number}>} discount_rate_by_expiry
 * @property {Array<{expiration: string, dte: number, effective_carry_yield: number, estimator: string, confidence: string, pair_count: number, dispersion: object}>} effective_carry_by_expiry
 */

export function assertPositiveFinite(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number, got: ${value}`);
  }
}

export function assertFinite(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number, got: ${value}`);
  }
}
