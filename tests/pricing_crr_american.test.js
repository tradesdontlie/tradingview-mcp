// Phase 2A — CRR American binomial pricer tests.
//
// Fixture provenance note: no independently-sourced third-party published
// American-option price table was available in this offline environment.
// Ground truth here is established two ways instead of "manufacturing a
// benchmark from the same implementation":
//   1) Black-Scholes-Merton closed form (blackScholes.js, an independent
//      analytic formula) as the convergence target for the boundary case
//      where American == European (non-dividend call, Merton's theorem).
//   2) Theoretical invariants that must hold for ANY correct American
//      option pricer, regardless of implementation (Step 9 A-F).
// This is documented as a limitation in the Phase 2A report (Section K):
// American *put* / dividend-bearing-*call* fixtures are convergence- and
// invariant-validated, not cross-checked against a third-party table.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { priceCrrAmerican } from '../src/core/options/pricing/crrAmerican.js';
import { priceBlackScholes } from '../src/core/options/pricing/blackScholes.js';

describe('CRR American pricer — numerical safety', () => {
  it('returns exact intrinsic at T=0', () => {
    const call = priceCrrAmerican({ option_type: 'call', spot: 120, strike: 100, time_to_expiry_years: 0, volatility: 0.3, risk_free_rate: 0.05, dividend_yield: 0, steps: 100 });
    assert.equal(call.price, 20);
    const put = priceCrrAmerican({ option_type: 'put', spot: 80, strike: 100, time_to_expiry_years: 0, volatility: 0.3, risk_free_rate: 0.05, dividend_yield: 0, steps: 100 });
    assert.equal(put.price, 20);
  });

  it('rejects invalid inputs', () => {
    assert.throws(() => priceCrrAmerican({ option_type: 'call', spot: -1, strike: 100, time_to_expiry_years: 1, volatility: 0.2, risk_free_rate: 0.05, steps: 100 }));
    assert.throws(() => priceCrrAmerican({ option_type: 'call', spot: 100, strike: 100, time_to_expiry_years: 1, volatility: 0, risk_free_rate: 0.05, steps: 100 }));
    assert.throws(() => priceCrrAmerican({ option_type: 'call', spot: 100, strike: 100, time_to_expiry_years: 1, volatility: 0.2, risk_free_rate: 0.05, steps: 0 }));
    assert.throws(() => priceCrrAmerican({ option_type: 'call', spot: 100, strike: 100, time_to_expiry_years: 1, volatility: 0.2, risk_free_rate: 0.05, steps: 10.5 }));
    assert.throws(() => priceCrrAmerican({ option_type: 'swap', spot: 100, strike: 100, time_to_expiry_years: 1, volatility: 0.2, risk_free_rate: 0.05, steps: 100 }));
  });

  it('never returns negative, NaN, or Infinity across a wide input sweep', () => {
    for (const spot of [10, 100, 1000]) {
      for (const strike of [5, 100, 2000]) {
        for (const T of [0.01, 0.5, 3]) {
          for (const vol of [0.05, 0.3, 1.5]) {
            for (const type of ['call', 'put']) {
              const r = priceCrrAmerican({ option_type: type, spot, strike, time_to_expiry_years: T, volatility: vol, risk_free_rate: 0.05, dividend_yield: 0.02, steps: 60 });
              assert.ok(Number.isFinite(r.price) && r.price >= 0, `bad price ${r.price} for ${JSON.stringify({ spot, strike, T, vol, type })}`);
            }
          }
        }
      }
    }
  });

  it('reports metadata: model id, exercise style, dividend model, steps, rate', () => {
    const r = priceCrrAmerican({ option_type: 'put', spot: 100, strike: 100, time_to_expiry_years: 1, volatility: 0.25, risk_free_rate: 0.04, dividend_yield: 0.01, steps: 200 });
    assert.equal(r.pricing_model, 'CRR_AMERICAN_V1');
    assert.equal(r.exercise_style, 'AMERICAN');
    assert.equal(r.dividend_model, 'CONTINUOUS_YIELD');
    assert.equal(r.steps, 200);
    assert.equal(r.risk_free_rate, 0.04);
    assert.equal(r.dividend_yield, 0.01);
  });
});

describe('CRR American pricer — theoretical invariants (Step 9)', () => {
  const cases = [
    { option_type: 'call', spot: 100, strike: 90, T: 0.5, vol: 0.3, r: 0.05, q: 0.0 },
    { option_type: 'put', spot: 100, strike: 110, T: 0.5, vol: 0.3, r: 0.05, q: 0.0 },
    { option_type: 'call', spot: 50, strike: 55, T: 1, vol: 0.4, r: 0.03, q: 0.02 },
    { option_type: 'put', spot: 50, strike: 45, T: 1, vol: 0.4, r: 0.03, q: 0.02 },
    { option_type: 'put', spot: 200, strike: 250, T: 0.25, vol: 0.5, r: 0.02, q: 0.0 }, // deep ITM put
  ];

  it('A) American price >= intrinsic', () => {
    for (const c of cases) {
      const intrinsic = c.option_type === 'call' ? Math.max(c.spot - c.strike, 0) : Math.max(c.strike - c.spot, 0);
      const r = priceCrrAmerican({ option_type: c.option_type, spot: c.spot, strike: c.strike, time_to_expiry_years: c.T, volatility: c.vol, risk_free_rate: c.r, dividend_yield: c.q, steps: 400 });
      assert.ok(r.price >= intrinsic - 1e-6, `American ${c.option_type} ${r.price} < intrinsic ${intrinsic}`);
    }
  });

  it('B) American price >= corresponding European price', () => {
    for (const c of cases) {
      const american = priceCrrAmerican({ option_type: c.option_type, spot: c.spot, strike: c.strike, time_to_expiry_years: c.T, volatility: c.vol, risk_free_rate: c.r, dividend_yield: c.q, steps: 400 });
      const european = priceBlackScholes({ option_type: c.option_type, spot: c.spot, strike: c.strike, time_to_expiry_years: c.T, volatility: c.vol, risk_free_rate: c.r, dividend_yield: c.q });
      assert.ok(american.price >= european.price - 0.02, `American ${american.price} < European ${european.price} for ${JSON.stringify(c)}`);
    }
  });

  it('C) non-dividend American call ≈ European call (Merton) within convergence tolerance', () => {
    const params = { option_type: 'call', spot: 100, strike: 95, time_to_expiry_years: 0.75, volatility: 0.28, risk_free_rate: 0.045, dividend_yield: 0 };
    const american = priceCrrAmerican({ ...params, steps: 800 });
    const european = priceBlackScholes(params);
    assert.ok(Math.abs(american.price - european.price) < 0.02, `American ${american.price} vs European ${european.price} diverge beyond tolerance`);
  });

  it('D) American put may exceed European put when early exercise has value', () => {
    // Deep ITM put, no dividends, non-trivial rate: early exercise value should be positive.
    const params = { option_type: 'put', spot: 60, strike: 100, time_to_expiry_years: 0.5, volatility: 0.25, risk_free_rate: 0.06, dividend_yield: 0 };
    const american = priceCrrAmerican({ ...params, steps: 400 });
    const european = priceBlackScholes(params);
    assert.ok(american.price > european.price + 0.01, `expected American put (${american.price}) > European put (${european.price})`);
  });

  it('E) increasing volatility never reduces standard call/put value', () => {
    for (const type of ['call', 'put']) {
      let prev = 0;
      for (const vol of [0.1, 0.2, 0.3, 0.5, 0.8]) {
        const r = priceCrrAmerican({ option_type: type, spot: 100, strike: 100, time_to_expiry_years: 0.5, volatility: vol, risk_free_rate: 0.04, dividend_yield: 0.01, steps: 300 });
        assert.ok(r.price >= prev - 1e-6, `${type} price decreased from ${prev} to ${r.price} as vol rose to ${vol}`);
        prev = r.price;
      }
    }
  });

  it('F) more steps converge rather than diverge materially', () => {
    const params = { option_type: 'put', spot: 100, strike: 105, time_to_expiry_years: 1, volatility: 0.35, risk_free_rate: 0.04, dividend_yield: 0.015 };
    const stepCounts = [50, 100, 200, 400, 800, 1600];
    const prices = stepCounts.map(steps => priceCrrAmerican({ ...params, steps }).price);
    const reference = prices[prices.length - 1];
    for (let i = 1; i < prices.length; i++) {
      const diffPrev = Math.abs(prices[i - 1] - reference);
      const diffCur = Math.abs(prices[i] - reference);
      // Not strictly monotonic every single step (CRR has known odd/even
      // oscillation), but must trend down: any later step count should be
      // no worse than 2x the error of the very first (coarsest) step count.
      assert.ok(diffCur <= diffPrev * 2 + 1e-9, `error grew materially: steps=${stepCounts[i]} diff=${diffCur} vs steps=${stepCounts[i - 1]} diff=${diffPrev}`);
    }
  });
});

describe('CRR American pricer — early exercise validation (Step 18)', () => {
  it('deep ITM American put actually exercises early at some nodes', () => {
    const r = priceCrrAmerican(
      { option_type: 'put', spot: 50, strike: 100, time_to_expiry_years: 1, volatility: 0.3, risk_free_rate: 0.05, dividend_yield: 0, steps: 200 },
      { diagnostics: true },
    );
    assert.ok(r.early_exercise_node_count > 0, 'expected at least one early-exercise node for a deep ITM put');
  });

  it('dividend-bearing American call can carry early-exercise value', () => {
    const r = priceCrrAmerican(
      { option_type: 'call', spot: 150, strike: 90, time_to_expiry_years: 0.5, volatility: 0.2, risk_free_rate: 0.02, dividend_yield: 0.08, steps: 200 },
      { diagnostics: true },
    );
    assert.ok(r.early_exercise_node_count > 0, 'expected early-exercise nodes for a deep ITM call on a high-dividend-yield underlying');
    const european = priceBlackScholes({ option_type: 'call', spot: 150, strike: 90, time_to_expiry_years: 0.5, volatility: 0.2, risk_free_rate: 0.02, dividend_yield: 0.08 });
    assert.ok(r.price > european.price, 'expected American call value > European call value under a high dividend yield');
  });

  it('OTM options with little time remaining show zero or near-zero early exercise', () => {
    const r = priceCrrAmerican(
      { option_type: 'call', spot: 100, strike: 200, time_to_expiry_years: 0.1, volatility: 0.2, risk_free_rate: 0.03, dividend_yield: 0, steps: 100 },
      { diagnostics: true },
    );
    assert.equal(r.early_exercise_node_count, 0);
  });
});
