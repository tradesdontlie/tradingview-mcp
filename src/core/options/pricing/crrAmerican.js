// Phase 2A — Cox-Ross-Rubinstein (CRR) binomial pricer for AMERICAN-style
// options, V1.
//
// SCOPE (Step 7): standard US equity/ETF American-style options only.
// Caller is responsible for only invoking this for instruments that are
// actually American-style — this module does not inspect the underlying's
// exercise style itself (no generic index support; adjusted/non-standard
// contracts are out of scope).
//
// DIVIDEND MODEL (Step 6): V1 supports a flat CONTINUOUS_DIVIDEND_YIELD
// only. It does NOT model discrete dividend payments, ex-dividend dates,
// or special dividends. dividend_model is always reported as
// "CONTINUOUS_YIELD" in the result so callers cannot mistake this for a
// discrete-dividend model.
//
// NOT WIRED INTO PRODUCTION: this module is pure and side-effect free (no
// TradingView/CDP imports) and is not called from directionalAnalysis.js,
// strategyScenarios.js, or optionRepricer.js in Phase 2A. It also does not
// compute Greeks (Step 19) — price only.

import { PRICING_MODEL_IDS, EXERCISE_STYLES, DIVIDEND_MODELS, assertPositiveFinite, assertNonNegativeFinite, assertFinite } from './pricingTypes.js';

function validateInputs({ option_type, spot, strike, time_to_expiry_years, volatility, risk_free_rate, dividend_yield, steps }) {
  if (option_type !== 'call' && option_type !== 'put') {
    throw new Error(`option_type must be "call" or "put", got: ${option_type}`);
  }
  assertPositiveFinite('spot', spot);
  assertPositiveFinite('strike', strike);
  assertNonNegativeFinite('time_to_expiry_years', time_to_expiry_years);
  assertPositiveFinite('volatility', volatility);
  assertFinite('risk_free_rate', risk_free_rate);
  // Signed: a caller may pass a negative effective_carry_yield (Phase 2B
  // market-input calibration allows negative implied carry; a plain
  // dividend yield is never negative in practice, but this pricer doesn't
  // know which concept the caller is using).
  assertFinite('dividend_yield', dividend_yield ?? 0);
  if (!Number.isInteger(steps) || steps <= 0) {
    throw new Error(`steps must be a positive integer, got: ${steps}`);
  }
}

/**
 * CRR binomial price for an AMERICAN call or put on a continuously
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
 * @param {number} input.steps - number of binomial tree steps (positive integer)
 * @param {object} [opts]
 * @param {boolean} [opts.diagnostics] - if true, include early_exercise_node_count
 *   (test/debug only — not meant for production output, Step 18).
 */
export function priceCrrAmerican(input, opts = {}) {
  const option_type = input.option_type;
  const spot = input.spot;
  const strike = input.strike;
  const T = input.time_to_expiry_years;
  const volatility = input.volatility;
  const r = input.risk_free_rate;
  const q = input.dividend_yield ?? 0;
  const steps = input.steps;

  validateInputs({ option_type, spot, strike, time_to_expiry_years: T, volatility, risk_free_rate: r, dividend_yield: q, steps });

  const intrinsicNow = option_type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);

  // Step 4 — at T=0 return intrinsic exactly, no tree construction.
  if (T === 0) {
    return buildResult(intrinsicNow, input, q, steps, [], opts.diagnostics ? 0 : undefined);
  }

  const dt = T / steps;
  const u = Math.exp(volatility * Math.sqrt(dt));
  const d = 1 / u;
  const discount = Math.exp(-r * dt);
  const growth = Math.exp((r - q) * dt);
  const p = (growth - d) / (u - d);

  const warnings = [];
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    // Step 4 — reject/flag an invalid risk-neutral probability rather than
    // silently producing a nonsensical price. This can happen with
    // pathological inputs (e.g. dt too large relative to volatility/rate
    // combination for the chosen step count).
    throw new Error(
      `Invalid risk-neutral probability p=${p} (u=${u}, d=${d}, growth=${growth}). `
      + 'Inputs produce a degenerate CRR tree — check volatility/rate/steps.',
    );
  }

  // Terminal underlying prices and terminal option values, index i = number of up-moves.
  const terminalValues = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const terminalSpot = spot * Math.pow(u, i) * Math.pow(d, steps - i);
    terminalValues[i] = option_type === 'call' ? Math.max(terminalSpot - strike, 0) : Math.max(strike - terminalSpot, 0);
  }

  let earlyExerciseNodeCount = 0;

  // Backward induction: at each node, value = max(continuation, intrinsic).
  // This is the step that makes the tree AMERICAN rather than European —
  // never skip the intrinsic comparison (Step 3).
  let values = terminalValues;
  for (let step = steps - 1; step >= 0; step--) {
    const next = new Float64Array(step + 1);
    for (let i = 0; i <= step; i++) {
      const continuation = discount * (p * values[i + 1] + (1 - p) * values[i]);
      const nodeSpot = spot * Math.pow(u, i) * Math.pow(d, step - i);
      const intrinsic = option_type === 'call' ? Math.max(nodeSpot - strike, 0) : Math.max(strike - nodeSpot, 0);
      const nodeValue = Math.max(continuation, intrinsic);
      if (opts.diagnostics && intrinsic > continuation) earlyExerciseNodeCount++;
      next[i] = nodeValue;
    }
    values = next;
  }

  let price = values[0];
  if (!Number.isFinite(price) || price < 0) {
    // Never return NaN/Infinity/negative (Step 4) — fall back to intrinsic,
    // which is always a valid lower bound.
    price = intrinsicNow;
    warnings.push('NUMERICAL_FALLBACK_TO_INTRINSIC');
  }

  return buildResult(round(price), input, q, steps, warnings, opts.diagnostics ? earlyExerciseNodeCount : undefined);
}

function round(x) {
  return Math.round(x * 1e6) / 1e6;
}

function buildResult(price, input, dividend_yield, steps, warnings, earlyExerciseNodeCount) {
  const result = {
    price,
    pricing_model: PRICING_MODEL_IDS.CRR_AMERICAN_V1,
    exercise_style: EXERCISE_STYLES.AMERICAN,
    dividend_model: DIVIDEND_MODELS.CONTINUOUS_YIELD,
    steps: input.steps,
    risk_free_rate: input.risk_free_rate,
    dividend_yield,
    input_assumptions: {
      option_type: input.option_type,
      spot: input.spot,
      strike: input.strike,
      time_to_expiry_years: input.time_to_expiry_years,
      volatility: input.volatility,
      compounding: 'CONTINUOUS',
      exercise_style_scope: 'US_EQUITY_ETF_STANDARD_ONLY',
    },
    warnings,
  };
  if (earlyExerciseNodeCount !== undefined) result.early_exercise_node_count = earlyExerciseNodeCount;
  return result;
}
