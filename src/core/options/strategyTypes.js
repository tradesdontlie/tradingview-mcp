// Phase 0A — Deterministic Options Strategy Economics Engine.
//
// This module (and its siblings strategyEconomics.js / strategyCandidates.js)
// is a PURE domain layer: no TradingView, no CDP, no browser, no network,
// no LLM. It operates only on already-normalized option-chain contracts
// (the shape produced by options_get_chain) and explicit numeric requests.
//
// This separation exists so a future data provider (ThetaData, IBKR, etc.)
// can replace TradingView without rewriting any strategy math.

export const STRATEGY_TYPES = Object.freeze({
  LONG_CALL: 'LONG_CALL',
  LONG_PUT: 'LONG_PUT',
  BULL_CALL_SPREAD: 'BULL_CALL_SPREAD',
  BEAR_PUT_SPREAD: 'BEAR_PUT_SPREAD',
  BUY_STOCK: 'BUY_STOCK',
  NO_TRADE: 'NO_TRADE',
});

export const EXECUTION_MODELS = Object.freeze({
  CONSERVATIVE: 'conservative',
  MID: 'mid',
});

export const MAX_PROFIT_TYPES = Object.freeze({
  UNLIMITED: 'UNLIMITED',
  DEFINED: 'DEFINED',
});

export const BASELINE_TYPES = Object.freeze({
  UNDERLYING: 'UNDERLYING',
});

export const CHAIN_COMPLETENESS = Object.freeze({
  COMPLETE: 'COMPLETE',
  POSSIBLY_TRUNCATED: 'POSSIBLY_TRUNCATED',
});

export const PAYOFF_TYPES = Object.freeze({
  EXPIRATION_INTRINSIC: 'EXPIRATION_INTRINSIC',
});

// Rejection reasons — every discarded contract or candidate must carry one
// of these, and every rejection must be counted (never silently dropped).
export const REJECTION_REASONS = Object.freeze({
  CROSSED_MARKET: 'CROSSED_MARKET',
  MISSING_BID: 'MISSING_BID',
  MISSING_ASK: 'MISSING_ASK',
  INVALID_ASK: 'INVALID_ASK',
  MISSING_IV: 'MISSING_IV',
  MISSING_GREEKS: 'MISSING_GREEKS',
  WIDE_SPREAD: 'WIDE_SPREAD',
  SHORT_LEG_ZERO_BID: 'SHORT_LEG_ZERO_BID',
  EXPIRY_BEFORE_HORIZON: 'EXPIRY_BEFORE_HORIZON',
  OUTSIDE_DTE_WINDOW: 'OUTSIDE_DTE_WINDOW',
  DELTA_OUT_OF_RANGE: 'DELTA_OUT_OF_RANGE',
  STRIKE_ORDER_INVALID: 'STRIKE_ORDER_INVALID',
  WIDTH_EXCEEDED: 'WIDTH_EXCEEDED',
  NON_POSITIVE_DEBIT: 'NON_POSITIVE_DEBIT',
  MAX_LOSS_EXCEEDED: 'MAX_LOSS_EXCEEDED',
  INSUFFICIENT_CAPITAL_FOR_SHARE: 'INSUFFICIENT_CAPITAL_FOR_SHARE',
});

export const CONTRACT_MULTIPLIER_SOURCE = Object.freeze({
  ASSUMED_STANDARD_US_EQUITY_OPTION: 'ASSUMED_STANDARD_US_EQUITY_OPTION',
});

// Phase 0B — scenario/mark-to-market pricing models. LOCAL_GREEK_APPROXIMATION
// is the only one implemented; AMERICAN_OPTION_MODEL is a reserved name for a
// future proper American-option repricer (not implemented — see strategyScenarios.js
// header for the interface future pricers must satisfy).
export const PRICING_MODELS = Object.freeze({
  LOCAL_GREEK_APPROXIMATION: 'LOCAL_GREEK_APPROXIMATION',
  EXPIRATION_INTRINSIC: 'EXPIRATION_INTRINSIC',
  AMERICAN_OPTION_MODEL: 'AMERICAN_OPTION_MODEL', // reserved, not implemented
});

export const ANCHOR_PRICE_SOURCES = Object.freeze({
  TRADINGVIEW_THEORETICAL_PRICE: 'TRADINGVIEW_THEORETICAL_PRICE',
});

// Phase 0B — approximation safety flags (Step 4). These are warnings, never
// silent confidence: the local-Greek approximation degrades for large moves,
// large time steps, and near expiration.
export const SCENARIO_WARNINGS = Object.freeze({
  LARGE_SPOT_MOVE: 'LARGE_SPOT_MOVE',
  LARGE_IV_CHANGE: 'LARGE_IV_CHANGE',
  LARGE_TIME_STEP: 'LARGE_TIME_STEP',
  NEAR_EXPIRATION: 'NEAR_EXPIRATION',
  INTRINSIC_FLOOR_APPLIED: 'INTRINSIC_FLOOR_APPLIED',
  MISSING_THEORETICAL_PRICE: 'MISSING_THEORETICAL_PRICE',
  MISSING_GREEKS: 'MISSING_GREEKS',
});

// Phase 0C — deterministic ranking. RANKING_MODEL_V1 is a versioned,
// absolute (non-percentile) heuristic comparative score. It is explicitly
// NOT a probability, expected return, or win rate — see score_disclaimer
// on the ranking output.
export const RANKING_MODEL_VERSION = 'RANKING_MODEL_V1';

export const CONFIDENCE_LEVELS = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
});

export const RANKING_CLASSES = Object.freeze({
  TRADE: 'TRADE',
  UNDERLYING_BASELINE: 'UNDERLYING_BASELINE',
  BASELINE: 'BASELINE',
});

export const DECISION_STATES = Object.freeze({
  TRADE_CANDIDATES_AVAILABLE: 'TRADE_CANDIDATES_AVAILABLE',
  NO_TRADE_BASELINE_ONLY: 'NO_TRADE_BASELINE_ONLY',
});

export const REWARD_RISK_TYPES = Object.freeze({
  DEFINED: 'DEFINED',
  UNBOUNDED_UPSIDE: 'UNBOUNDED_UPSIDE',
  UNDERLYING_BASELINE: 'UNDERLYING_BASELINE',
});

// Extend the Phase 0A rejection vocabulary with Phase 0C ranking-stage reasons.
export const RANKING_REJECTION_REASONS = Object.freeze({
  SCENARIO_DATA_UNAVAILABLE: 'SCENARIO_DATA_UNAVAILABLE',
  CAPPED_REWARD_RISK_BELOW_MINIMUM: 'CAPPED_REWARD_RISK_BELOW_MINIMUM',
  SCORE_BELOW_THRESHOLD: 'SCORE_BELOW_THRESHOLD',
  CONFIDENCE_BELOW_THRESHOLD: 'CONFIDENCE_BELOW_THRESHOLD',
});
