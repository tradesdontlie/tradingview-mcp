// Phase 2C — tests for production market inputs, providers, the carry
// sign convention, the CRR shadow scenario pipeline, expiration
// reconciliation, model disagreement, and shadow ranking determinism.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDiscountRate, resolveDividendInput, resolveBorrowInput,
  computeEffectiveCarryYield, buildMarketInputRecord, DIVIDEND_MODES, MARKET_INPUT_MODES,
} from '../src/core/options/marketInputs/productionMarketInputs.js';
import { fixtureDividendProvider, toDividendInput } from '../src/core/options/marketInputs/dividendProviders.js';
import { notConnectedBorrowProvider, fixtureBorrowProvider, toBorrowInput } from '../src/core/options/marketInputs/borrowProviders.js';
import { priceCrrAmerican } from '../src/core/options/pricing/crrAmerican.js';
import { repriceOptionCrrShadow } from '../src/core/options/pricing/crrShadowRepricer.js';
import { generateCandidateScenarioResultsCrrShadow, computeModelDisagreement, DISAGREEMENT_LEVELS } from '../src/core/options/marketInputs/crrShadowScenario.js';
import { generateStrategyCandidates } from '../src/core/options/strategyCandidates.js';
import { generateCandidateScenarioResults } from '../src/core/options/strategyScenarios.js';
import { rankStrategyCandidates } from '../src/core/options/strategyRanking.js';

const BILL_RATES = { fourWeek: 0.0375, sixWeek: 0.0377, eightWeek: 0.0379, thirteenWeek: 0.0383, seventeenWeek: 0.039, twentySixWeek: 0.0398, fiftyTwoWeek: 0.0414 };

describe('resolveDiscountRate', () => {
  it('resolves from Treasury bill rates when available', () => {
    const r = resolveDiscountRate({ dte: 41, billRates: BILL_RATES, asOfDate: '2026-08-28' });
    assert.ok(r.discount_rate > 0.03 && r.discount_rate < 0.04);
    assert.equal(r.discount_rate_source, 'TREASURY_BILL_COUPON_EQUIVALENT_NORMALIZED');
  });

  it('returns MARKET_INPUT_UNAVAILABLE rather than fabricating a rate when data is missing', () => {
    const r = resolveDiscountRate({ dte: 41, billRates: null, asOfDate: null });
    assert.equal(r.discount_rate, null);
    assert.equal(r.discount_rate_source, 'MARKET_INPUT_UNAVAILABLE');
    assert.ok(r.warnings.includes('MARKET_INPUT_UNAVAILABLE'));
  });

  it('only uses a stale fallback when explicitly supplied (configurable policy, not silent)', () => {
    const stale = { discount_rate: 0.04, discount_rate_as_of_utc: '2026-08-01' };
    const r = resolveDiscountRate({ dte: 41, billRates: null, asOfDate: null, staleFallback: stale });
    assert.equal(r.discount_rate, 0.04);
    assert.ok(r.warnings.includes('TREASURY_DATA_STALE'));
  });
});

describe('resolveDividendInput — modes', () => {
  it('ZERO_DIVIDEND_CONFIRMED sets q=0 explicitly, distinct from unavailable', () => {
    const r = resolveDividendInput({ mode: DIVIDEND_MODES.ZERO_DIVIDEND_CONFIRMED, source: 'DOCUMENTED' });
    assert.equal(r.annualized_yield, 0);
    assert.equal(r.confidence, 'HIGH');
  });

  it('DIVIDEND_DATA_UNAVAILABLE never becomes a silent zero', () => {
    const r = resolveDividendInput({ mode: DIVIDEND_MODES.DIVIDEND_DATA_UNAVAILABLE });
    assert.equal(r.annualized_yield, null);
    assert.ok(r.warnings.includes('DIVIDEND_DATA_UNAVAILABLE'));
  });

  it('FORWARD_ANNUAL_DIVIDEND_APPROXIMATION divides by spot and labels the approximation', () => {
    const r = resolveDividendInput({ mode: DIVIDEND_MODES.FORWARD_ANNUAL_DIVIDEND_APPROXIMATION, spot: 100, expected12mDividendPerShare: 2 });
    assert.equal(r.annualized_yield, 0.02);
    assert.ok(r.warnings.includes('CONTINUOUS_DIVIDEND_APPROXIMATION'));
  });

  it('DISCRETE_DIVIDENDS is documented as out-of-scope for V1, not silently approximated', () => {
    assert.throws(() => resolveDividendInput({ mode: DIVIDEND_MODES.DISCRETE_DIVIDENDS }));
  });
});

describe('resolveBorrowInput', () => {
  it('unconnected/missing fee stays null, never silently 0', () => {
    const r = resolveBorrowInput({ connected: false, feeRate: null });
    assert.equal(r.fee_rate, null);
    assert.ok(r.warnings.includes('BORROW_DATA_UNAVAILABLE'));
  });

  it('connected provider with a fee rate passes through', () => {
    const r = resolveBorrowInput({ connected: true, feeRate: 0.03, source: 'FIXTURE' });
    assert.equal(r.fee_rate, 0.03);
    assert.equal(r.warnings.length, 0);
  });
});

describe('buildMarketInputRecord — FULL vs PARTIAL vs UNAVAILABLE', () => {
  const discount = resolveDiscountRate({ dte: 41, billRates: BILL_RATES, asOfDate: '2026-08-28' });
  const dividend = resolveDividendInput({ mode: DIVIDEND_MODES.ZERO_DIVIDEND_CONFIRMED, source: 'DOCUMENTED' });

  it('FULL_EXTERNAL_INPUTS when discount+dividend+borrow all present', () => {
    const borrow = resolveBorrowInput({ connected: true, feeRate: 0.01, source: 'FIXTURE' });
    const rec = buildMarketInputRecord({ expiration: '2026-10-09', daysToExpiry: 41, discount, dividend, borrow });
    assert.equal(rec.mode, MARKET_INPUT_MODES.FULL_EXTERNAL_INPUTS);
    assert.equal(rec.effective_carry_yield, 0.01);
  });

  it('PARTIAL_EXTERNAL_INPUTS caps confidence at MEDIUM when borrow is unavailable', () => {
    const borrow = resolveBorrowInput({ connected: false, feeRate: null });
    const rec = buildMarketInputRecord({ expiration: '2026-10-09', daysToExpiry: 41, discount, dividend, borrow });
    assert.equal(rec.mode, MARKET_INPUT_MODES.PARTIAL_EXTERNAL_INPUTS);
    assert.notEqual(rec.overall_confidence, 'HIGH');
    assert.ok(rec.warnings.includes('BORROW_DATA_UNAVAILABLE'));
  });

  it('MARKET_INPUT_UNAVAILABLE when discount or dividend is missing', () => {
    const unavailDividend = resolveDividendInput({ mode: DIVIDEND_MODES.DIVIDEND_DATA_UNAVAILABLE });
    const borrow = resolveBorrowInput({ connected: true, feeRate: 0.01 });
    const rec = buildMarketInputRecord({ expiration: '2026-10-09', daysToExpiry: 41, discount, dividend: unavailDividend, borrow });
    assert.equal(rec.mode, MARKET_INPUT_MODES.MARKET_INPUT_UNAVAILABLE);
    assert.equal(rec.effective_carry_yield, null);
  });
});

describe('dividend/borrow providers', () => {
  it('fixtureDividendProvider + toDividendInput resolves a forward approximation', async () => {
    const provider = fixtureDividendProvider({ AAPL: { expected_12m_dividend_per_share: 1.08 } });
    const result = await provider('AAPL');
    const input = toDividendInput(result, { spot: 320 });
    assert.equal(input.mode, DIVIDEND_MODES.FORWARD_ANNUAL_DIVIDEND_APPROXIMATION);
    assert.ok(Math.abs(input.annualized_yield - 1.08 / 320) < 1e-9);
  });

  it('notConnectedBorrowProvider always returns NOT_CONNECTED with null fee', async () => {
    const r = await notConnectedBorrowProvider('PANW');
    assert.equal(r.provider_status, 'NOT_CONNECTED');
    assert.equal(r.borrow_fee_rate, null);
    const input = toBorrowInput(r);
    assert.equal(input.fee_rate, null);
  });

  it('fixtureBorrowProvider returns a connected fee when present in the fixture', async () => {
    const provider = fixtureBorrowProvider({ PANW: { borrow_fee_rate: 0.005 } });
    const r = await provider('PANW');
    const input = toBorrowInput(r);
    assert.equal(input.fee_rate, 0.005);
  });
});

describe('Step 7 — carry sign convention', () => {
  const base = { option_type: 'call', spot: 100, strike: 100, time_to_expiry_years: 0.5, volatility: 0.3, risk_free_rate: 0.04, steps: 200 };

  it('higher dividend_yield component lowers call value and raises put value', () => {
    const callLowQ = priceCrrAmerican({ ...base, dividend_yield: 0.0 }).price;
    const callHighQ = priceCrrAmerican({ ...base, dividend_yield: 0.05 }).price;
    assert.ok(callHighQ < callLowQ, `expected higher q to lower call value: ${callLowQ} -> ${callHighQ}`);

    const putLowQ = priceCrrAmerican({ ...base, option_type: 'put', dividend_yield: 0.0 }).price;
    const putHighQ = priceCrrAmerican({ ...base, option_type: 'put', dividend_yield: 0.05 }).price;
    assert.ok(putHighQ > putLowQ, `expected higher q to raise put value: ${putLowQ} -> ${putHighQ}`);
  });

  it('computeEffectiveCarryYield is additive: higher borrow fee behaves identically in direction to higher dividend yield', () => {
    const qDivOnly = computeEffectiveCarryYield({ dividendYield: 0.05, borrowFeeRate: 0 });
    const qBorrowOnly = computeEffectiveCarryYield({ dividendYield: 0, borrowFeeRate: 0.05 });
    assert.equal(qDivOnly, qBorrowOnly);
    // Same q => identical CRR price regardless of how the carry was decomposed.
    const priceFromDiv = priceCrrAmerican({ ...base, dividend_yield: qDivOnly }).price;
    const priceFromBorrow = priceCrrAmerican({ ...base, dividend_yield: qBorrowOnly }).price;
    assert.equal(priceFromDiv, priceFromBorrow);
  });

  it('composed carry (div+borrow) lowers call value more than dividend alone', () => {
    const callDivOnly = priceCrrAmerican({ ...base, dividend_yield: 0.02 }).price;
    const callDivPlusBorrow = priceCrrAmerican({ ...base, dividend_yield: computeEffectiveCarryYield({ dividendYield: 0.02, borrowFeeRate: 0.03 }) }).price;
    assert.ok(callDivPlusBorrow < callDivOnly);
  });
});

describe('repriceOptionCrrShadow', () => {
  const scenarioBase = { optionType: 'call', strike: 100, currentUnderlyingPrice: 100, daysToExpiry: 49, currentIv: 0.30 };

  it('reconciles to exact intrinsic at/beyond expiration', () => {
    const r = repriceOptionCrrShadow({ ...scenarioBase, scenarioUnderlyingPrice: 120, scenarioIv: 0.30, daysForward: 49, discountRate: 0.04, effectiveCarryYield: 0.01 });
    assert.equal(r.final_estimated_value, 20);
  });

  it('reports MARKET_INPUT_UNAVAILABLE when discount rate or carry is missing, never fabricates a price', () => {
    const r = repriceOptionCrrShadow({ ...scenarioBase, scenarioUnderlyingPrice: 110, scenarioIv: 0.30, daysForward: 10, discountRate: null, effectiveCarryYield: 0.01 });
    assert.equal(r.available, false);
    assert.ok(r.warnings.includes('MARKET_INPUT_UNAVAILABLE'));
  });

  it('flags CONSTANT_CONTRACT_IV_SHIFT for non-expiry scenarios', () => {
    const r = repriceOptionCrrShadow({ ...scenarioBase, scenarioUnderlyingPrice: 105, scenarioIv: 0.35, daysForward: 10, discountRate: 0.04, effectiveCarryYield: 0.01 });
    assert.ok(r.warnings.includes('CONSTANT_CONTRACT_IV_SHIFT'));
  });
});

describe('computeModelDisagreement — Step 16/17 frozen thresholds', () => {
  it('LOW at <=10% of max loss', () => {
    assert.equal(computeModelDisagreement(100, 105, 1000).level, DISAGREEMENT_LEVELS.LOW);
  });
  it('MEDIUM at >10% and <=25%', () => {
    assert.equal(computeModelDisagreement(100, 250, 1000).level, DISAGREEMENT_LEVELS.MEDIUM);
  });
  it('HIGH at >25%', () => {
    assert.equal(computeModelDisagreement(100, 500, 1000).level, DISAGREEMENT_LEVELS.HIGH);
  });
});

// --- CRR shadow scenario pipeline integration (Steps 14-15, 26-27) ---------

const SPOT = 100;
function contract({ expiration, dte, strike, type, bid, ask, iv = 30, delta, gamma = 0.02, theta = -0.1, vega = 0.2, rho = 0.05 }) {
  const mid = (bid + ask) / 2;
  return {
    contract: `OPRA:TEST${expiration.replace(/-/g, '').slice(2)}${type === 'call' ? 'C' : 'P'}${strike.toFixed(1)}`,
    root: 'TEST', expiration, days_to_expiry: dte, strike, option_type: type, currency: 'USD',
    bid, ask, theoretical_price: mid, iv, bid_iv: iv - 1, ask_iv: iv + 1, delta, gamma, theta, vega, rho,
    mid, spread: ask - bid, spread_pct: mid > 0 ? Math.round(((ask - bid) / mid) * 1000) / 10 : null, iv_spread: 2, quality_flags: [],
  };
}
function buildFixtureChain() {
  const exp = '2026-10-16', dte = 49;
  const contracts = [
    contract({ expiration: exp, dte, strike: 100, type: 'call', bid: 5.0, ask: 5.2, delta: 0.50 }),
    contract({ expiration: exp, dte, strike: 110, type: 'call', bid: 1.4, ask: 1.6, delta: 0.35 }),
    contract({ expiration: exp, dte, strike: 100, type: 'put', bid: 5.0, ask: 5.2, delta: -0.50 }),
    contract({ expiration: exp, dte, strike: 90, type: 'put', bid: 1.4, ask: 1.6, delta: -0.35 }),
  ];
  return { underlying: 'TEST:FOO', underlying_price: SPOT, chain_completeness: 'COMPLETE', contracts };
}
function contractsByTicker(chain) { return new Map(chain.contracts.map(c => [c.contract, c])); }
const MARKET_INPUT_BY_EXP = new Map([['2026-10-16', { discount_rate: 0.04, effective_carry_yield: 0.01, overall_confidence: 'MEDIUM', warnings: ['BORROW_DATA_UNAVAILABLE'] }]]);

describe('CRR shadow scenario pipeline — expiration reconciliation (Step 15)', () => {
  const chain = buildFixtureChain();
  const cByT = contractsByTicker(chain);
  const cfg = { contractMultiplier: 100, currentUnderlyingPrice: SPOT, marketInputByExpiration: MARKET_INPUT_BY_EXP };

  for (const direction of ['bullish', 'bearish']) {
    const candidatesResult = generateStrategyCandidates(chain, { direction, underlying_price: SPOT, horizon_days: 30, max_loss: 1000 });
    for (const strategyType of ['LONG_CALL', 'LONG_PUT', 'BULL_CALL_SPREAD', 'BEAR_PUT_SPREAD']) {
      const candidate = candidatesResult.candidates.find(c => c.strategy_type === strategyType);
      if (!candidate) continue; // not every type appears for every direction with this tiny fixture
      it(`${strategyType} (${direction}) reconciles exactly with expiration P&L at days_forward>=DTE`, () => {
        const expiryScenario = { scenario_id: 'EXPIRY', underlying_price: 130, days_forward: candidate.days_to_expiry, iv_change_points: 0 };
        const local = generateCandidateScenarioResults(candidate, [expiryScenario], cByT, cfg);
        const shadow = generateCandidateScenarioResultsCrrShadow(candidate, [expiryScenario], cByT, cfg);
        assert.equal(shadow.scenario_results[0].scenario_pnl, local.scenario_results[0].scenario_pnl, `${strategyType} shadow expiry P&L should exactly match local-Greek expiry P&L`);
      });
    }
  }
});

describe('CRR shadow scenario pipeline — non-expiry aggregation', () => {
  it('produces an available scenario result with correctly aggregated leg P&L (no double-counted fees)', () => {
    const chain = buildFixtureChain();
    const cByT = contractsByTicker(chain);
    const candidatesResult = generateStrategyCandidates(chain, { direction: 'bullish', underlying_price: SPOT, horizon_days: 30, max_loss: 1000 });
    const candidate = candidatesResult.candidates.find(c => c.strategy_type === 'LONG_CALL');
    const cfg = { contractMultiplier: 100, currentUnderlyingPrice: SPOT, marketInputByExpiration: MARKET_INPUT_BY_EXP };
    const scenario = { scenario_id: 'MOVE', underlying_price: 105, days_forward: 10, iv_change_points: 0 };
    const shadow = generateCandidateScenarioResultsCrrShadow(candidate, [scenario], cByT, cfg);
    const r = shadow.scenario_results[0];
    assert.equal(r.available, true);
    assert.equal(r.scenario_pnl, round2unsafe(r.leg_results.reduce((s, l) => s + l.leg_pnl, 0) - candidate.fees));
  });
});
function round2unsafe(v) { return Math.round(v * 100) / 100; }

describe('Shadow ranking determinism (Step 26-27)', () => {
  it('running the shadow ranking twice on the same inputs produces identical scores (no hidden randomness)', () => {
    const chain = buildFixtureChain();
    const cByT = contractsByTicker(chain);
    const candidatesResult = generateStrategyCandidates(chain, { direction: 'bullish', underlying_price: SPOT, horizon_days: 30, max_loss: 1000 });
    const cfg = { contractMultiplier: 100, currentUnderlyingPrice: SPOT, marketInputByExpiration: MARKET_INPUT_BY_EXP };
    const scenarios = [
      { scenario_id: 'DOWNSIDE', underlying_price: 90, days_forward: 30, iv_change_points: 0 },
      { scenario_id: 'BASE', underlying_price: 105, days_forward: 30, iv_change_points: 0 },
      { scenario_id: 'UPSIDE', underlying_price: 110, days_forward: 30, iv_change_points: 0 },
    ];
    const enrichedShadow = candidatesResult.candidates.map(c => generateCandidateScenarioResultsCrrShadow(c, scenarios, cByT, cfg));
    const rankingContext = { downside_scenario_id: 'DOWNSIDE', base_scenario_id: 'BASE', upside_scenario_id: 'UPSIDE', current_underlying_price: SPOT, chain_completeness: 'COMPLETE', configured_max_spread_pct: 15 };

    const run1 = rankStrategyCandidates(enrichedShadow, rankingContext, cByT, {});
    const run2 = rankStrategyCandidates(enrichedShadow, rankingContext, cByT, {});
    assert.deepEqual(run1.ranked_candidates.map(c => c.score), run2.ranked_candidates.map(c => c.score));
  });
});
