/**
 * Phase 0B — deterministic, network-free tests for candidate-level scenario
 * repricing (src/core/options/strategyScenarios.js). Uses the same fixture
 * style as tests/strategy_candidates.test.js — no live TradingView data.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateStrategyCandidates } from '../src/core/options/strategyCandidates.js';
import {
  generateCandidateScenarioResults, buildThreeScenarioSet, buildScenariosFromThesis, resolveScenarioIv,
} from '../src/core/options/strategyScenarios.js';

const SPOT = 100;

function contract({ expiration, dte, strike, type, bid, ask, iv = 30, delta, gamma = 0.02, theta = -0.1, vega = 0.2, rho = 0.05 }) {
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
    spread_pct: mid > 0 ? Math.round((spread / mid) * 1000) / 10 : null,
    iv_spread: 2,
    quality_flags: [],
  };
}

function buildFixtureChain() {
  const exp = '2026-10-16';
  const dte = 49;
  const contracts = [
    contract({ expiration: exp, dte, strike: 100, type: 'call', bid: 5.0, ask: 5.2, delta: 0.50 }),
    contract({ expiration: exp, dte, strike: 110, type: 'call', bid: 1.4, ask: 1.6, delta: 0.35 }),
    contract({ expiration: exp, dte, strike: 100, type: 'put', bid: 5.0, ask: 5.2, delta: -0.50 }),
    contract({ expiration: exp, dte, strike: 90, type: 'put', bid: 1.4, ask: 1.6, delta: -0.35 }),
  ];
  return { underlying: 'TEST:FOO', underlying_price: SPOT, chain_completeness: 'COMPLETE', contracts };
}

function contractsByTicker(chain) {
  return new Map(chain.contracts.map(c => [c.contract, c]));
}

describe('resolveScenarioIv()', () => {
  it('applies an absolute scenario_iv (decimal) directly', () => {
    assert.equal(resolveScenarioIv(0.30, { scenario_iv: 0.45 }), 0.45);
  });

  it('applies a point shock as +points/100 to the current decimal IV', () => {
    assert.ok(Math.abs(resolveScenarioIv(0.30, { iv_change_points: 10 }) - 0.40) < 1e-9);
    assert.ok(Math.abs(resolveScenarioIv(0.40, { iv_change_points: -10 }) - 0.30) < 1e-9);
  });

  it('holds IV constant when neither is provided', () => {
    assert.equal(resolveScenarioIv(0.30, {}), 0.30);
  });
});

describe('buildThreeScenarioSet()', () => {
  it('produces BEAR/BASE/BULL with the documented default multiples and IV shocks', () => {
    const scenarios = buildThreeScenarioSet(100, { daysForward: 30 });
    const byId = Object.fromEntries(scenarios.map(s => [s.scenario_id, s]));
    assert.equal(byId.BEAR.underlying_price, 90);
    assert.equal(byId.BASE.underlying_price, 100);
    assert.equal(byId.BULL.underlying_price, 110);
    assert.equal(byId.BEAR.iv_change_points, 10);
    assert.equal(byId.BULL.iv_change_points, -10);
    assert.equal(byId.BASE.days_forward, 30);
  });
});

describe('buildScenariosFromThesis()', () => {
  it('BASE lands exactly at expected_price; BEAR halfway opposite; BULL extends move by 50%', () => {
    const scenarios = buildScenariosFromThesis({ current_spot: 100, expected_price: 120, horizon_days: 30 });
    const byId = Object.fromEntries(scenarios.map(s => [s.scenario_id, s]));
    assert.equal(byId.BASE.underlying_price, 120);
    assert.equal(byId.BEAR.underlying_price, 90); // 100 - 0.5*20
    assert.equal(byId.BULL.underlying_price, 130); // 100 + 1.5*20
  });
});

describe('generateCandidateScenarioResults() — NO_TRADE', () => {
  it('is always zero P&L across every scenario', () => {
    const chain = buildFixtureChain();
    const result = generateStrategyCandidates(chain, { direction: 'bullish', underlying_price: SPOT, horizon_days: 30, max_loss: 1000, commission_per_contract: 0 });
    const noTrade = result.candidates.find(c => c.strategy_type === 'NO_TRADE');
    const scenarios = buildThreeScenarioSet(SPOT, { daysForward: 20 });
    const enriched = generateCandidateScenarioResults(noTrade, scenarios, contractsByTicker(chain), { contractMultiplier: 100, currentUnderlyingPrice: SPOT });
    for (const sr of enriched.scenario_results) {
      assert.equal(sr.scenario_pnl, 0);
      assert.equal(sr.scenario_return_on_risk_pct, 0);
    }
  });
});

describe('generateCandidateScenarioResults() — BUY_STOCK', () => {
  it('is linear in spot and independent of IV/time', () => {
    const chain = buildFixtureChain();
    const result = generateStrategyCandidates(chain, { direction: 'bullish', underlying_price: SPOT, horizon_days: 30, max_loss: 1000, commission_per_contract: 0 });
    const stock = result.candidates.find(c => c.strategy_type === 'BUY_STOCK');
    const scenarios = [
      { scenario_id: 'A', underlying_price: 110, days_forward: 10, iv_change_points: 50 }, // huge IV shock, must not matter
      { scenario_id: 'B', underlying_price: 110, days_forward: 40, iv_change_points: -50 }, // huge time/IV shock, must not matter
    ];
    const enriched = generateCandidateScenarioResults(stock, scenarios, contractsByTicker(chain), { contractMultiplier: 100, currentUnderlyingPrice: SPOT });
    const [a, b] = enriched.scenario_results;
    assert.equal(a.scenario_pnl, b.scenario_pnl); // same spot -> same P&L regardless of IV/time
    assert.equal(a.scenario_pnl, stock.legs[0].shares * (110 - stock.breakeven));
  });
});

describe('generateCandidateScenarioResults() — option strategies', () => {
  const chain = buildFixtureChain();
  const contracts = contractsByTicker(chain);
  const result = generateStrategyCandidates(chain, { direction: 'bullish', underlying_price: SPOT, horizon_days: 30, max_loss: 1000, commission_per_contract: 1 });
  const longCall = result.candidates.find(c => c.strategy_type === 'LONG_CALL');
  const spread = result.candidates.find(c => c.strategy_type === 'BULL_CALL_SPREAD');

  it('LONG_CALL scenario P&L at expiry (days_forward == DTE) matches Phase 0A expiration economics exactly', () => {
    const dte = longCall.days_to_expiry;
    const scenario = { scenario_id: 'EXP', underlying_price: 115, days_forward: dte, iv_change_points: 0 };
    const enriched = generateCandidateScenarioResults(longCall, [scenario], contracts, { contractMultiplier: 100, currentUnderlyingPrice: SPOT });
    const sr = enriched.scenario_results[0];
    assert.equal(sr.leg_results[0].pricing_model, 'EXPIRATION_INTRINSIC');
    // Recompute expected via Phase 0A directly for cross-check.
    const expectedPnl = Math.max(115 - longCall.legs[0].strike, 0) * 100 - longCall.entry_debit;
    assert.equal(sr.scenario_pnl, expectedPnl);
  });

  it('BULL_CALL_SPREAD scenario P&L at expiry matches Phase 0A expiration economics exactly (both legs, fees subtracted once)', () => {
    const dte = spread.days_to_expiry;
    const scenario = { scenario_id: 'EXP', underlying_price: 120, days_forward: dte, iv_change_points: 0 };
    const enriched = generateCandidateScenarioResults(spread, [scenario], contracts, { contractMultiplier: 100, currentUnderlyingPrice: SPOT });
    const sr = enriched.scenario_results[0];
    const [longStrike, shortStrike] = spread.legs.map(l => l.strike);
    const width = shortStrike - longStrike;
    const expectedMaxProfit = width * 100 - spread.entry_debit;
    // 120 is above both strikes -> max profit
    assert.equal(sr.scenario_pnl, expectedMaxProfit);
    assert.equal(sr.scenario_pnl, spread.max_profit);
  });

  it('mid-life (pre-expiry) scenario uses LOCAL_GREEK_APPROXIMATION and reports a decomposition', () => {
    const scenario = { scenario_id: 'MID', underlying_price: 105, days_forward: 10, iv_change_points: 5 };
    const enriched = generateCandidateScenarioResults(longCall, [scenario], contracts, { contractMultiplier: 100, currentUnderlyingPrice: SPOT });
    const leg = enriched.scenario_results[0].leg_results[0];
    assert.equal(leg.pricing_model, 'LOCAL_GREEK_APPROXIMATION');
    assert.ok(Number.isFinite(leg.spot_effect));
    assert.ok(Number.isFinite(leg.theta_effect));
    assert.ok(Number.isFinite(leg.vega_effect));
  });

  it('fees are subtracted exactly once for a spread scenario (not per leg)', () => {
    const scenario = { scenario_id: 'MID', underlying_price: 105, days_forward: 10, iv_change_points: 0 };
    const enriched = generateCandidateScenarioResults(spread, [scenario], contracts, { contractMultiplier: 100, currentUnderlyingPrice: SPOT });
    const sr = enriched.scenario_results[0];
    const sumLegPnl = sr.leg_results.reduce((acc, l) => acc + l.leg_pnl, 0);
    // scenario_pnl must equal sumLegPnl - fees (fees applied once), within rounding tolerance
    assert.ok(Math.abs(sr.scenario_pnl - (sumLegPnl - spread.fees)) < 0.02);
  });

  it('return_on_risk_pct = scenario_pnl / max_loss * 100', () => {
    const scenario = { scenario_id: 'MID', underlying_price: 105, days_forward: 10, iv_change_points: 0 };
    const enriched = generateCandidateScenarioResults(longCall, [scenario], contracts, { contractMultiplier: 100, currentUnderlyingPrice: SPOT });
    const sr = enriched.scenario_results[0];
    const expected = Math.round((sr.scenario_pnl / longCall.max_loss) * 100 * 100) / 100;
    assert.equal(sr.scenario_return_on_risk_pct, expected);
  });

  it('reports unavailable (never fabricated) when the source contract is missing from the map', () => {
    const emptyMap = new Map();
    const scenario = { scenario_id: 'MID', underlying_price: 105, days_forward: 10, iv_change_points: 0 };
    const enriched = generateCandidateScenarioResults(longCall, [scenario], emptyMap, { contractMultiplier: 100, currentUnderlyingPrice: SPOT });
    assert.equal(enriched.scenario_results[0].available, false);
  });

  it('same inputs produce byte-identical scenario results (determinism)', () => {
    const scenario = { scenario_id: 'MID', underlying_price: 105, days_forward: 10, iv_change_points: 5 };
    const r1 = generateCandidateScenarioResults(longCall, [scenario], contracts, { contractMultiplier: 100, currentUnderlyingPrice: SPOT });
    const r2 = generateCandidateScenarioResults(longCall, [scenario], contracts, { contractMultiplier: 100, currentUnderlyingPrice: SPOT });
    assert.deepEqual(r1.scenario_results, r2.scenario_results);
  });
});
