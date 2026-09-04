// Phase 2B — tests for the pure market-input / implied-carry modules.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  treasuryBillCouponEquivalentToContinuous, sofrOvernightToContinuousAnchor,
  selectTreasuryBillForDte, normalizeTreasuryDiscountRate, normalizeSofrDiscountRate,
} from '../src/core/options/marketInputs/rateNormalization.js';
import {
  extractMatchedPairs, calibrationMid, syntheticForwardEstimate,
  effectiveCarryFromForward, robustCrossStrikeCarry,
} from '../src/core/options/marketInputs/impliedForward.js';
import {
  classifyCarryConfidence, fitCrrImpliedCarry, evaluateHoldoutError,
  compareCarryEstimators, flagExtremeCarry,
} from '../src/core/options/marketInputs/impliedCarry.js';
import { priceCrrAmerican } from '../src/core/options/pricing/crrAmerican.js';

describe('rateNormalization', () => {
  it('treasury coupon-equivalent -> continuous rate: near-zero-T sanity (small T behaves like simple rate)', () => {
    const r = treasuryBillCouponEquivalentToContinuous(0.04, 91 / 365);
    // ln(1+0.04*0.2493)/0.2493 should be slightly below 0.04 (continuous < simple for positive rate)
    assert.ok(r < 0.04 && r > 0.039, `expected ~0.0398, got ${r}`);
  });

  it('rejects non-positive gross return / invalid T', () => {
    assert.throws(() => treasuryBillCouponEquivalentToContinuous(-5, 0.25));
    assert.throws(() => treasuryBillCouponEquivalentToContinuous(0.04, 0));
    assert.throws(() => treasuryBillCouponEquivalentToContinuous(0.04, -1));
  });

  it('SOFR overnight -> continuous anchor is close to the raw rate for small values', () => {
    const r = sofrOvernightToContinuousAnchor(0.0364);
    assert.ok(Math.abs(r - 0.0364) < 0.0005, `expected ~0.0364, got ${r}`);
  });

  it('selects the correct treasury bill bucket by DTE', () => {
    const rates = { fourWeek: 0.0375, sixWeek: 0.0377, eightWeek: 0.0379, thirteenWeek: 0.0383, seventeenWeek: 0.039, twentySixWeek: 0.0398, fiftyTwoWeek: 0.0414 };
    assert.equal(selectTreasuryBillForDte(20, rates).maturityLabel, '4_WEEK');
    assert.equal(selectTreasuryBillForDte(41, rates).maturityLabel, '6_WEEK');
    assert.equal(selectTreasuryBillForDte(60, rates).maturityLabel, '8_WEEK');
    assert.equal(selectTreasuryBillForDte(90, rates).maturityLabel, '13_WEEK');
    assert.equal(selectTreasuryBillForDte(130, rates).maturityLabel, '17_WEEK');
    assert.equal(selectTreasuryBillForDte(200, rates).maturityLabel, '26_WEEK');
    assert.equal(selectTreasuryBillForDte(300, rates).maturityLabel, '52_WEEK');
  });

  it('normalizeTreasuryDiscountRate reports provenance', () => {
    const rates = { fourWeek: 0.0375, sixWeek: 0.0377, eightWeek: 0.0379, thirteenWeek: 0.0383, seventeenWeek: 0.039, twentySixWeek: 0.0398, fiftyTwoWeek: 0.0414 };
    const r = normalizeTreasuryDiscountRate({ dte: 41, billRates: rates, asOfDate: '2026-08-28' });
    assert.equal(r.discount_rate_source, 'US_TREASURY_BILL_COUPON_EQUIVALENT');
    assert.equal(r.discount_rate_compounding, 'CONTINUOUS');
    assert.equal(r.diagnostics.maturity_bucket, '6_WEEK');
  });

  it('normalizeSofrDiscountRate labels it as an overnight anchor', () => {
    const r = normalizeSofrDiscountRate({ sofrDecimal: 0.0364, asOfDate: '2026-08-27' });
    assert.equal(r.discount_rate_source, 'SOFR_OVERNIGHT_ANCHOR');
    assert.equal(r.diagnostics.warning, 'SOFR_OVERNIGHT_IS_NOT_A_TERM_CURVE');
  });
});

describe('impliedForward — matched pairs', () => {
  const baseCall = { option_type: 'call', expiration: '2026-10-09', strike: 370, bid: 29, ask: 30, delta: 0.55 };
  const basePut = { option_type: 'put', expiration: '2026-10-09', strike: 370, bid: 27, ask: 28, delta: -0.45 };

  it('matches a valid call/put pair at the same strike+expiration', () => {
    const pairs = extractMatchedPairs([baseCall, basePut]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].strike, 370);
  });

  it('rejects a missing leg', () => {
    const pairs = extractMatchedPairs([baseCall]);
    assert.equal(pairs.length, 0);
  });

  it('rejects a crossed market (ask < bid)', () => {
    const crossed = { ...basePut, bid: 40, ask: 30 };
    const pairs = extractMatchedPairs([baseCall, crossed]);
    assert.equal(pairs.length, 0);
  });

  it('rejects wide spread beyond maxSpreadPct', () => {
    const wide = { ...basePut, bid: 10, ask: 40 }; // ~120% spread
    const pairs = extractMatchedPairs([baseCall, wide], { maxSpreadPct: 5 });
    assert.equal(pairs.length, 0);
  });

  it('rejects legs outside the default delta window', () => {
    const deepItmCall = { ...baseCall, delta: 0.95 };
    const pairs = extractMatchedPairs([deepItmCall, basePut]);
    assert.equal(pairs.length, 0);
  });

  it('rejects zero/missing bid or ask', () => {
    const noBid = { ...basePut, bid: 0 };
    assert.equal(extractMatchedPairs([baseCall, noBid]).length, 0);
    const missingAsk = { ...basePut, ask: null };
    assert.equal(extractMatchedPairs([baseCall, missingAsk]).length, 0);
  });
});

describe('impliedForward — synthetic forward & effective carry', () => {
  it('computes calibration mid', () => {
    assert.equal(calibrationMid({ bid: 10, ask: 12 }), 11);
  });

  it('synthetic forward carries the American-parity-approximation warning', () => {
    const r = syntheticForwardEstimate({ strike: 370, callMid: 29.85, putMid: 28.13, discountRate: 0.0386, timeToExpiryYears: 41 / 365 });
    assert.equal(r.estimate_type, 'AMERICAN_OPTIONS_SYNTHETIC_FORWARD_ESTIMATE');
    assert.ok(r.warnings.includes('AMERICAN_PARITY_APPROXIMATION'));
    assert.ok(r.forward_estimate > 370); // call > put here => forward above strike
  });

  it('q_eff round-trips: given q, build F, then recover q', () => {
    const spot = 371.59, r = 0.0386, T = 41 / 365, q = 0.02;
    const forward = spot * Math.exp((r - q) * T);
    const qBack = effectiveCarryFromForward({ spot, forward, discountRate: r, timeToExpiryYears: T });
    assert.ok(Math.abs(qBack - q) < 1e-9, `expected ${q}, got ${qBack}`);
  });

  it('rejects non-positive forward', () => {
    assert.throws(() => effectiveCarryFromForward({ spot: 100, forward: -1, discountRate: 0.04, timeToExpiryYears: 0.25 }));
    assert.throws(() => effectiveCarryFromForward({ spot: 100, forward: 0, discountRate: 0.04, timeToExpiryYears: 0.25 }));
  });

  it('robustCrossStrikeCarry reports median/weighted-mean/MAD/dispersion', () => {
    const estimates = [{ q_eff: 0.01, weight: 1 }, { q_eff: 0.015, weight: 1 }, { q_eff: 0.012, weight: 2 }, { q_eff: 0.5, weight: 1 }]; // one outlier
    const r = robustCrossStrikeCarry(estimates);
    assert.equal(r.pair_count, 4);
    // median should be robust to the 0.5 outlier
    assert.ok(r.median_q < 0.02, `median should ignore outlier, got ${r.median_q}`);
    assert.ok(r.weighted_mean_q > r.median_q, 'weighted mean should be pulled up by the outlier');
    assert.equal(r.min, 0.01);
    assert.equal(r.max, 0.5);
  });

  it('robustCrossStrikeCarry requires at least one estimate', () => {
    assert.throws(() => robustCrossStrikeCarry([]));
  });
});

describe('impliedCarry — confidence classification', () => {
  it('HIGH requires >=5 pairs, low dispersion, tight spreads', () => {
    assert.equal(classifyCarryConfidence({ pairCount: 5, mad: 0.005, meanSpreadPct: 3 }), 'HIGH');
    assert.equal(classifyCarryConfidence({ pairCount: 4, mad: 0.005, meanSpreadPct: 3 }), 'MEDIUM');
    assert.equal(classifyCarryConfidence({ pairCount: 5, mad: 0.02, meanSpreadPct: 3 }), 'MEDIUM');
    assert.equal(classifyCarryConfidence({ pairCount: 5, mad: 0.005, meanSpreadPct: 8 }), 'MEDIUM');
  });

  it('MEDIUM requires >=3 pairs and acceptable dispersion', () => {
    assert.equal(classifyCarryConfidence({ pairCount: 3, mad: 0.015, meanSpreadPct: 20 }), 'MEDIUM');
    assert.equal(classifyCarryConfidence({ pairCount: 2, mad: 0.005, meanSpreadPct: 3 }), 'LOW');
  });

  it('LOW for insufficient pairs or high dispersion', () => {
    assert.equal(classifyCarryConfidence({ pairCount: 1, mad: 0.001, meanSpreadPct: 1 }), 'LOW');
    assert.equal(classifyCarryConfidence({ pairCount: 10, mad: 0.05, meanSpreadPct: 1 }), 'LOW');
  });
});

describe('impliedCarry — CRR joint carry fit', () => {
  it('recovers a known synthetic carry from CRR-generated mids (calibration self-consistency)', () => {
    const ctx = { spot: 371.59, discountRate: 0.02, timeToExpiryYears: 41 / 365, steps: 200 };
    const trueQ = 0.015;
    const strikes = [350, 360, 370, 380, 390];
    const quotes = [];
    for (const strike of strikes) {
      for (const option_type of ['call', 'put']) {
        const iv = 0.56;
        const { price } = priceCrrAmerican({
          option_type, spot: ctx.spot, strike, time_to_expiry_years: ctx.timeToExpiryYears,
          volatility: iv, risk_free_rate: ctx.discountRate, dividend_yield: trueQ, steps: ctx.steps,
        });
        quotes.push({ option_type, strike, iv, mid: price });
      }
    }
    const fit = fitCrrImpliedCarry(quotes, ctx);
    assert.ok(Math.abs(fit.best_q - trueQ) < 0.001, `expected best_q~${trueQ}, got ${fit.best_q}`);
    assert.ok(fit.objective_value < 1e-6, `expected near-zero SSE for a perfectly-generated sample, got ${fit.objective_value}`);
  });

  it('rejects an empty quote set', () => {
    assert.throws(() => fitCrrImpliedCarry([], { spot: 100, discountRate: 0.02, timeToExpiryYears: 0.25 }));
  });

  it('evaluateHoldoutError separates call/put MAE and reports n', () => {
    const ctx = { spot: 371.59, discountRate: 0.02, timeToExpiryYears: 41 / 365, steps: 200 };
    const holdout = [
      { option_type: 'call', strike: 400, iv: 0.55, mid: 20 },
      { option_type: 'put', strike: 340, iv: 0.57, mid: 15 },
    ];
    const r = evaluateHoldoutError(holdout, 0.015, ctx);
    assert.equal(r.n, 2);
    assert.ok(r.call_mae >= 0 && r.put_mae >= 0 && r.all_mae >= 0);
  });

  it('compareCarryEstimators flags disagreement beyond 100bps', () => {
    const agree = compareCarryEstimators(0.01, 0.011);
    assert.equal(agree.warnings.length, 0);
    const disagree = compareCarryEstimators(0.008, 0.027); // 190bps apart
    assert.ok(disagree.warnings.includes('CARRY_ESTIMATORS_DISAGREE'));
  });

  it('flagExtremeCarry allows negative carry but flags large magnitude', () => {
    assert.deepEqual(flagExtremeCarry(-0.02), []);
    assert.deepEqual(flagExtremeCarry(0.05), []);
    assert.ok(flagExtremeCarry(0.5).includes('EXTREME_EFFECTIVE_CARRY'));
    assert.ok(flagExtremeCarry(-0.3).includes('EXTREME_EFFECTIVE_CARRY'));
  });
});
