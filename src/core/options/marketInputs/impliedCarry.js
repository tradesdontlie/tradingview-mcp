// Phase 2B, Steps 11-13 — carry confidence classification and the
// CRR_IMPLIED_CARRY_FIT joint optimizer. Pure, no TradingView/CDP imports.
// Diagnostic/calibration only.

import { priceCrrAmerican } from '../pricing/crrAmerican.js';
import { CARRY_CONFIDENCE, CALIBRATION_WARNINGS } from './marketInputTypes.js';

/**
 * Step 11 — deterministic carry confidence classification.
 *   HIGH:   >=5 valid matched pairs AND MAD <= 0.01 (1 vol-pt-equivalent
 *           dispersion in carry terms) AND mean spread_pct <= 5
 *   MEDIUM: >=3 valid matched pairs AND MAD <= 0.02
 *   LOW:    everything else
 * Thresholds are deliberately simple and documented here (not "subjective")
 * so they can be unit-tested exactly.
 */
export function classifyCarryConfidence({ pairCount, mad, meanSpreadPct }) {
  if (pairCount >= 5 && mad <= 0.01 && meanSpreadPct <= 5) return CARRY_CONFIDENCE.HIGH;
  if (pairCount >= 3 && mad <= 0.02) return CARRY_CONFIDENCE.MEDIUM;
  return CARRY_CONFIDENCE.LOW;
}

/**
 * Step 12 — CRR_IMPLIED_CARRY_FIT. Fits ONE common effective_carry_yield
 * for one expiration to minimize CRR_AMERICAN_V1 pricing error (vs mid)
 * across a set of call+put quotes, holding spot/discount rate/each
 * contract's native IV/strike/DTE fixed. Does not fit a separate carry per
 * contract, and does not touch IV or the discount rate.
 *
 * Uses a bounded 1D golden-section search (deterministic, no external
 * optimization library) over [minCarry, maxCarry].
 *
 * @param {Array<{option_type, strike, iv, mid}>} quotes - iv as decimal
 * @param {object} ctx - { spot, discountRate, timeToExpiryYears, steps }
 */
export function fitCrrImpliedCarry(quotes, ctx, { minCarry = -0.30, maxCarry = 0.30, tol = 1e-5, maxIter = 100 } = {}) {
  if (quotes.length === 0) throw new Error('fitCrrImpliedCarry requires at least one quote');
  const { spot, discountRate, timeToExpiryYears, steps = 200 } = ctx;

  function objective(q) {
    let sse = 0;
    for (const quote of quotes) {
      const { price } = priceCrrAmerican({
        option_type: quote.option_type, spot, strike: quote.strike,
        time_to_expiry_years: timeToExpiryYears, volatility: quote.iv,
        risk_free_rate: discountRate, dividend_yield: q, steps,
      });
      const err = price - quote.mid;
      sse += err * err;
    }
    return sse;
  }

  // Golden-section search for the minimum of a (assumed roughly unimodal)
  // SSE objective over [minCarry, maxCarry].
  const gr = (Math.sqrt(5) - 1) / 2;
  let a = minCarry, b = maxCarry;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = objective(c), fd = objective(d);
  let iter = 0;
  while (Math.abs(b - a) > tol && iter < maxIter) {
    if (fc < fd) {
      b = d; d = c; fd = fc;
      c = b - gr * (b - a);
      fc = objective(c);
    } else {
      a = c; c = d; fc = fd;
      d = a + gr * (b - a);
      fd = objective(d);
    }
    iter++;
  }
  const bestQ = (a + b) / 2;
  const objectiveValue = objective(bestQ);

  return { best_q: bestQ, objective_value: objectiveValue, pair_count: quotes.length, iterations: iter };
}

/**
 * Step 13 — calibration/holdout evaluation. Given a fitted (or parity-
 * derived) carry, prices a set of holdout quotes with CRR_AMERICAN_V1 and
 * reports MAE — the fit-quality number that actually matters (Step 13:
 * "do not report fit improvement only on the contracts used for
 * calibration").
 */
export function evaluateHoldoutError(holdoutQuotes, carryYield, ctx) {
  const { spot, discountRate, timeToExpiryYears, steps = 200 } = ctx;
  const errors = holdoutQuotes.map(quote => {
    const { price } = priceCrrAmerican({
      option_type: quote.option_type, spot, strike: quote.strike,
      time_to_expiry_years: timeToExpiryYears, volatility: quote.iv,
      risk_free_rate: discountRate, dividend_yield: carryYield, steps,
    });
    return { ...quote, price, abs_error: Math.abs(price - quote.mid) };
  });
  const calls = errors.filter(e => e.option_type === 'call');
  const puts = errors.filter(e => e.option_type === 'put');
  const mean = arr => arr.length ? arr.reduce((s, e) => s + e.abs_error, 0) / arr.length : null;
  return {
    call_mae: mean(calls),
    put_mae: mean(puts),
    all_mae: mean(errors),
    n: errors.length,
    details: errors,
  };
}

/**
 * Step 14 — compares two carry estimates and flags material disagreement.
 * Threshold: 100 bps (0.01 decimal) of carry difference. Documented,
 * testable constant rather than a vague "materially disagree" judgment.
 */
export function compareCarryEstimators(parityQ, crrFitQ, { disagreementThresholdBps = 100 } = {}) {
  const diffBps = (crrFitQ - parityQ) * 10000;
  const warnings = [];
  if (Math.abs(diffBps) > disagreementThresholdBps) warnings.push(CALIBRATION_WARNINGS.CARRY_ESTIMATORS_DISAGREE);
  return { parity_q: parityQ, crr_fit_q: crrFitQ, diff_bps: diffBps, warnings };
}

/**
 * Step 20 — flags extreme effective carry without hard-coding an economic
 * interpretation. Negative carry is allowed and not itself flagged; only
 * magnitude beyond a documented threshold is flagged.
 */
export function flagExtremeCarry(qEff, { extremeThreshold = 0.15 } = {}) {
  return Math.abs(qEff) > extremeThreshold ? [CALIBRATION_WARNINGS.EXTREME_EFFECTIVE_CARRY] : [];
}
