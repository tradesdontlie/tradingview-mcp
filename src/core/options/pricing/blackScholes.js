// Phase 2A — Black-Scholes-Merton EUROPEAN reference pricer.
//
// Purpose: REFERENCE / INVARIANT TESTING ONLY. This is not the production
// American-option model — US equity/ETF options are American-style, and
// this closed-form pricer does not model early exercise. It exists so the
// CRR binomial tree (crrAmerican.js) can be validated against a known
// closed-form value (Step 2, Step 9-C: American call ≈ European call for a
// non-dividend-paying underlying, within convergence tolerance).
//
// Continuous compounding throughout. No TradingView/CDP imports.

import { PRICING_MODEL_IDS, EXERCISE_STYLES, assertPositiveFinite, assertNonNegativeFinite, assertFinite } from './pricingTypes.js';

const SQRT_2PI = Math.sqrt(2 * Math.PI);

function stdNormPdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

// Abramowitz & Stegun 7.1.26 approximation of the standard normal CDF.
// Max absolute error ~7.5e-8 — more than sufficient for option pricing.
function stdNormCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function validateInputs({ spot, strike, time_to_expiry_years, volatility, risk_free_rate, dividend_yield }) {
  assertPositiveFinite('spot', spot);
  assertPositiveFinite('strike', strike);
  assertNonNegativeFinite('time_to_expiry_years', time_to_expiry_years);
  assertNonNegativeFinite('volatility', volatility);
  assertFinite('risk_free_rate', risk_free_rate);
  // Signed: see crrAmerican.js's validateInputs for why dividend_yield may be negative.
  assertFinite('dividend_yield', dividend_yield ?? 0);
}

/**
 * Black-Scholes-Merton price for a EUROPEAN call or put on a continuously
 * dividend-paying underlying.
 *
 * @param {object} input
 * @param {'call'|'put'} input.option_type
 * @param {number} input.spot
 * @param {number} input.strike
 * @param {number} input.time_to_expiry_years
 * @param {number} input.volatility - decimal annualized, e.g. 0.30
 * @param {number} input.risk_free_rate - decimal annualized, continuous compounding
 * @param {number} [input.dividend_yield] - decimal annualized continuous yield, default 0
 */
export function priceBlackScholes(input) {
  const { option_type, spot, strike } = input;
  const time_to_expiry_years = input.time_to_expiry_years;
  const volatility = input.volatility;
  const risk_free_rate = input.risk_free_rate;
  const dividend_yield = input.dividend_yield ?? 0;

  if (option_type !== 'call' && option_type !== 'put') {
    throw new Error(`option_type must be "call" or "put", got: ${option_type}`);
  }
  validateInputs({ spot, strike, time_to_expiry_years, volatility, risk_free_rate, dividend_yield });

  const intrinsic = option_type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);

  // At expiry (or with zero vol at T=0), the option is worth exactly intrinsic.
  if (time_to_expiry_years === 0) {
    return buildResult(option_type, intrinsic, input, dividend_yield, []);
  }
  if (volatility === 0) {
    // Degenerate but well-defined: forward value of intrinsic-at-expiry payoff.
    const forwardSpot = spot * Math.exp(-dividend_yield * time_to_expiry_years);
    const discStrike = strike * Math.exp(-risk_free_rate * time_to_expiry_years);
    const value = option_type === 'call'
      ? Math.max(forwardSpot - discStrike, 0)
      : Math.max(discStrike - forwardSpot, 0);
    return buildResult(option_type, round(value), input, dividend_yield, ['ZERO_VOLATILITY_DEGENERATE_CASE']);
  }

  const sqrtT = Math.sqrt(time_to_expiry_years);
  const d1 = (Math.log(spot / strike) + (risk_free_rate - dividend_yield + 0.5 * volatility * volatility) * time_to_expiry_years) / (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;

  const discFactorR = Math.exp(-risk_free_rate * time_to_expiry_years);
  const discFactorQ = Math.exp(-dividend_yield * time_to_expiry_years);

  let value;
  if (option_type === 'call') {
    value = spot * discFactorQ * stdNormCdf(d1) - strike * discFactorR * stdNormCdf(d2);
  } else {
    value = strike * discFactorR * stdNormCdf(-d2) - spot * discFactorQ * stdNormCdf(-d1);
  }

  if (!Number.isFinite(value) || value < 0) {
    // Numerically this should not happen for valid inputs; guard against it
    // rather than ever returning NaN/negative to a caller.
    value = Math.max(intrinsic, 0);
  }

  return buildResult(option_type, round(value), input, dividend_yield, []);
}

function round(x) {
  return Math.round(x * 1e6) / 1e6;
}

function buildResult(option_type, price, input, dividend_yield, warnings) {
  return {
    price,
    pricing_model: PRICING_MODEL_IDS.BLACK_SCHOLES_REFERENCE,
    exercise_style: EXERCISE_STYLES.EUROPEAN,
    input_assumptions: {
      option_type,
      spot: input.spot,
      strike: input.strike,
      time_to_expiry_years: input.time_to_expiry_years,
      volatility: input.volatility,
      risk_free_rate: input.risk_free_rate,
      dividend_yield,
      compounding: 'CONTINUOUS',
    },
    warnings,
  };
}

// Exported for potential future Greeks work / testing; not used elsewhere in Phase 2A.
export { stdNormCdf, stdNormPdf };
