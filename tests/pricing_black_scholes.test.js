// Phase 2A — Black-Scholes-Merton EUROPEAN reference pricer tests.
// Fixture provenance: closed-form Black-Scholes-Merton formula (Hull,
// "Options, Futures and Other Derivatives") re-derived independently in
// blackScholes.js. Used only to (a) validate the closed-form implementation
// against a hand-computable, well-known analytic case and (b) as the
// convergence target for the CRR American tree on a non-dividend
// underlying, where American call value == European call value (Merton).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { priceBlackScholes } from '../src/core/options/pricing/blackScholes.js';

describe('Black-Scholes-Merton reference pricer', () => {
  it('matches a hand-computable ATM case (S=K=100, r=5%, q=0, vol=20%, T=1y)', () => {
    // d1 = (0 + (0.05+0.02)*1)/0.2 = 0.35, d2 = 0.15
    // N(0.35)=0.6368, N(0.15)=0.5596, N(-0.35)=0.3632, N(-0.15)=0.4404
    // call = 100*N(d1) - 100*e^-0.05*N(d2) = 63.68 - 95.123*0.5596 = 63.68 - 53.223 = 10.45
    const call = priceBlackScholes({
      option_type: 'call', spot: 100, strike: 100, time_to_expiry_years: 1,
      volatility: 0.2, risk_free_rate: 0.05, dividend_yield: 0,
    });
    assert.ok(Math.abs(call.price - 10.45) < 0.05, `expected ~10.45, got ${call.price}`);
  });

  it('put-call parity holds: C - P = S*e^-qT - K*e^-rT', () => {
    const spot = 137, strike = 130, T = 0.5, vol = 0.35, r = 0.04, q = 0.012;
    const call = priceBlackScholes({ option_type: 'call', spot, strike, time_to_expiry_years: T, volatility: vol, risk_free_rate: r, dividend_yield: q });
    const put = priceBlackScholes({ option_type: 'put', spot, strike, time_to_expiry_years: T, volatility: vol, risk_free_rate: r, dividend_yield: q });
    const expected = spot * Math.exp(-q * T) - strike * Math.exp(-r * T);
    assert.ok(Math.abs((call.price - put.price) - expected) < 1e-4, `parity violated: C-P=${call.price - put.price}, expected=${expected}`);
  });

  it('returns exact intrinsic at T=0', () => {
    const itmCall = priceBlackScholes({ option_type: 'call', spot: 120, strike: 100, time_to_expiry_years: 0, volatility: 0.3, risk_free_rate: 0.05, dividend_yield: 0 });
    assert.equal(itmCall.price, 20);
    const otmPut = priceBlackScholes({ option_type: 'put', spot: 120, strike: 100, time_to_expiry_years: 0, volatility: 0.3, risk_free_rate: 0.05, dividend_yield: 0 });
    assert.equal(otmPut.price, 0);
  });

  it('never returns negative, NaN, or Infinity for a wide input sweep', () => {
    for (const spot of [10, 100, 1000]) {
      for (const strike of [5, 100, 2000]) {
        for (const T of [0, 0.01, 1, 5]) {
          for (const vol of [0.05, 0.3, 2]) {
            for (const type of ['call', 'put']) {
              const r = priceBlackScholes({ option_type: type, spot, strike, time_to_expiry_years: T, volatility: vol, risk_free_rate: 0.05, dividend_yield: 0.01 });
              assert.ok(Number.isFinite(r.price) && r.price >= 0, `bad price ${r.price} for ${JSON.stringify({ spot, strike, T, vol, type })}`);
            }
          }
        }
      }
    }
  });

  it('rejects invalid inputs', () => {
    assert.throws(() => priceBlackScholes({ option_type: 'call', spot: -1, strike: 100, time_to_expiry_years: 1, volatility: 0.2, risk_free_rate: 0.05 }));
    assert.throws(() => priceBlackScholes({ option_type: 'call', spot: 100, strike: 100, time_to_expiry_years: -1, volatility: 0.2, risk_free_rate: 0.05 }));
    assert.throws(() => priceBlackScholes({ option_type: 'straddle', spot: 100, strike: 100, time_to_expiry_years: 1, volatility: 0.2, risk_free_rate: 0.05 }));
  });
});
