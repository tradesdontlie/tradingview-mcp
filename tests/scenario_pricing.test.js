/**
 * Phase 0B — deterministic, network-free tests for the LOCAL_GREEK_APPROXIMATION
 * repricer (src/core/options/optionRepricer.js). Textbook fixture with
 * hand-calculated contributions, expiry-fallback reconciliation, invariants,
 * and an approximation stress test for warning behavior.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { repriceOptionLocalGreeks, intrinsicValue } from '../src/core/options/optionRepricer.js';

// Textbook fixture (Step 14): theoretical=5.00, delta=0.50, gamma=0.02,
// theta=-0.10/day, vega=0.20/point, spot=100, strike=100, 30 DTE.
const FIXTURE = {
  optionType: 'call',
  strike: 100,
  currentTheoreticalPrice: 5.00,
  delta: 0.50,
  gamma: 0.02,
  theta: -0.10,
  vega: 0.20,
  currentUnderlyingPrice: 100,
  daysToExpiry: 30,
  currentIv: 0.30,
};

describe('repriceOptionLocalGreeks() — textbook fixture, isolated contributions', () => {
  it('spot-only: spot 100->105, no time, no IV change', () => {
    const r = repriceOptionLocalGreeks({
      ...FIXTURE, scenarioUnderlyingPrice: 105, daysForward: 0, scenarioIv: 0.30,
    });
    // delta effect: 0.50 * 5 = 2.50; gamma effect: 0.5*0.02*25 = 0.25
    assert.equal(r.spot_effect, 2.50);
    assert.equal(r.gamma_effect, 0.25);
    assert.equal(r.theta_effect, 0); // days_forward=0
    assert.equal(r.vega_effect, 0); // no IV change
    assert.equal(r.raw_estimated_value, 5.00 + 2.50 + 0.25);
    assert.equal(r.final_estimated_value, 7.75);
  });

  it('gamma-only (isolated by using a delta=0 fixture)', () => {
    const r = repriceOptionLocalGreeks({
      ...FIXTURE, delta: 0, scenarioUnderlyingPrice: 105, daysForward: 0, scenarioIv: 0.30,
    });
    assert.equal(r.spot_effect, 0);
    assert.equal(r.gamma_effect, 0.25); // 0.5*0.02*5^2
    assert.equal(r.final_estimated_value, 5.25);
  });

  it('theta-only: 5 days forward, no spot/IV change', () => {
    const r = repriceOptionLocalGreeks({
      ...FIXTURE, scenarioUnderlyingPrice: 100, daysForward: 5, scenarioIv: 0.30,
    });
    assert.equal(r.spot_effect, 0);
    assert.equal(r.gamma_effect, 0);
    assert.equal(r.theta_effect, -0.50); // -0.10 * 5
    assert.equal(r.vega_effect, 0);
    assert.equal(r.final_estimated_value, 4.50);
  });

  it('vega-only: IV +10 points (0.30 -> 0.40), no spot/time change', () => {
    const r = repriceOptionLocalGreeks({
      ...FIXTURE, scenarioUnderlyingPrice: 100, daysForward: 0, scenarioIv: 0.40,
    });
    assert.equal(r.vega_effect, 2.00); // 0.20 * 10 points
    assert.equal(r.final_estimated_value, 7.00);
  });

  it('vega-only: IV -10 points (0.30 -> 0.20)', () => {
    const r = repriceOptionLocalGreeks({
      ...FIXTURE, scenarioUnderlyingPrice: 100, daysForward: 0, scenarioIv: 0.20,
    });
    assert.equal(r.vega_effect, -2.00);
    assert.equal(r.final_estimated_value, 3.00);
  });

  it('combined: spot 105, 5 days forward, IV +10 points', () => {
    const r = repriceOptionLocalGreeks({
      ...FIXTURE, scenarioUnderlyingPrice: 105, daysForward: 5, scenarioIv: 0.40,
    });
    assert.equal(r.spot_effect, 2.50);
    assert.equal(r.gamma_effect, 0.25);
    assert.equal(r.theta_effect, -0.50);
    assert.equal(r.vega_effect, 2.00);
    const expectedRaw = 5.00 + 2.50 + 0.25 - 0.50 + 2.00; // 9.25
    assert.equal(r.raw_estimated_value, 9.25);
    assert.equal(r.final_estimated_value, 9.25);
    assert.equal(r.pricing_model, 'LOCAL_GREEK_APPROXIMATION');
    assert.equal(r.anchor_price_source, 'TRADINGVIEW_THEORETICAL_PRICE');
  });
});

describe('repriceOptionLocalGreeks() — expiry fallback (Step 5/15)', () => {
  it('uses EXPIRATION_INTRINSIC, not the Greek approximation, when days_forward == days_to_expiry', () => {
    const r = repriceOptionLocalGreeks({
      ...FIXTURE, scenarioUnderlyingPrice: 110, daysForward: 30, scenarioIv: 0.30,
    });
    assert.equal(r.pricing_model, 'EXPIRATION_INTRINSIC');
    assert.equal(r.final_estimated_value, 10); // max(110-100,0)
    assert.equal(r.spot_effect, null); // no Greek decomposition at expiry
  });

  it('long call expiry fallback reconciles exactly with Phase 0A computeLongCallEconomics', async () => {
    const { computeLongCallEconomics } = await import('../src/core/options/strategyEconomics.js');
    const fillPrice = 5.00, multiplier = 100, commission = 0, strike = 100;
    const econ = computeLongCallEconomics({ strike, fillPrice, multiplier, commissionPerContract: commission });

    const scenarioSpot = 110;
    const priced = repriceOptionLocalGreeks({
      optionType: 'call', strike, currentTheoreticalPrice: 5.5, delta: 0.5, gamma: 0.02, theta: -0.1, vega: 0.2,
      currentUnderlyingPrice: 100, scenarioUnderlyingPrice: scenarioSpot, daysForward: 30, daysToExpiry: 30,
      currentIv: 0.3, scenarioIv: 0.3,
    });
    const legPnl = (priced.final_estimated_value - fillPrice) * multiplier;
    assert.equal(legPnl, econ.expirationPnl(scenarioSpot));
  });

  it('long put expiry fallback reconciles exactly with Phase 0A computeLongPutEconomics', async () => {
    const { computeLongPutEconomics } = await import('../src/core/options/strategyEconomics.js');
    const fillPrice = 4.00, multiplier = 100, commission = 0, strike = 100;
    const econ = computeLongPutEconomics({ strike, fillPrice, multiplier, commissionPerContract: commission });

    const scenarioSpot = 85;
    const priced = repriceOptionLocalGreeks({
      optionType: 'put', strike, currentTheoreticalPrice: 4.2, delta: -0.4, gamma: 0.02, theta: -0.1, vega: 0.2,
      currentUnderlyingPrice: 100, scenarioUnderlyingPrice: scenarioSpot, daysForward: 22, daysToExpiry: 22,
      currentIv: 0.3, scenarioIv: 0.3,
    });
    const legPnl = (priced.final_estimated_value - fillPrice) * multiplier;
    assert.equal(legPnl, econ.expirationPnl(scenarioSpot));
  });

  it('bull call spread expiry fallback reconciles exactly with Phase 0A (both legs)', async () => {
    const { computeBullCallSpreadEconomics } = await import('../src/core/options/strategyEconomics.js');
    const longFill = 5.00, shortFill = 2.00, multiplier = 100, commission = 0;
    const econ = computeBullCallSpreadEconomics({ longStrike: 100, shortStrike: 110, longFill, shortFill, multiplier, commissionPerContract: commission });

    const scenarioSpot = 115;
    const longPriced = repriceOptionLocalGreeks({
      optionType: 'call', strike: 100, currentTheoreticalPrice: 5.2, delta: 0.5, gamma: 0.02, theta: -0.1, vega: 0.2,
      currentUnderlyingPrice: 100, scenarioUnderlyingPrice: scenarioSpot, daysForward: 30, daysToExpiry: 30, currentIv: 0.3, scenarioIv: 0.3,
    });
    const shortPriced = repriceOptionLocalGreeks({
      optionType: 'call', strike: 110, currentTheoreticalPrice: 2.1, delta: 0.3, gamma: 0.015, theta: -0.08, vega: 0.18,
      currentUnderlyingPrice: 100, scenarioUnderlyingPrice: scenarioSpot, daysForward: 30, daysToExpiry: 30, currentIv: 0.3, scenarioIv: 0.3,
    });

    const longLegPnl = (longPriced.final_estimated_value - longFill) * multiplier;
    const shortLegPnl = (shortFill - shortPriced.final_estimated_value) * multiplier;
    const scenarioPnl = longLegPnl + shortLegPnl - econ.fees;
    assert.equal(scenarioPnl, econ.expirationPnl(scenarioSpot));
  });

  it('bear put spread expiry fallback reconciles exactly with Phase 0A (both legs)', async () => {
    const { computeBearPutSpreadEconomics } = await import('../src/core/options/strategyEconomics.js');
    const longFill = 5.00, shortFill = 2.00, multiplier = 100, commission = 0;
    const econ = computeBearPutSpreadEconomics({ longStrike: 100, shortStrike: 90, longFill, shortFill, multiplier, commissionPerContract: commission });

    const scenarioSpot = 80;
    const longPriced = repriceOptionLocalGreeks({
      optionType: 'put', strike: 100, currentTheoreticalPrice: 5.2, delta: -0.5, gamma: 0.02, theta: -0.1, vega: 0.2,
      currentUnderlyingPrice: 100, scenarioUnderlyingPrice: scenarioSpot, daysForward: 25, daysToExpiry: 25, currentIv: 0.3, scenarioIv: 0.3,
    });
    const shortPriced = repriceOptionLocalGreeks({
      optionType: 'put', strike: 90, currentTheoreticalPrice: 2.1, delta: -0.3, gamma: 0.015, theta: -0.08, vega: 0.18,
      currentUnderlyingPrice: 100, scenarioUnderlyingPrice: scenarioSpot, daysForward: 25, daysToExpiry: 25, currentIv: 0.3, scenarioIv: 0.3,
    });

    const longLegPnl = (longPriced.final_estimated_value - longFill) * multiplier;
    const shortLegPnl = (shortFill - shortPriced.final_estimated_value) * multiplier;
    const scenarioPnl = longLegPnl + shortLegPnl - econ.fees;
    assert.equal(scenarioPnl, econ.expirationPnl(scenarioSpot));
  });
});

describe('repriceOptionLocalGreeks() — missing-data handling', () => {
  it('reports unavailable, never fabricated, when theoretical_price is missing', () => {
    const r = repriceOptionLocalGreeks({ ...FIXTURE, currentTheoreticalPrice: null, scenarioUnderlyingPrice: 105, daysForward: 5, scenarioIv: 0.3 });
    assert.equal(r.available, false);
    assert.ok(r.warnings.includes('MISSING_THEORETICAL_PRICE'));
  });

  it('reports unavailable when any greek is missing', () => {
    for (const key of ['delta', 'gamma', 'theta', 'vega']) {
      const r = repriceOptionLocalGreeks({ ...FIXTURE, [key]: null, scenarioUnderlyingPrice: 105, daysForward: 5, scenarioIv: 0.3 });
      assert.equal(r.available, false);
      assert.ok(r.warnings.includes('MISSING_GREEKS'));
    }
  });

  it('rejects a non-positive scenario_iv', () => {
    assert.throws(() => repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: 100, daysForward: 0, scenarioIv: 0 }), /Invalid scenario_iv/);
    assert.throws(() => repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: 100, daysForward: 0, scenarioIv: -0.1 }), /Invalid scenario_iv/);
  });

  it('rejects a negative days_forward', () => {
    assert.throws(() => repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: 100, daysForward: -1, scenarioIv: 0.3 }), /Invalid days_forward/);
  });
});

describe('repriceOptionLocalGreeks() — invariants (Step 16)', () => {
  it('estimated option value is always >= intrinsic value and >= 0', () => {
    const cases = [
      { spot: 40, iv: 0.9 }, { spot: 100, iv: 0.3 }, { spot: 300, iv: 0.1 },
    ];
    for (const { spot, iv } of cases) {
      const r = repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: spot, daysForward: 5, scenarioIv: iv });
      const intrinsic = intrinsicValue('call', spot, 100);
      assert.ok(r.final_estimated_value >= intrinsic - 1e-9);
      assert.ok(r.final_estimated_value >= 0);
    }
  });

  it('same inputs produce byte-identical results', () => {
    const args = { ...FIXTURE, scenarioUnderlyingPrice: 105, daysForward: 5, scenarioIv: 0.35 };
    const r1 = repriceOptionLocalGreeks(args);
    const r2 = repriceOptionLocalGreeks(args);
    assert.deepEqual(r1, r2);
  });

  it('increasing spot by a small amount does not decrease value for a positive-delta fixture', () => {
    const r1 = repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: 100, daysForward: 0, scenarioIv: 0.3 });
    const r2 = repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: 101, daysForward: 0, scenarioIv: 0.3 });
    assert.ok(r2.final_estimated_value >= r1.final_estimated_value);
  });

  it('higher IV with positive vega does not decrease option value', () => {
    const r1 = repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: 100, daysForward: 0, scenarioIv: 0.30 });
    const r2 = repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: 100, daysForward: 0, scenarioIv: 0.35 });
    assert.ok(r2.final_estimated_value >= r1.final_estimated_value);
  });

  it('time passage with negative theta does not increase value, all else equal', () => {
    const r1 = repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: 100, daysForward: 0, scenarioIv: 0.3 });
    const r2 = repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: 100, daysForward: 5, scenarioIv: 0.3 });
    assert.ok(r2.final_estimated_value <= r1.final_estimated_value);
  });
});

describe('repriceOptionLocalGreeks() — approximation stress test (Step 17, warnings only)', () => {
  it('fires LARGE_SPOT_MOVE for a +30% spot move', () => {
    const r = repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: 130, daysForward: 5, scenarioIv: 0.3 });
    assert.ok(r.warnings.includes('LARGE_SPOT_MOVE'));
  });

  it('fires LARGE_SPOT_MOVE for a -30% spot move', () => {
    const r = repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: 70, daysForward: 5, scenarioIv: 0.3 });
    assert.ok(r.warnings.includes('LARGE_SPOT_MOVE'));
  });

  it('fires LARGE_IV_CHANGE for a +30 point IV shock', () => {
    const r = repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: 100, daysForward: 5, scenarioIv: 0.60 });
    assert.ok(r.warnings.includes('LARGE_IV_CHANGE'));
  });

  it('fires LARGE_IV_CHANGE for a -20 point IV shock', () => {
    const r = repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: 100, daysForward: 5, scenarioIv: 0.10 });
    assert.ok(r.warnings.includes('LARGE_IV_CHANGE'));
  });

  it('fires NEAR_EXPIRATION when remaining DTE <= 5', () => {
    const r = repriceOptionLocalGreeks({ ...FIXTURE, daysToExpiry: 10, scenarioUnderlyingPrice: 100, daysForward: 6, scenarioIv: 0.3 });
    assert.ok(r.warnings.includes('NEAR_EXPIRATION'));
  });

  it('fires LARGE_TIME_STEP when days_forward exceeds min(30, 0.5*DTE)', () => {
    const r = repriceOptionLocalGreeks({ ...FIXTURE, daysToExpiry: 20, scenarioUnderlyingPrice: 100, daysForward: 15, scenarioIv: 0.3 });
    assert.ok(r.warnings.includes('LARGE_TIME_STEP'));
  });

  it('never produces a negative or non-finite value under extreme stress', () => {
    for (const spot of [1, 500, 0.01]) {
      for (const iv of [0.01, 5]) {
        const r = repriceOptionLocalGreeks({ ...FIXTURE, scenarioUnderlyingPrice: spot, daysForward: 5, scenarioIv: iv });
        assert.ok(Number.isFinite(r.final_estimated_value));
        assert.ok(r.final_estimated_value >= 0);
      }
    }
  });
});
