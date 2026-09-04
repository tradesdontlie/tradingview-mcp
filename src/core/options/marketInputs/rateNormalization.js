// Phase 2B, Step 3/4 — pure rate normalization. Converts published rate
// conventions (Treasury bill coupon-equivalent, SOFR overnight) into the
// continuously compounded decimal rate CRR_AMERICAN_V1 / BLACK_SCHOLES_
// REFERENCE expect. No network I/O here — callers fetch the raw published
// figures (e.g. via WebFetch/curl against home.treasury.gov and the NY Fed
// markets API) and pass them in as plain numbers.

import { DISCOUNT_RATE_SOURCES, assertPositiveFinite, assertFinite } from './marketInputTypes.js';

/**
 * Converts a U.S. Treasury bill "coupon equivalent" (investment) yield —
 * an annualized simple-interest yield on an actual/365 basis for
 * maturities <=182 days, as published in the Treasury's
 * daily_treasury_bill_rates series — into a continuously compounded
 * annual rate for a given time to maturity.
 *
 * Relationship: (1 + couponEquivalent * T) = e^(r_cc * T)
 *   => r_cc = ln(1 + couponEquivalent * T) / T
 *
 * Deliberately does NOT use the "bank discount" column, which is a
 * different (discount-on-face, actual/360) convention not directly
 * comparable to a continuously compounded zero rate without a separate
 * conversion step.
 *
 * @param {number} couponEquivalentDecimal - e.g. 0.0386 for 3.86%
 * @param {number} timeToMaturityYears
 * @returns {number} continuously compounded decimal rate
 */
export function treasuryBillCouponEquivalentToContinuous(couponEquivalentDecimal, timeToMaturityYears) {
  assertFinite('couponEquivalentDecimal', couponEquivalentDecimal);
  assertPositiveFinite('timeToMaturityYears', timeToMaturityYears);
  const grossReturn = 1 + couponEquivalentDecimal * timeToMaturityYears;
  if (grossReturn <= 0) {
    throw new Error(`couponEquivalentDecimal=${couponEquivalentDecimal} implies non-positive gross return over T=${timeToMaturityYears}`);
  }
  return Math.log(grossReturn) / timeToMaturityYears;
}

/**
 * SOFR is an overnight secured funding rate, NOT a forward-looking term
 * curve (Step 4). This converts the daily SOFR fixing (a simple-interest,
 * actual/360 overnight rate per market convention) into a continuously
 * compounded annual rate, valid only as an "overnight anchor" — it is NOT
 * appropriate to treat this as if it were a genuine 30/60/90-day term rate.
 * Compounding over T beyond a few days is a modeling simplification the
 * caller must own; this function does not claim term-rate accuracy.
 */
export function sofrOvernightToContinuousAnchor(sofrDecimal) {
  assertFinite('sofrDecimal', sofrDecimal);
  // actual/360 simple-interest overnight rate -> continuously compounded
  // annualized rate, treating 1 day as the compounding period base.
  // r_cc = 360 * ln(1 + sofr/360)
  return 360 * Math.log(1 + sofrDecimal / 360);
}

/**
 * Selects the Treasury bill maturity bucket per Phase 2A's Step 13
 * DTE-mapping heuristic, now generalized to the fuller bill ladder
 * (Step 3): 4/6/8/13/17/26/52 week bills.
 *
 * @param {number} dte - days to expiry
 * @param {object} billRates - { fourWeek, sixWeek, eightWeek, thirteenWeek, seventeenWeek, twentySixWeek, fiftyTwoWeek } coupon-equivalent decimals
 */
export function selectTreasuryBillForDte(dte, billRates) {
  assertPositiveFinite('dte', dte);
  // maxDte boundaries are the midpoints between consecutive bill
  // maturities (e.g. (28+42)/2=35 between 4wk and 6wk), so each DTE maps
  // to its nearest published maturity.
  const buckets = [
    { maxDte: 35, days: 28, rate: billRates.fourWeek, label: '4_WEEK' },
    { maxDte: 49, days: 42, rate: billRates.sixWeek, label: '6_WEEK' },
    { maxDte: 73.5, days: 56, rate: billRates.eightWeek, label: '8_WEEK' },
    { maxDte: 105, days: 91, rate: billRates.thirteenWeek, label: '13_WEEK' },
    { maxDte: 150.5, days: 119, rate: billRates.seventeenWeek, label: '17_WEEK' },
    { maxDte: 273, days: 182, rate: billRates.twentySixWeek, label: '26_WEEK' },
    { maxDte: Infinity, days: 364, rate: billRates.fiftyTwoWeek, label: '52_WEEK' },
  ];
  const bucket = buckets.find(b => dte <= b.maxDte);
  return { maturityLabel: bucket.label, maturityDays: bucket.days, couponEquivalent: bucket.rate };
}

/**
 * Full normalization pipeline (Step 2/3): given raw Treasury bill rates
 * and a target DTE, returns a continuously compounded discount rate with
 * provenance.
 */
export function normalizeTreasuryDiscountRate({ dte, billRates, asOfDate }) {
  const { maturityLabel, maturityDays, couponEquivalent } = selectTreasuryBillForDte(dte, billRates);
  const T = maturityDays / 365;
  const continuousRate = treasuryBillCouponEquivalentToContinuous(couponEquivalent, T);
  return {
    discount_rate: continuousRate,
    discount_rate_compounding: 'CONTINUOUS',
    discount_rate_source: DISCOUNT_RATE_SOURCES.US_TREASURY_BILL_COUPON_EQUIVALENT,
    discount_rate_as_of: asOfDate,
    diagnostics: {
      maturity_bucket: maturityLabel,
      maturity_days: maturityDays,
      raw_coupon_equivalent: couponEquivalent,
    },
  };
}

/**
 * SOFR-anchor normalization (Step 4): returns the same shape as
 * normalizeTreasuryDiscountRate but sourced from the overnight SOFR
 * fixing, explicitly labeled as an anchor rather than a term curve.
 */
export function normalizeSofrDiscountRate({ sofrDecimal, asOfDate }) {
  const continuousRate = sofrOvernightToContinuousAnchor(sofrDecimal);
  return {
    discount_rate: continuousRate,
    discount_rate_compounding: 'CONTINUOUS',
    discount_rate_source: DISCOUNT_RATE_SOURCES.SOFR_OVERNIGHT_ANCHOR,
    discount_rate_as_of: asOfDate,
    diagnostics: {
      raw_sofr_overnight: sofrDecimal,
      warning: 'SOFR_OVERNIGHT_IS_NOT_A_TERM_CURVE',
    },
  };
}
