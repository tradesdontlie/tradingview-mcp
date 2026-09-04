// Phase 2C — production-oriented (but NOT yet production-wired) external
// market input contract. Pure, no TradingView/CDP imports. Composes a
// discount rate (Phase 2B's validated Treasury-bill normalization),
// a dividend input (via an injected DividendDataProvider), and a borrow
// input (via an injected BorrowDataProvider) into one normalized,
// per-expiration record for the CRR shadow pricer.
//
// Explicitly does NOT reuse Phase 2B.1's option-implied joint r/q as a
// primary input (that phase's verdict was NOT_RELIABLE for production use
// — see docs/phase-2b1-joint-carry-regression.md). Those modules remain
// research/diagnostic only.

import { createHash } from 'node:crypto';
import { normalizeTreasuryDiscountRate } from './rateNormalization.js';
import { assertFinite, assertPositiveFinite } from './marketInputTypes.js';

/**
 * Phase 2C.1, Step 21 — deterministic id from the normalized inputs that
 * actually went into a shadow comparison. Does NOT imply the underlying
 * timestamps (TradingView spot/chain, Treasury, IBKR) were identical —
 * those are returned separately by the caller.
 */
export function buildShadowSnapshotId(normalizedInputs) {
  const canonical = JSON.stringify(normalizedInputs, Object.keys(normalizedInputs).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export const DIVIDEND_MODES = Object.freeze({
  DISCRETE_DIVIDENDS: 'DISCRETE_DIVIDENDS',
  FORWARD_ANNUAL_DIVIDEND_APPROXIMATION: 'FORWARD_ANNUAL_DIVIDEND_APPROXIMATION',
  TRAILING_DIVIDEND_YIELD_APPROXIMATION: 'TRAILING_DIVIDEND_YIELD_APPROXIMATION',
  ZERO_DIVIDEND_CONFIRMED: 'ZERO_DIVIDEND_CONFIRMED',
  DIVIDEND_DATA_UNAVAILABLE: 'DIVIDEND_DATA_UNAVAILABLE',
});

export const MARKET_INPUT_MODES = Object.freeze({
  FULL_EXTERNAL_INPUTS: 'FULL_EXTERNAL_INPUTS',
  PARTIAL_EXTERNAL_INPUTS: 'PARTIAL_EXTERNAL_INPUTS',
  MARKET_INPUT_UNAVAILABLE: 'MARKET_INPUT_UNAVAILABLE',
});

export const MARKET_INPUT_WARNINGS = Object.freeze({
  BORROW_DATA_UNAVAILABLE: 'BORROW_DATA_UNAVAILABLE',
  DIVIDEND_DATA_UNAVAILABLE: 'DIVIDEND_DATA_UNAVAILABLE',
  MARKET_INPUT_UNAVAILABLE: 'MARKET_INPUT_UNAVAILABLE',
  TREASURY_DATA_STALE: 'TREASURY_DATA_STALE',
});

/**
 * Step 2 — production discount-rate resolution. Wraps Phase 2B's already-
 * validated Treasury-bill coupon-equivalent normalization. If `billRates`
 * is not supplied (no live Treasury data reachable), returns
 * MARKET_INPUT_UNAVAILABLE rather than silently reusing stale data —
 * unless `staleFallback` is explicitly supplied by the caller (a
 * configurable staleness policy, not a silent default).
 */
export function resolveDiscountRate({ dte, billRates, asOfDate, staleFallback = null }) {
  if (billRates == null || asOfDate == null) {
    if (staleFallback) {
      return { ...staleFallback, discount_rate_source: 'TREASURY_BILL_COUPON_EQUIVALENT_NORMALIZED_STALE_FALLBACK', warnings: [MARKET_INPUT_WARNINGS.TREASURY_DATA_STALE] };
    }
    return { discount_rate: null, discount_rate_source: 'MARKET_INPUT_UNAVAILABLE', discount_rate_as_of_utc: null, warnings: [MARKET_INPUT_WARNINGS.MARKET_INPUT_UNAVAILABLE] };
  }
  const r = normalizeTreasuryDiscountRate({ dte, billRates, asOfDate });
  return {
    discount_rate: r.discount_rate,
    discount_rate_source: 'TREASURY_BILL_COUPON_EQUIVALENT_NORMALIZED',
    discount_rate_as_of_utc: asOfDate,
    diagnostics: r.diagnostics,
    warnings: [],
  };
}

/**
 * Step 3 — normalizes a dividend input into one of the five documented
 * modes. Never converts "unavailable" into a silent zero (Step 3's last
 * rule) — DIVIDEND_DATA_UNAVAILABLE stays null, distinct from
 * ZERO_DIVIDEND_CONFIRMED (Step 9), which must be explicitly asserted by
 * the caller, never inferred from a null/zero field.
 */
export function resolveDividendInput({ mode, spot, expected12mDividendPerShare, trailingYieldDecimal, source, asOfUtc, confidence }) {
  if (mode === DIVIDEND_MODES.ZERO_DIVIDEND_CONFIRMED) {
    return { mode, annualized_yield: 0, expected_cash_dividends: [], source, as_of_utc: asOfUtc, confidence: confidence ?? 'HIGH', warnings: [] };
  }
  if (mode === DIVIDEND_MODES.DIVIDEND_DATA_UNAVAILABLE) {
    return { mode, annualized_yield: null, expected_cash_dividends: null, source: source ?? null, as_of_utc: asOfUtc ?? null, confidence: 'LOW', warnings: [MARKET_INPUT_WARNINGS.DIVIDEND_DATA_UNAVAILABLE] };
  }
  if (mode === DIVIDEND_MODES.FORWARD_ANNUAL_DIVIDEND_APPROXIMATION) {
    assertPositiveFinite('spot', spot);
    assertFinite('expected12mDividendPerShare', expected12mDividendPerShare);
    const q = expected12mDividendPerShare / spot;
    return { mode, annualized_yield: q, expected_cash_dividends: null, source, as_of_utc: asOfUtc, confidence: confidence ?? 'MEDIUM', warnings: ['CONTINUOUS_DIVIDEND_APPROXIMATION'] };
  }
  if (mode === DIVIDEND_MODES.TRAILING_DIVIDEND_YIELD_APPROXIMATION) {
    assertFinite('trailingYieldDecimal', trailingYieldDecimal);
    return { mode, annualized_yield: trailingYieldDecimal, expected_cash_dividends: null, source, as_of_utc: asOfUtc, confidence: confidence ?? 'LOW', warnings: ['CONTINUOUS_DIVIDEND_APPROXIMATION', 'TRAILING_NOT_FORWARD'] };
  }
  if (mode === DIVIDEND_MODES.DISCRETE_DIVIDENDS) {
    throw new Error('DISCRETE_DIVIDENDS mode requires expected_cash_dividends and is not yet implemented in V1 (Step 18: full discrete-dividend CRR is out of scope for Phase 2C) — use FORWARD_ANNUAL_DIVIDEND_APPROXIMATION instead.');
  }
  throw new Error(`Unknown dividend mode: ${mode}`);
}

/**
 * Step 5 — normalizes a borrow input. If no live BorrowDataProvider is
 * connected, fee_rate stays null with BORROW_DATA_UNAVAILABLE — never
 * silently treated as 0 (Step 5's explicit rule).
 */
export function resolveBorrowInput({ connected, feeRate, source, asOfUtc, confidence, shortableStatus }) {
  if (!connected || feeRate == null) {
    return { fee_rate: null, source: source ?? 'NOT_CONNECTED', as_of_utc: asOfUtc ?? null, confidence: 'LOW', availability: shortableStatus ?? 'UNKNOWN', warnings: [MARKET_INPUT_WARNINGS.BORROW_DATA_UNAVAILABLE] };
  }
  assertFinite('feeRate', feeRate);
  return { fee_rate: feeRate, source, as_of_utc: asOfUtc, confidence: confidence ?? 'MEDIUM', availability: shortableStatus ?? 'UNKNOWN', warnings: [] };
}

/**
 * Step 7 — EFFECTIVE CRR CARRY, sign convention.
 *
 * effective_carry_yield = dividend_yield_component + borrow_fee_rate
 *
 * Economic justification: CRR_AMERICAN_V1's `dividend_yield` parameter q
 * enters the risk-neutral growth factor as e^{(r-q)T} — a larger q lowers
 * the synthetic forward price, which lowers call value and raises put
 * value (standard dividend effect). A stock-loan/borrow fee paid by a
 * short seller has the SAME directional effect on the synthetic forward:
 * a hard-to-borrow stock's forward trades cheaper (relative to spot) than
 * r alone would imply, because the marginal short-seller/hedger must pay
 * the borrow fee on top of foregoing interest — economically identical in
 * direction to a dividend from the forward-pricing perspective. Both
 * therefore enter this pricer additively, with the SAME sign, as an
 * increment to q. This is verified by a dedicated unit test
 * (marketConventions.test.js) showing a higher fee_rate lowers call value
 * and raises put value in exactly the same direction as a higher dividend
 * yield, for the same-sign, same-magnitude input.
 *
 * If this convention is ever found NOT to hold directionally under test,
 * per Step 7 this module must stop shipping it, not silently continue.
 */
export function computeEffectiveCarryYield({ dividendYield, borrowFeeRate }) {
  const divComponent = dividendYield ?? 0;
  const borrowComponent = borrowFeeRate ?? 0;
  return divComponent + borrowComponent;
}

/**
 * Step 1/8 — assembles one normalized per-expiration market input record.
 * Determines FULL_EXTERNAL_INPUTS vs PARTIAL_EXTERNAL_INPUTS vs
 * MARKET_INPUT_UNAVAILABLE and caps overall_confidence at MEDIUM whenever
 * borrow is unavailable (Step 8 — never silently full-input confidence).
 */
export function buildMarketInputRecord({ expiration, daysToExpiry, discount, dividend, borrow }) {
  const warnings = [...(discount.warnings ?? []), ...(dividend.warnings ?? []), ...(borrow.warnings ?? [])];

  if (discount.discount_rate == null || dividend.annualized_yield == null) {
    return {
      expiration, days_to_expiry: daysToExpiry,
      discount_rate: discount.discount_rate, discount_rate_source: discount.discount_rate_source, discount_rate_as_of_utc: discount.discount_rate_as_of_utc,
      dividend_input: dividend, borrow_input: borrow,
      effective_carry_yield: null,
      mode: MARKET_INPUT_MODES.MARKET_INPUT_UNAVAILABLE,
      overall_confidence: 'LOW',
      warnings: [...new Set(warnings)],
    };
  }

  const borrowAvailable = borrow.fee_rate != null;
  const mode = borrowAvailable ? MARKET_INPUT_MODES.FULL_EXTERNAL_INPUTS : MARKET_INPUT_MODES.PARTIAL_EXTERNAL_INPUTS;
  const effectiveCarryYield = computeEffectiveCarryYield({ dividendYield: dividend.annualized_yield, borrowFeeRate: borrow.fee_rate });

  const confidenceRank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  let overallConfidence = [dividend.confidence, discount.warnings?.length ? 'MEDIUM' : 'HIGH'].reduce((a, b) => confidenceRank[b] < confidenceRank[a] ? b : a);
  if (!borrowAvailable && confidenceRank[overallConfidence] > confidenceRank.MEDIUM) overallConfidence = 'MEDIUM'; // Step 8 cap

  return {
    expiration, days_to_expiry: daysToExpiry,
    discount_rate: discount.discount_rate, discount_rate_source: discount.discount_rate_source, discount_rate_as_of_utc: discount.discount_rate_as_of_utc,
    dividend_input: dividend, borrow_input: borrow,
    effective_carry_yield: effectiveCarryYield,
    mode,
    overall_confidence: overallConfidence,
    warnings: [...new Set(warnings)],
  };
}
