// Phase 2A — shared types/constants for the pure option-pricing modules.
// No TradingView/CDP imports anywhere under src/core/options/pricing/ —
// these modules take plain numeric inputs and return plain numeric outputs.
// They are NOT wired into the live scenario engine (strategyScenarios.js /
// optionRepricer.js) yet — see directionalAnalysis.js's LOCAL_GREEK_APPROXIMATION
// path, which remains the production repricer for Phase 2A.

export const PRICING_MODEL_IDS = Object.freeze({
  BLACK_SCHOLES_REFERENCE: 'BLACK_SCHOLES_REFERENCE',
  CRR_AMERICAN_V1: 'CRR_AMERICAN_V1',
});

export const EXERCISE_STYLES = Object.freeze({
  EUROPEAN: 'EUROPEAN',
  AMERICAN: 'AMERICAN',
});

export const DIVIDEND_MODELS = Object.freeze({
  // V1 only supports a flat continuous-yield approximation — it does NOT
  // model discrete dividend payments or ex-dividend dates. See Step 6/K.
  CONTINUOUS_YIELD: 'CONTINUOUS_YIELD',
});

/**
 * Future market-input contract (Step 12). This is a *shape definition
 * only* — no provider is implemented in Phase 2A, and nothing in
 * src/core/options/pricing/ performs network I/O to populate it.
 *
 * @typedef {object} MarketRateInput
 * @property {number} risk_free_rate - decimal annualized, e.g. 0.045
 * @property {string} risk_free_rate_source - e.g. 'US_TREASURY_CURVE' | 'USER_OVERRIDE'
 * @property {number} dividend_yield - decimal annualized, e.g. 0.008
 * @property {string} dividend_yield_source - e.g. 'TRADINGVIEW_OR_FUNDAMENTAL_DIVIDEND_DATA' | 'USER_OVERRIDE' | 'ASSUMED_ZERO'
 * @property {string} as_of_utc - ISO timestamp the rates were observed
 */

export function assertPositiveFinite(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number, got: ${value}`);
  }
}

export function assertNonNegativeFinite(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number, got: ${value}`);
  }
}

export function assertFinite(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number, got: ${value}`);
  }
}
