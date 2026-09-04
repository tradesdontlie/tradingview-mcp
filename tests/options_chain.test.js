/**
 * Deterministic, network-free unit tests for the options_get_chain (v2)
 * pure helpers added in Phase -1E: input validation, derived-field math,
 * quality-flag tallying, and date conversion.
 *
 * These do NOT touch CDP/TradingView — no live TradingView session or
 * chart is required to run this file. Live/network-dependent behavior
 * (actual scanner requests) is exercised manually during discovery/
 * regression phases, not here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOptionChainInputs,
  buildOptionChainContract,
  tallyOptionChainQuality,
  ymdToIsoDate,
} from '../src/core/data.js';

describe('ymdToIsoDate()', () => {
  it('converts a YYYYMMDD int to ISO date', () => {
    assert.equal(ymdToIsoDate(20260918), '2026-09-18');
  });

  it('handles single-digit month/day padding already present', () => {
    assert.equal(ymdToIsoDate(20260101), '2026-01-01');
  });
});

describe('validateOptionChainInputs()', () => {
  it('defaults option_type to "all" and max_results to 200', () => {
    const r = validateOptionChainInputs({});
    assert.equal(r.type, 'all');
    assert.equal(r.maxResults, 200);
    assert.equal(r.expirationYmd, null);
  });

  it('accepts call/put/all (case-insensitive)', () => {
    assert.equal(validateOptionChainInputs({ option_type: 'CALL' }).type, 'call');
    assert.equal(validateOptionChainInputs({ option_type: 'put' }).type, 'put');
    assert.equal(validateOptionChainInputs({ option_type: 'all' }).type, 'all');
  });

  it('rejects an invalid option_type', () => {
    assert.throws(() => validateOptionChainInputs({ option_type: 'bogus' }), /Invalid option_type/);
  });

  it('rejects max_results above the hard maximum of 500', () => {
    assert.throws(() => validateOptionChainInputs({ max_results: 1000 }), /exceeds the hard maximum of 500/);
  });

  it('accepts max_results at exactly the hard maximum', () => {
    assert.equal(validateOptionChainInputs({ max_results: 500 }).maxResults, 500);
  });

  it('rejects non-positive max_results', () => {
    assert.throws(() => validateOptionChainInputs({ max_results: 0 }), /Invalid max_results/);
    assert.throws(() => validateOptionChainInputs({ max_results: -5 }), /Invalid max_results/);
  });

  it('parses a valid ISO expiration into YYYYMMDD', () => {
    assert.equal(validateOptionChainInputs({ expiration: '2026-09-18' }).expirationYmd, 20260918);
  });

  it('rejects a malformed expiration date', () => {
    assert.throws(() => validateOptionChainInputs({ expiration: '09/18/2026' }), /Invalid expiration/);
    assert.throws(() => validateOptionChainInputs({ expiration: 'not-a-date' }), /Invalid expiration/);
  });

  it('rejects non-numeric dte/strike bounds', () => {
    assert.throws(() => validateOptionChainInputs({ min_dte: 'soon' }), /Invalid min_dte/);
    assert.throws(() => validateOptionChainInputs({ max_dte: 'later' }), /Invalid max_dte/);
    assert.throws(() => validateOptionChainInputs({ min_strike: 'cheap' }), /Invalid min_strike/);
    assert.throws(() => validateOptionChainInputs({ max_strike: 'pricey' }), /Invalid max_strike/);
  });

  it('accepts valid numeric dte/strike bounds', () => {
    const r = validateOptionChainInputs({ min_dte: 20, max_dte: 60, min_strike: 100, max_strike: 200 });
    assert.equal(r.type, 'all');
  });

  it('rejects delta outside [-1, 1]', () => {
    assert.throws(() => validateOptionChainInputs({ min_delta: -1.5 }), /Invalid min_delta/);
    assert.throws(() => validateOptionChainInputs({ max_delta: 1.5 }), /Invalid max_delta/);
  });

  it('accepts delta at the exact boundary', () => {
    const r = validateOptionChainInputs({ min_delta: -1, max_delta: 1 });
    assert.equal(r.type, 'all');
  });
});

// scan2 field order: expiration, strike, option-type, bid, ask, iv, bid_iv,
// ask_iv, delta, gamma, theta, vega, rho, theoPrice, pricescale, root, currency
function row({
  exp = 20260918, strike = 230, type = 'call', bid = 5, ask = 5.2, iv = 0.33,
  bidIv = 0.32, askIv = 0.34, delta = 0.5, gamma = 0.02, theta = -0.17,
  vega = 0.22, rho = 0.06, theo = 5.1, pricescale = 100, root = 'NVDA', currency = 'USD',
  ticker = 'OPRA:NVDA260918C230.0', dte = 22,
} = {}) {
  return {
    s: ticker,
    dte,
    d: [exp, strike, type, bid, ask, iv, bidIv, askIv, delta, gamma, theta, vega, rho, theo, pricescale, root, currency],
  };
}

describe('buildOptionChainContract() — derived fields', () => {
  it('computes mid/spread/spread_pct from bid/ask', () => {
    const c = buildOptionChainContract(row({ bid: 5, ask: 5.2 }));
    assert.equal(c.mid, 5.1);
    assert.equal(c.spread, 0.2);
    assert.equal(c.spread_pct, round2((0.2 / 5.1) * 100));
  });

  it('returns null derived fields when bid or ask is null', () => {
    const c = buildOptionChainContract(row({ bid: null }));
    assert.equal(c.mid, null);
    assert.equal(c.spread, null);
    assert.equal(c.spread_pct, null);
  });

  it('computes iv_spread from bid_iv/ask_iv, scaled to percent', () => {
    const c = buildOptionChainContract(row({ bidIv: 0.32, askIv: 0.34 }));
    assert.equal(c.iv_spread, round2((0.34 - 0.32) * 100));
  });

  it('returns null iv_spread when either bid_iv or ask_iv is null', () => {
    assert.equal(buildOptionChainContract(row({ bidIv: null })).iv_spread, null);
    assert.equal(buildOptionChainContract(row({ askIv: null })).iv_spread, null);
  });

  it('scales iv/bid_iv/ask_iv from decimal to percent', () => {
    const c = buildOptionChainContract(row({ iv: 0.4513, bidIv: 0.4, askIv: 0.5 }));
    assert.equal(c.iv, 45.13);
    assert.equal(c.bid_iv, 40);
    assert.equal(c.ask_iv, 50);
  });

  it('exposes theoretical_price as the native theoPrice value, unmodified', () => {
    const c = buildOptionChainContract(row({ theo: 8.75 }));
    assert.equal(c.theoretical_price, 8.75);
  });

  it('propagates a null theoPrice as null, never fabricating a value', () => {
    const c = buildOptionChainContract(row({ theo: null }));
    assert.equal(c.theoretical_price, null);
  });

  it('converts expiration and computes days_to_expiry from the row', () => {
    const c = buildOptionChainContract(row({ exp: 20261016, dte: 49 }));
    assert.equal(c.expiration, '2026-10-16');
    assert.equal(c.days_to_expiry, 49);
  });

  it('carries through contract ticker, root, currency, strike, option_type', () => {
    const c = buildOptionChainContract(row({ ticker: 'OPRA:AAPL261016P150.0', root: 'AAPL', currency: 'USD', strike: 150, type: 'put' }));
    assert.equal(c.contract, 'OPRA:AAPL261016P150.0');
    assert.equal(c.root, 'AAPL');
    assert.equal(c.currency, 'USD');
    assert.equal(c.strike, 150);
    assert.equal(c.option_type, 'put');
  });
});

describe('buildOptionChainContract() — quality flags', () => {
  it('flags ZERO_BID when bid is exactly 0', () => {
    const c = buildOptionChainContract(row({ bid: 0 }));
    assert.ok(c.quality_flags.includes('ZERO_BID'));
  });

  it('flags ZERO_ASK when ask is exactly 0', () => {
    const c = buildOptionChainContract(row({ ask: 0 }));
    assert.ok(c.quality_flags.includes('ZERO_ASK'));
  });

  it('flags CROSSED_MARKET when ask < bid', () => {
    const c = buildOptionChainContract(row({ bid: 5, ask: 4 }));
    assert.ok(c.quality_flags.includes('CROSSED_MARKET'));
  });

  it('does not flag CROSSED_MARKET for a normal spread', () => {
    const c = buildOptionChainContract(row({ bid: 4, ask: 5 }));
    assert.ok(!c.quality_flags.includes('CROSSED_MARKET'));
  });

  it('flags MISSING_IV when iv is null', () => {
    const c = buildOptionChainContract(row({ iv: null }));
    assert.ok(c.quality_flags.includes('MISSING_IV'));
  });

  it('flags MISSING_GREEKS when any single greek is null', () => {
    for (const key of ['delta', 'gamma', 'theta', 'vega', 'rho']) {
      const c = buildOptionChainContract(row({ [key]: null }));
      assert.ok(c.quality_flags.includes('MISSING_GREEKS'), `expected MISSING_GREEKS when ${key} is null`);
    }
  });

  it('does not flag MISSING_GREEKS when all greeks are present', () => {
    const c = buildOptionChainContract(row());
    assert.ok(!c.quality_flags.includes('MISSING_GREEKS'));
  });

  it('flags MISSING_THEORETICAL_PRICE when theoPrice is null, without other side effects', () => {
    const c = buildOptionChainContract(row({ theo: null }));
    assert.ok(c.quality_flags.includes('MISSING_THEORETICAL_PRICE'));
    // Missing theoPrice must never imply the contract is otherwise invalid.
    assert.equal(c.bid, 5);
    assert.equal(c.ask, 5.2);
  });

  it('flags WIDE_SPREAD above the 15% threshold', () => {
    const c = buildOptionChainContract(row({ bid: 1, ask: 1.2 })); // mid=1.1, spread=0.2 -> 18.18%
    assert.ok(c.quality_flags.includes('WIDE_SPREAD'));
  });

  it('does not flag WIDE_SPREAD at or below the 15% threshold', () => {
    const c = buildOptionChainContract(row({ bid: 10, ask: 10.5 })); // mid=10.25, spread=0.5 -> 4.88%
    assert.ok(!c.quality_flags.includes('WIDE_SPREAD'));
  });

  it('produces no flags for a fully clean contract', () => {
    const c = buildOptionChainContract(row());
    assert.deepEqual(c.quality_flags, []);
  });
});

describe('tallyOptionChainQuality()', () => {
  it('tallies zero counts for an empty contract list', () => {
    const t = tallyOptionChainQuality([]);
    assert.deepEqual(t, {
      zero_bid_count: 0,
      crossed_market_count: 0,
      missing_iv_count: 0,
      missing_greeks_count: 0,
      missing_theoretical_price_count: 0,
      wide_spread_count: 0,
    });
  });

  it('counts each flag type across multiple contracts', () => {
    const contracts = [
      buildOptionChainContract(row({ bid: 0 })),
      buildOptionChainContract(row({ iv: null })),
      buildOptionChainContract(row({ theo: null })),
      buildOptionChainContract(row()), // clean
    ];
    const t = tallyOptionChainQuality(contracts);
    assert.equal(t.zero_bid_count, 1);
    assert.equal(t.missing_iv_count, 1);
    assert.equal(t.missing_theoretical_price_count, 1);
    assert.equal(t.crossed_market_count, 0);
  });

  it('never marks a contract untradeable purely for MISSING_THEORETICAL_PRICE', () => {
    // Tally is purely additive counting — there is no "untradeable" concept
    // in the data quality summary; this asserts the count is isolated and
    // does not affect or require any other field.
    const contracts = [buildOptionChainContract(row({ theo: null, bid: 5, ask: 5.2 }))];
    const t = tallyOptionChainQuality(contracts);
    assert.equal(t.missing_theoretical_price_count, 1);
    assert.equal(contracts[0].bid, 5);
    assert.equal(contracts[0].ask, 5.2);
  });
});

function round2(v) {
  return v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
}
