// Phase 2B.1 — tests for the joint discount-rate + effective-carry
// regression estimator. Pure, deterministic (no live network calls).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { priceBlackScholes } from '../src/core/options/pricing/blackScholes.js';
import { priceCrrAmerican } from '../src/core/options/pricing/crrAmerican.js';
import {
  selectCalibrationTier, pairCalibrationWeight, fitRawParityJoint,
  europeanizePairs, fitAmericanCorrectedJointCarry, checkTermStructureStability,
  classifyJointConfidence, splitCalibrationHoldout, evaluateJointHoldout,
} from '../src/core/options/marketInputs/jointCarryRegression.js';

const SPOT = 371.59, TRUE_R = 0.04, TRUE_Q = 0.015, T = 41 / 365;
const STRIKES = [330, 345, 355, 360, 365, 370, 375, 380, 390, 400];

function buildEuropeanPairs(strikes, ivFn = () => 0.30) {
  return strikes.map(strike => {
    const iv = ivFn(strike);
    const call = priceBlackScholes({ option_type: 'call', spot: SPOT, strike, time_to_expiry_years: T, volatility: iv, risk_free_rate: TRUE_R, dividend_yield: TRUE_Q }).price;
    const put = priceBlackScholes({ option_type: 'put', spot: SPOT, strike, time_to_expiry_years: T, volatility: iv, risk_free_rate: TRUE_R, dividend_yield: TRUE_Q }).price;
    const spread = 0.02; // tight synthetic spread
    return {
      strike,
      call: { bid: call - spread / 2, ask: call + spread / 2, delta: 0.5, iv },
      put: { bid: put - spread / 2, ask: put + spread / 2, delta: -0.5, iv },
    };
  });
}

describe('selectCalibrationTier', () => {
  const tight = { call: { bid: 10, ask: 10.2 }, put: { bid: 9, ask: 9.2 } }; // ~2%
  const medium = { call: { bid: 10, ask: 10.8 }, put: { bid: 9, ask: 9.7 } }; // ~7-8%
  const wide = { call: { bid: 10, ask: 12 }, put: { bid: 9, ask: 11 } }; // ~18-20%

  it('prefers STRICT when enough pairs qualify', () => {
    const pairs = Array(5).fill(tight);
    const r = selectCalibrationTier(pairs, { minPairs: 5 });
    assert.equal(r.tier, 'STRICT');
    assert.equal(r.pairs.length, 5);
  });

  it('falls back to STANDARD when STRICT is insufficient', () => {
    const pairs = [tight, tight, medium, medium, medium];
    const r = selectCalibrationTier(pairs, { minPairs: 5 });
    assert.equal(r.tier, 'STANDARD');
  });

  it('falls back to DIAGNOSTIC and never silently claims a tighter tier', () => {
    const pairs = [wide, wide, wide];
    const r = selectCalibrationTier(pairs, { minPairs: 5 });
    assert.equal(r.tier, 'DIAGNOSTIC');
  });
});

describe('pairCalibrationWeight', () => {
  it('gives higher weight to tighter, more-ATM pairs', () => {
    const atmTight = { call: { bid: 10, ask: 10.1, delta: 0.5 }, put: { bid: 9, ask: 9.1, delta: -0.5 } };
    const otmWide = { call: { bid: 1, ask: 1.5, delta: 0.15 }, put: { bid: 1, ask: 1.5, delta: -0.15 } };
    const w1 = pairCalibrationWeight(atmTight).raw_weight;
    const w2 = pairCalibrationWeight(otmWide).raw_weight;
    assert.ok(w1 > w2, `expected ATM-tight weight (${w1}) > OTM-wide weight (${w2})`);
  });
});

describe('fitRawParityJoint — synthetic recovery (Step 25 required fixture)', () => {
  it('recovers true r=4% and q=1.5% from noiseless European-priced synthetic pairs', () => {
    const pairs = buildEuropeanPairs(STRIKES);
    const fit = fitRawParityJoint(pairs, { spot: SPOT, timeToExpiryYears: T });
    assert.ok(Math.abs(fit.discount_rate - TRUE_R) < 0.001, `expected r~${TRUE_R}, got ${fit.discount_rate}`);
    assert.ok(Math.abs(fit.effective_carry_yield - TRUE_Q) < 0.001, `expected q~${TRUE_Q}, got ${fit.effective_carry_yield}`);
    assert.ok(fit.r2 > 0.999, `expected near-perfect R^2, got ${fit.r2}`);
    assert.equal(fit.removed_outlier_count, 0);
    assert.equal(fit.bound_hit, false);
  });

  it('rejects fewer than 2 pairs', () => {
    assert.throws(() => fitRawParityJoint([buildEuropeanPairs(STRIKES)[0]], { spot: SPOT, timeToExpiryYears: T }));
  });

  it('MAD-based outlier rejection removes one badly mispriced pair and improves recovery', () => {
    const pairs = buildEuropeanPairs(STRIKES);
    // Corrupt one pair's put mid badly.
    pairs[3] = { ...pairs[3], put: { ...pairs[3].put, bid: pairs[3].put.bid + 50, ask: pairs[3].put.ask + 50 } };
    const fit = fitRawParityJoint(pairs, { spot: SPOT, timeToExpiryYears: T });
    assert.ok(fit.removed_outlier_count >= 1, 'expected the corrupted pair to be rejected as an outlier');
    assert.ok(Math.abs(fit.discount_rate - TRUE_R) < 0.01, `expected recovered r close to true r despite outlier, got ${fit.discount_rate}`);
  });

  it('flags ESTIMATOR_BOUND_HIT on a degenerate near-flat Y-vs-K fit', () => {
    // Nearly identical Y across strikes => slope near 0 => DF near 0 => invalid rate.
    const pairs = STRIKES.map(strike => ({
      strike,
      call: { bid: 5, ask: 5.02, delta: 0.5, iv: 0.3 },
      put: { bid: 5, ask: 5.02, delta: -0.5, iv: 0.3 },
    }));
    const fit = fitRawParityJoint(pairs, { spot: SPOT, timeToExpiryYears: T });
    assert.ok(fit.warnings.includes('ESTIMATOR_BOUND_HIT'));
  });
});

describe('europeanizePairs + American-corrected iterative fit', () => {
  it('deep ITM American puts: raw parity is biased but American correction recovers r,q better', () => {
    // Build AMERICAN-priced pairs (not European) with a deep-ITM put present,
    // where raw European parity is known to be biased.
    const strikes = [330, 345, 355, 360, 365, 370, 375, 380, 390, 420]; // 420 put is deep ITM
    const pairs = strikes.map(strike => {
      const iv = 0.30;
      const call = priceCrrAmerican({ option_type: 'call', spot: SPOT, strike, time_to_expiry_years: T, volatility: iv, risk_free_rate: TRUE_R, dividend_yield: TRUE_Q, steps: 200 }).price;
      const put = priceCrrAmerican({ option_type: 'put', spot: SPOT, strike, time_to_expiry_years: T, volatility: iv, risk_free_rate: TRUE_R, dividend_yield: TRUE_Q, steps: 200 }).price;
      const spread = 0.02;
      return { strike, call: { bid: call - spread / 2, ask: call + spread / 2, delta: 0.5, iv }, put: { bid: put - spread / 2, ask: put + spread / 2, delta: -0.5, iv } };
    });

    const rawFit = fitRawParityJoint(pairs, { spot: SPOT, timeToExpiryYears: T });
    const correctedFit = fitAmericanCorrectedJointCarry(pairs, { spot: SPOT, timeToExpiryYears: T, initialDiscountRate: 0.04, initialCarryYield: 0 });

    const rawErr = Math.abs(rawFit.discount_rate - TRUE_R) + Math.abs(rawFit.effective_carry_yield - TRUE_Q);
    const correctedErr = Math.abs(correctedFit.discount_rate - TRUE_R) + Math.abs(correctedFit.effective_carry_yield - TRUE_Q);
    assert.ok(correctedErr < rawErr, `expected American correction to reduce recovery error: raw=${rawErr} corrected=${correctedErr}`);
    assert.ok(correctedFit.converged, 'expected the fixed-point iteration to converge on a clean synthetic American sample');
  });

  it('europeanizePairs never mutates the input market mids', () => {
    const pairs = buildEuropeanPairs(STRIKES.slice(0, 3));
    const before = JSON.parse(JSON.stringify(pairs));
    europeanizePairs(pairs, { spot: SPOT, timeToExpiryYears: T, discountRate: 0.04, carryYield: 0.01 });
    assert.deepEqual(pairs, before);
  });

  it('reports JOINT_ESTIMATOR_NOT_CONVERGED rather than fabricating a converged result when maxIterations is too low', () => {
    const pairs = buildEuropeanPairs(STRIKES);
    const fit = fitAmericanCorrectedJointCarry(pairs, { spot: SPOT, timeToExpiryYears: T, initialDiscountRate: -0.3, initialCarryYield: 0.3 }, { maxIterations: 1, tolBp: 0.0001 });
    // With maxIterations=1 and an absurd starting point + microscopic tolerance, convergence should not be claimed.
    assert.equal(fit.converged, false);
    assert.ok(fit.warnings.includes('JOINT_ESTIMATOR_NOT_CONVERGED'));
  });
});

describe('checkTermStructureStability', () => {
  it('flags a large jump between adjacent expiries', () => {
    const points = [
      { expiration: '2026-09-25', dte: 27, option_implied_discount_rate: 0.04, effective_carry_yield: 0.01 },
      { expiration: '2026-10-09', dte: 41, option_implied_discount_rate: 0.041, effective_carry_yield: 0.012 },
      { expiration: '2026-10-16', dte: 48, option_implied_discount_rate: 0.08, effective_carry_yield: 0.05 }, // big jump
    ];
    const flags = checkTermStructureStability(points);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].to, '2026-10-16');
  });

  it('does not flag small, stable moves', () => {
    const points = [
      { expiration: 'A', dte: 27, option_implied_discount_rate: 0.04, effective_carry_yield: 0.01 },
      { expiration: 'B', dte: 41, option_implied_discount_rate: 0.0405, effective_carry_yield: 0.0105 },
    ];
    assert.deepEqual(checkTermStructureStability(points), []);
  });
});

describe('classifyJointConfidence (V2)', () => {
  it('HIGH requires >=8 pairs, STRICT/STANDARD tier, high R2, low dispersion, converged, no bound hit', () => {
    assert.equal(classifyJointConfidence({ retainedPairs: 8, tier: 'STRICT', r2: 0.97, residualMad: 0.02, converged: true, boundHit: false }), 'HIGH');
    assert.equal(classifyJointConfidence({ retainedPairs: 8, tier: 'DIAGNOSTIC', r2: 0.97, residualMad: 0.02, converged: true, boundHit: false }), 'MEDIUM');
    assert.equal(classifyJointConfidence({ retainedPairs: 7, tier: 'STRICT', r2: 0.97, residualMad: 0.02, converged: true, boundHit: false }), 'MEDIUM');
  });

  it('MEDIUM requires >=5 pairs, converged, acceptable dispersion', () => {
    assert.equal(classifyJointConfidence({ retainedPairs: 5, tier: 'DIAGNOSTIC', r2: 0.5, residualMad: 0.1, converged: true, boundHit: false }), 'MEDIUM');
    assert.equal(classifyJointConfidence({ retainedPairs: 4, tier: 'STRICT', r2: 0.99, residualMad: 0.01, converged: true, boundHit: false }), 'LOW');
  });

  it('LOW for not converged or high dispersion', () => {
    assert.equal(classifyJointConfidence({ retainedPairs: 10, tier: 'STRICT', r2: 0.99, residualMad: 0.01, converged: false, boundHit: false }), 'LOW');
    assert.equal(classifyJointConfidence({ retainedPairs: 10, tier: 'STRICT', r2: 0.99, residualMad: 0.5, converged: true, boundHit: false }), 'LOW');
  });
});

describe('splitCalibrationHoldout + evaluateJointHoldout', () => {
  it('splits deterministically ~2:1 by alternating sorted strikes', () => {
    const pairs = buildEuropeanPairs(STRIKES);
    const { calibration, holdout } = splitCalibrationHoldout(pairs);
    assert.equal(calibration.length + holdout.length, pairs.length);
    assert.ok(holdout.length < calibration.length);
    // Deterministic: running twice gives identical split.
    const again = splitCalibrationHoldout(pairs);
    assert.deepEqual(again.holdout.map(p => p.strike), holdout.map(p => p.strike));
  });

  it('evaluateJointHoldout reports near-zero error when (r,q) match the true generating values', () => {
    const pairs = buildEuropeanPairs(STRIKES);
    const { holdout } = splitCalibrationHoldout(pairs);
    const result = evaluateJointHoldout(holdout, { spot: SPOT, timeToExpiryYears: T, discountRate: TRUE_R, carryYield: TRUE_Q });
    // CRR (200 steps) vs the BS-generated synthetic mids carries its own small
    // discretization error (Phase 2A: ~$0.02-0.05 typical at 200 steps) on top
    // of a perfect (r,q) match, so the bound here is CRR convergence noise, not
    // carry-recovery error.
    assert.ok(result.all_mae < 0.1, `expected near-zero MAE at true r,q; got ${result.all_mae}`);
    assert.equal(result.n, holdout.length * 2);
  });
});
