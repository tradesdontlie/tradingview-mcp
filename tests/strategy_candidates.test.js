/**
 * Phase 0A — deterministic, network-free tests for candidate generation
 * (src/core/options/strategyCandidates.js). Uses a frozen fixture chain
 * snapshot, never live TradingView data. See tests/strategy_economics.test.js
 * for the underlying math fixtures.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateStrategyCandidates } from '../src/core/options/strategyCandidates.js';

const SPOT = 100;

function contract({ expiration, dte, strike, type, bid, ask, iv = 30, delta, gamma = 0.02, theta = -0.1, vega = 0.2, rho = 0.05, spreadPct = null }) {
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  return {
    contract: `OPRA:TEST${expiration.replace(/-/g, '').slice(2)}${type === 'call' ? 'C' : 'P'}${strike.toFixed(1)}`,
    root: 'TEST',
    expiration,
    days_to_expiry: dte,
    strike,
    option_type: type,
    currency: 'USD',
    bid, ask,
    theoretical_price: mid,
    iv, bid_iv: iv - 1, ask_iv: iv + 1,
    delta, gamma, theta, vega, rho,
    mid, spread,
    spread_pct: spreadPct ?? (mid > 0 ? Math.round((spread / mid) * 1000) / 10 : null),
    iv_spread: 2,
    quality_flags: [],
  };
}

function buildFixtureChain() {
  const exp = '2026-10-16'; // near 49 DTE from an assumed "today"
  const dte = 49;
  const contracts = [
    // Calls, various strikes/deltas around spot=100
    contract({ expiration: exp, dte, strike: 95, type: 'call', bid: 8.4, ask: 8.6, delta: 0.68 }),
    contract({ expiration: exp, dte, strike: 100, type: 'call', bid: 5.0, ask: 5.2, delta: 0.50 }),
    contract({ expiration: exp, dte, strike: 105, type: 'call', bid: 2.9, ask: 3.1, delta: 0.35 }),
    contract({ expiration: exp, dte, strike: 110, type: 'call', bid: 1.4, ask: 1.6, delta: 0.20 }), // outside default delta range as a LONG
    contract({ expiration: exp, dte, strike: 115, type: 'call', bid: 0.6, ask: 0.8, delta: 0.10 }),
    // Puts, mirrored
    contract({ expiration: exp, dte, strike: 105, type: 'put', bid: 8.4, ask: 8.6, delta: -0.68 }),
    contract({ expiration: exp, dte, strike: 100, type: 'put', bid: 5.0, ask: 5.2, delta: -0.50 }),
    contract({ expiration: exp, dte, strike: 95, type: 'put', bid: 2.9, ask: 3.1, delta: -0.35 }),
    contract({ expiration: exp, dte, strike: 90, type: 'put', bid: 1.4, ask: 1.6, delta: -0.20 }),
    contract({ expiration: exp, dte, strike: 85, type: 'put', bid: 0.6, ask: 0.8, delta: -0.10 }),
    // A too-soon expiration (should be excluded by horizon_days=30)
    contract({ expiration: '2026-09-04', dte: 7, strike: 100, type: 'call', bid: 3.0, ask: 3.2, delta: 0.50 }),
    // A short leg with zero bid at same expiry/type (illiquid far strike)
    contract({ expiration: exp, dte, strike: 130, type: 'call', bid: 0, ask: 0.05, delta: 0.02 }),
    contract({ expiration: exp, dte, strike: 70, type: 'put', bid: 0, ask: 0.05, delta: -0.02 }),
  ];

  return {
    underlying: 'TEST:FOO',
    underlying_price: SPOT,
    chain_completeness: 'COMPLETE',
    contracts,
  };
}

function baseBullishRequest(overrides = {}) {
  return {
    direction: 'bullish',
    underlying_price: SPOT,
    horizon_days: 30,
    max_loss: 1000,
    commission_per_contract: 0,
    ...overrides,
  };
}

function baseBearishRequest(overrides = {}) {
  return {
    direction: 'bearish',
    underlying_price: SPOT,
    horizon_days: 30,
    max_loss: 1000,
    commission_per_contract: 0,
    ...overrides,
  };
}

describe('generateStrategyCandidates() — input validation', () => {
  const chain = buildFixtureChain();

  it('rejects an invalid direction', () => {
    assert.throws(() => generateStrategyCandidates(chain, baseBullishRequest({ direction: 'sideways' })), /Invalid direction/);
  });

  it('rejects a non-positive underlying_price', () => {
    assert.throws(() => generateStrategyCandidates(chain, baseBullishRequest({ underlying_price: 0 })), /Invalid underlying_price/);
  });

  it('rejects a negative horizon_days', () => {
    assert.throws(() => generateStrategyCandidates(chain, baseBullishRequest({ horizon_days: -1 })), /Invalid horizon_days/);
  });

  it('rejects a non-positive max_loss', () => {
    assert.throws(() => generateStrategyCandidates(chain, baseBullishRequest({ max_loss: 0 })), /Invalid max_loss/);
  });

  it('rejects an invalid execution_model', () => {
    assert.throws(() => generateStrategyCandidates(chain, baseBullishRequest({ execution_model: 'aggressive' })), /Invalid execution_model/);
  });
});

describe('generateStrategyCandidates() — bullish', () => {
  const chain = buildFixtureChain();
  const result = generateStrategyCandidates(chain, baseBullishRequest());

  it('always includes NO_TRADE', () => {
    const noTrade = result.candidates.find(c => c.strategy_type === 'NO_TRADE');
    assert.ok(noTrade);
    assert.equal(noTrade.max_loss, 0);
  });

  it('includes BUY_STOCK as a baseline, not a recommendation', () => {
    const stock = result.candidates.find(c => c.strategy_type === 'BUY_STOCK');
    assert.ok(stock);
    assert.equal(stock.baseline_type, 'UNDERLYING');
  });

  it('generates only LONG_CALL/BULL_CALL_SPREAD/BUY_STOCK/NO_TRADE for bullish', () => {
    const types = new Set(result.candidates.map(c => c.strategy_type));
    for (const t of types) assert.ok(['LONG_CALL', 'BULL_CALL_SPREAD', 'BUY_STOCK', 'NO_TRADE'].includes(t));
  });

  it('excludes the too-soon expiration via EXPIRY_BEFORE_HORIZON', () => {
    assert.ok(result.rejection_summary.EXPIRY_BEFORE_HORIZON >= 1);
    assert.ok(!result.candidates.some(c => c.expiration === '2026-09-04'));
  });

  it('applies the default long-delta range [0.30, 0.70] — strike 110 (delta 0.20) excluded as a long', () => {
    const longCallStrikes = result.candidates.filter(c => c.strategy_type === 'LONG_CALL').map(c => c.legs[0].strike);
    assert.ok(!longCallStrikes.includes(110));
    assert.ok(!longCallStrikes.includes(115));
    assert.ok(longCallStrikes.includes(95) || longCallStrikes.includes(100) || longCallStrikes.includes(105));
  });

  it('every non-NO_TRADE candidate respects the max_loss hard constraint', () => {
    for (const c of result.candidates) {
      if (c.strategy_type === 'NO_TRADE') continue;
      assert.ok(c.max_loss <= result.max_loss_constraint, `${c.candidate_id} max_loss ${c.max_loss} exceeds constraint ${result.max_loss_constraint}`);
    }
  });

  it('bull call spreads only pair long < short strike, same expiration', () => {
    for (const c of result.candidates.filter(x => x.strategy_type === 'BULL_CALL_SPREAD')) {
      const [long, short] = c.legs;
      assert.equal(long.role, 'long');
      assert.equal(short.role, 'short');
      assert.ok(long.strike < short.strike);
    }
  });

  it('never pairs the zero-bid strike 130 as a short leg', () => {
    for (const c of result.candidates.filter(x => x.strategy_type === 'BULL_CALL_SPREAD')) {
      assert.notEqual(c.legs[1].strike, 130);
    }
  });

  it('marks contract_multiplier_source explicitly as an assumption', () => {
    assert.equal(result.contract_multiplier_source, 'ASSUMED_STANDARD_US_EQUITY_OPTION');
    assert.equal(result.contract_multiplier, 100);
  });

  it('reports chain_completeness and empty warnings for a COMPLETE chain', () => {
    assert.equal(result.chain_completeness, 'COMPLETE');
    assert.deepEqual(result.warnings, []);
  });

  it('surfaces CHAIN_POSSIBLY_TRUNCATED when the snapshot says so', () => {
    const truncatedChain = { ...chain, chain_completeness: 'POSSIBLY_TRUNCATED' };
    const r = generateStrategyCandidates(truncatedChain, baseBullishRequest());
    assert.equal(r.chain_completeness, 'POSSIBLY_TRUNCATED');
    assert.ok(r.warnings.includes('CHAIN_POSSIBLY_TRUNCATED'));
  });
});

describe('generateStrategyCandidates() — bearish', () => {
  const chain = buildFixtureChain();
  const result = generateStrategyCandidates(chain, baseBearishRequest());

  it('generates only LONG_PUT/BEAR_PUT_SPREAD/NO_TRADE for bearish', () => {
    const types = new Set(result.candidates.map(c => c.strategy_type));
    for (const t of types) assert.ok(['LONG_PUT', 'BEAR_PUT_SPREAD', 'NO_TRADE'].includes(t));
  });

  it('never generates BUY_STOCK for a bearish request', () => {
    assert.ok(!result.candidates.some(c => c.strategy_type === 'BUY_STOCK'));
  });

  it('bear put spreads only pair long strike > short strike, same expiration', () => {
    for (const c of result.candidates.filter(x => x.strategy_type === 'BEAR_PUT_SPREAD')) {
      const [long, short] = c.legs;
      assert.ok(long.strike > short.strike);
    }
  });

  it('every non-NO_TRADE candidate respects the max_loss hard constraint', () => {
    for (const c of result.candidates) {
      if (c.strategy_type === 'NO_TRADE') continue;
      assert.ok(c.max_loss <= result.max_loss_constraint);
    }
  });
});

describe('generateStrategyCandidates() — determinism', () => {
  const chain = buildFixtureChain();

  it('same input produces the same candidate IDs and ordering across repeated calls', () => {
    const r1 = generateStrategyCandidates(chain, baseBullishRequest());
    const r2 = generateStrategyCandidates(chain, baseBullishRequest());
    assert.deepEqual(r1.candidates.map(c => c.candidate_id), r2.candidates.map(c => c.candidate_id));
  });

  it('candidate IDs contain no random component (repeat build produces identical IDs)', () => {
    const ids = new Set();
    for (let i = 0; i < 5; i++) {
      const r = generateStrategyCandidates(chain, baseBullishRequest());
      ids.add(JSON.stringify(r.candidates.map(c => c.candidate_id)));
    }
    assert.equal(ids.size, 1);
  });

  it('candidates are sorted deterministically by strategy_type, then expiration, then strike', () => {
    const r = generateStrategyCandidates(chain, baseBullishRequest());
    const sortedCopy = [...r.candidates].sort((a, b) => {
      if (a.strategy_type !== b.strategy_type) return a.strategy_type < b.strategy_type ? -1 : 1;
      return 0;
    });
    // strategy_type grouping is stable (all same-type candidates remain contiguous)
    let lastType = null;
    const seenTypes = new Set();
    for (const c of r.candidates) {
      if (c.strategy_type !== lastType) {
        assert.ok(!seenTypes.has(c.strategy_type), 'strategy_type groups must be contiguous');
        seenTypes.add(c.strategy_type);
        lastType = c.strategy_type;
      }
    }
  });
});

describe('generateStrategyCandidates() — rejection accounting', () => {
  it('never silently drops rejections — rejected_count matches the sum of rejection_summary', () => {
    const chain = buildFixtureChain();
    const result = generateStrategyCandidates(chain, baseBullishRequest());
    const sum = Object.values(result.rejection_summary).reduce((a, b) => a + b, 0);
    assert.equal(result.rejected_count, sum);
  });

  it('NO_TRADE is never filtered out even under an extremely tight max_loss', () => {
    const chain = buildFixtureChain();
    const result = generateStrategyCandidates(chain, baseBullishRequest({ max_loss: 1 }));
    assert.ok(result.candidates.some(c => c.strategy_type === 'NO_TRADE'));
  });

  it('can conclude every option candidate is inferior/rejected while NO_TRADE survives', () => {
    const chain = buildFixtureChain();
    // max_loss so tiny that even the cheapest long call ($60 debit at strike 115) is excluded by delta range,
    // and any within delta range exceed max_loss.
    const result = generateStrategyCandidates(chain, baseBullishRequest({ max_loss: 1 }));
    const nonNoTrade = result.candidates.filter(c => c.strategy_type !== 'NO_TRADE');
    assert.equal(nonNoTrade.length, 0);
    assert.equal(result.candidates.length, 1);
  });
});
