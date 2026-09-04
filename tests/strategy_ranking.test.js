/**
 * Phase 0C — deterministic, network-free tests for the ranking engine
 * (src/core/options/strategyRanking.js). Candidates and scenario_results
 * are hand-built here (not re-derived through the full Phase 0A/0B
 * pipeline, which already has its own test suites) so these tests focus
 * purely on ranking behavior in isolation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rankStrategyCandidates } from '../src/core/options/strategyRanking.js';

const CTX = {
  downside_scenario_id: 'DOWN',
  base_scenario_id: 'BASE',
  upside_scenario_id: 'UP',
  current_underlying_price: 100,
  chain_completeness: 'COMPLETE',
  configured_max_spread_pct: 15,
};

function scenarioResult(id, underlyingPrice, pnl, maxLoss, warnings = []) {
  return {
    scenario_id: id,
    underlying_price: underlyingPrice,
    days_forward: 30,
    scenario_iv: null,
    available: true,
    estimated_strategy_value: null,
    scenario_pnl: pnl,
    scenario_return_on_risk_pct: maxLoss > 0 ? Math.round((pnl / maxLoss) * 100 * 100) / 100 : 0,
    pricing_models_used: ['EXPIRATION_INTRINSIC'],
    warnings,
    leg_results: [],
  };
}

/**
 * The Phase 0A "bad spread" shape (risk $465, max profit $35), rescaled to
 * strikes 100/105 so it shares a consistent current_underlying_price=100
 * context with the other fixtures below (the original live NVDA example
 * used strikes 220/225 around a ~$222 underlying — same $465/$35 economics,
 * different absolute strikes).
 */
function badSpreadCandidate() {
  const maxLoss = 465;
  return {
    candidate_id: 'BULL_CALL_SPREAD::BAD::100-105',
    strategy_type: 'BULL_CALL_SPREAD',
    expiration: '2026-10-02',
    days_to_expiry: 30,
    legs: [
      { role: 'long', contract: 'OPRA:BAD261002C100.0', strike: 100, option_type: 'call', fill_price: 8.00 },
      { role: 'short', contract: 'OPRA:BAD261002C105.0', strike: 105, option_type: 'call', fill_price: 3.35 },
    ],
    entry_debit: 465,
    fees: 0,
    capital_required: 465,
    max_loss: maxLoss,
    max_profit: 35,
    max_profit_type: 'DEFINED',
    breakeven: 104.65,
    source_contracts: ['OPRA:BAD261002C100.0', 'OPRA:BAD261002C105.0'],
    scenario_results: [
      scenarioResult('DOWN', 90, -465, maxLoss), // both legs OTM -> max loss
      scenarioResult('BASE', 104, -65, maxLoss), // below breakeven -> slightly negative
      scenarioResult('UP', 110, 35, maxLoss), // above short strike -> max profit
    ],
  };
}

/** A clearly superior spread: risk $300, max profit $700 (Phase 0A textbook fixture). */
function superiorSpreadCandidate() {
  const maxLoss = 300;
  return {
    candidate_id: 'BULL_CALL_SPREAD::GOOD::100-110',
    strategy_type: 'BULL_CALL_SPREAD',
    expiration: '2026-10-02',
    days_to_expiry: 30,
    legs: [
      { role: 'long', contract: 'OPRA:GOOD261002C100.0', strike: 100, option_type: 'call', fill_price: 5.00 },
      { role: 'short', contract: 'OPRA:GOOD261002C110.0', strike: 110, option_type: 'call', fill_price: 2.00 },
    ],
    entry_debit: 300,
    fees: 0,
    capital_required: 300,
    max_loss: maxLoss,
    max_profit: 700,
    max_profit_type: 'DEFINED',
    breakeven: 103,
    source_contracts: ['OPRA:GOOD261002C100.0', 'OPRA:GOOD261002C110.0'],
    scenario_results: [
      scenarioResult('DOWN', 90, -300, maxLoss),
      scenarioResult('BASE', 103, 0, maxLoss),
      scenarioResult('UP', 110, 700, maxLoss),
    ],
  };
}

function longCallCandidate({ score_bias = 'good' } = {}) {
  const maxLoss = 500;
  // "good": a real bullish thesis where the BASE (target) scenario is
  // already strongly profitable, not just breakeven — this is what lets a
  // strategy score well under RANKING_MODEL_V1 despite an all-or-nothing
  // downside (a debit long option always has 100% loss if OTM at expiry,
  // regardless of how far OTM — the model rewards the case where the base
  // thesis alone already justifies the risk).
  const scenarios = score_bias === 'good'
    ? [scenarioResult('DOWN', 90, -500, maxLoss), scenarioResult('BASE', 115, 1000, maxLoss), scenarioResult('UP', 130, 2500, maxLoss)]
    : [scenarioResult('DOWN', 90, -500, maxLoss), scenarioResult('BASE', 100, -500, maxLoss), scenarioResult('UP', 105, -100, maxLoss)];
  return {
    candidate_id: 'LONG_CALL::TEST::100',
    strategy_type: 'LONG_CALL',
    expiration: '2026-10-02',
    days_to_expiry: 30,
    legs: [{ role: 'long', contract: 'OPRA:TEST261002C100.0', strike: 100, option_type: 'call', fill_price: 5.00 }],
    entry_debit: 500,
    fees: 0,
    capital_required: 500,
    max_loss: maxLoss,
    max_profit: null,
    max_profit_type: 'UNLIMITED',
    breakeven: 105,
    source_contracts: ['OPRA:TEST261002C100.0'],
    scenario_results: scenarios,
  };
}

function buyStockCandidate() {
  const maxLoss = 1000;
  return {
    candidate_id: 'BUY_STOCK::TEST',
    strategy_type: 'BUY_STOCK',
    baseline_type: 'UNDERLYING',
    expiration: null,
    days_to_expiry: null,
    legs: [{ role: 'long', contract: null, shares: 10 }],
    entry_debit: 1000,
    fees: 0,
    capital_required: 1000,
    max_loss: maxLoss,
    max_profit: null,
    max_profit_type: 'UNLIMITED',
    breakeven: 100,
    source_contracts: [],
    scenario_results: [
      scenarioResult('DOWN', 90, -100, maxLoss),
      scenarioResult('BASE', 100, 0, maxLoss),
      scenarioResult('UP', 110, 100, maxLoss),
    ],
  };
}

function noTradeCandidate() {
  return {
    candidate_id: 'NO_TRADE::TEST',
    strategy_type: 'NO_TRADE',
    baseline_type: 'NONE',
    expiration: null,
    days_to_expiry: null,
    legs: [],
    entry_debit: 0,
    fees: 0,
    capital_required: 0,
    max_loss: 0,
    max_profit: 0,
    max_profit_type: 'DEFINED',
    breakeven: null,
    source_contracts: [],
    scenario_results: [
      scenarioResult('DOWN', 90, 0, 0),
      scenarioResult('BASE', 100, 0, 0),
      scenarioResult('UP', 110, 0, 0),
    ],
  };
}

function contractsMapWithSpreads(spreadPctByTicker) {
  const map = new Map();
  for (const [ticker, pct] of Object.entries(spreadPctByTicker)) {
    map.set(ticker, { spread_pct: pct });
  }
  return map;
}

describe('rankStrategyCandidates() — input validation', () => {
  it('throws when a required scenario role id is missing', () => {
    assert.throws(() => rankStrategyCandidates([noTradeCandidate()], { ...CTX, downside_scenario_id: undefined }, new Map()), /downside_scenario_id/);
  });
});

describe('rankStrategyCandidates() — the bad spread (Step 17)', () => {
  const contractsByTicker = contractsMapWithSpreads({
    'OPRA:BAD261002C100.0': 5, 'OPRA:BAD261002C105.0': 5,
    'OPRA:GOOD261002C100.0': 2, 'OPRA:GOOD261002C110.0': 2,
  });

  it('scores the bad spread appropriately poorly and never ranks it first among a superior spread', () => {
    const result = rankStrategyCandidates([badSpreadCandidate(), superiorSpreadCandidate()], CTX, contractsByTicker);
    const bad = result.ranked_candidates.find(c => c.candidate_id.includes('BAD'));
    const good = result.ranked_candidates.find(c => c.candidate_id.includes('GOOD'));
    assert.ok(bad.score < good.score, `bad spread score ${bad.score} should be lower than good spread score ${good.score}`);
    assert.notEqual(result.ranked_candidates[0].candidate_id, bad.candidate_id, 'bad spread must not rank first');
  });

  it('applies the optional min_capped_reward_risk gate and rejects the bad spread with CAPPED_REWARD_RISK_BELOW_MINIMUM', () => {
    // 35/465 ~= 0.075, below a 0.25 minimum.
    const result = rankStrategyCandidates([badSpreadCandidate(), superiorSpreadCandidate()], CTX, contractsByTicker, { min_capped_reward_risk: 0.25 });
    assert.ok(result.gate_rejections.some(g => g.candidate_id.includes('BAD') && g.reason === 'CAPPED_REWARD_RISK_BELOW_MINIMUM'));
    assert.ok(!result.ranked_candidates.some(c => c.candidate_id.includes('BAD')));
    // The good spread (700/300 ~= 2.33) must survive the same gate.
    assert.ok(result.ranked_candidates.some(c => c.candidate_id.includes('GOOD')));
  });

  it('the gate is disabled by default (bad spread appears in ranked_candidates, just scored low)', () => {
    const result = rankStrategyCandidates([badSpreadCandidate()], CTX, contractsByTicker);
    assert.ok(result.ranked_candidates.some(c => c.candidate_id.includes('BAD')));
    assert.equal(result.gate_rejections.length, 0);
  });
});

describe('rankStrategyCandidates() — cross-strategy comparison (Step 18)', () => {
  const contractsByTicker = contractsMapWithSpreads({
    'OPRA:TEST261002C100.0': 3,
    'OPRA:GOOD261002C100.0': 2, 'OPRA:GOOD261002C110.0': 2,
  });

  it('ranks LONG_CALL, BULL_CALL_SPREAD, BUY_STOCK, and NO_TRADE together without forcing options to win', () => {
    const candidates = [longCallCandidate({ score_bias: 'good' }), superiorSpreadCandidate(), buyStockCandidate(), noTradeCandidate()];
    const result = rankStrategyCandidates(candidates, CTX, contractsByTicker);

    assert.equal(result.baselines.length, 1);
    assert.equal(result.baselines[0].strategy_type, 'NO_TRADE');
    assert.equal(result.baselines[0].score, null);

    const stockEntry = result.ranked_candidates.find(c => c.strategy_type === 'BUY_STOCK');
    assert.ok(stockEntry, 'BUY_STOCK must participate in ranked_candidates, not just baselines');
    assert.equal(stockEntry.ranking_class, 'UNDERLYING_BASELINE');

    // Not asserting a specific winner — only that all three trade types are scored and comparable.
    const types = new Set(result.ranked_candidates.map(c => c.strategy_type));
    assert.ok(types.has('LONG_CALL') && types.has('BULL_CALL_SPREAD') && types.has('BUY_STOCK'));
  });
});

describe('rankStrategyCandidates() — confidence tests (Step 19)', () => {
  const contractsByTicker = contractsMapWithSpreads({ 'OPRA:TEST261002C100.0': 3 });

  it('A) high score with LOW confidence keeps the score unchanged', () => {
    const c = longCallCandidate({ score_bias: 'good' });
    c.scenario_results = c.scenario_results.map(sr => ({ ...sr, warnings: ['NEAR_EXPIRATION'] }));
    const result = rankStrategyCandidates([c], CTX, contractsByTicker);
    const entry = result.ranked_candidates[0];
    assert.equal(entry.confidence, 'LOW');
    // Score must be computed purely from economics, unaffected by confidence.
    const cleanResult = rankStrategyCandidates([longCallCandidate({ score_bias: 'good' })], CTX, contractsByTicker);
    assert.equal(entry.score, cleanResult.ranked_candidates[0].score);
    assert.ok(entry.score >= 60, 'fixture must genuinely score well for this test to be meaningful');
  });

  it('B) good score + HIGH confidence is consideration eligible', () => {
    const result = rankStrategyCandidates([longCallCandidate({ score_bias: 'good' })], CTX, contractsByTicker);
    const entry = result.ranked_candidates[0];
    assert.equal(entry.confidence, 'HIGH');
    assert.ok(entry.score >= 60);
    assert.equal(entry.consideration_eligible, true);
  });

  it('C) good score + LOW confidence is NOT eligible when minimum confidence is MEDIUM', () => {
    const c = longCallCandidate({ score_bias: 'good' });
    c.scenario_results = c.scenario_results.map(sr => ({ ...sr, warnings: ['LARGE_TIME_STEP'] }));
    const result = rankStrategyCandidates([c], CTX, contractsByTicker, { minimum_confidence_for_consideration: 'MEDIUM' });
    const entry = result.ranked_candidates[0];
    assert.equal(entry.confidence, 'LOW');
    assert.ok(entry.score >= 60, 'fixture must genuinely score well for this test to be meaningful');
    assert.equal(entry.consideration_eligible, false);
    assert.ok(entry.consideration_reasons.includes('CONFIDENCE_BELOW_THRESHOLD'));
  });

  it('D) CHAIN_POSSIBLY_TRUNCATED lowers universe confidence to MEDIUM without changing score', () => {
    const truncatedCtx = { ...CTX, chain_completeness: 'POSSIBLY_TRUNCATED' };
    const normal = rankStrategyCandidates([longCallCandidate({ score_bias: 'good' })], CTX, contractsByTicker).ranked_candidates[0];
    const truncated = rankStrategyCandidates([longCallCandidate({ score_bias: 'good' })], truncatedCtx, contractsByTicker).ranked_candidates[0];
    assert.equal(truncated.confidence_components.universe_confidence, 'MEDIUM');
    assert.equal(truncated.confidence, 'MEDIUM'); // min(HIGH, HIGH, MEDIUM)
    assert.equal(truncated.score, normal.score);
  });
});

describe('rankStrategyCandidates() — determinism (Step 20)', () => {
  it('same candidates + context + config produce byte-identical scores/grades/confidence/ranks/decision_state', () => {
    const contractsByTicker = contractsMapWithSpreads({
      'OPRA:BAD261002C100.0': 5, 'OPRA:BAD261002C105.0': 5,
      'OPRA:GOOD261002C100.0': 2, 'OPRA:GOOD261002C110.0': 2,
      'OPRA:TEST261002C100.0': 3,
    });
    const build = () => rankStrategyCandidates(
      [badSpreadCandidate(), superiorSpreadCandidate(), longCallCandidate(), buyStockCandidate(), noTradeCandidate()],
      CTX, contractsByTicker,
    );
    const r1 = build();
    const r2 = build();
    assert.deepEqual(r1.ranked_candidates.map(c => [c.candidate_id, c.score, c.grade, c.confidence, c.rank]),
      r2.ranked_candidates.map(c => [c.candidate_id, c.score, c.grade, c.confidence, c.rank]));
    assert.equal(r1.decision_state, r2.decision_state);
  });
});

describe('rankStrategyCandidates() — NO_TRADE baseline and decision_state', () => {
  const contractsByTicker = new Map();

  it('decision_state is NO_TRADE_BASELINE_ONLY when nothing is consideration_eligible', () => {
    const c = superiorSpreadCandidate();
    c.max_profit = 1; // gut the economics so it scores far below threshold
    c.scenario_results = c.scenario_results.map(sr => ({ ...sr, scenario_pnl: sr.scenario_id === 'UP' ? 1 : sr.scenario_pnl }));
    const result = rankStrategyCandidates([c, noTradeCandidate()], CTX, contractsByTicker, { minimum_score_for_consideration: 99.9 });
    assert.equal(result.decision_state, 'NO_TRADE_BASELINE_ONLY');
    assert.equal(result.top_trade_candidate_id, null);
    assert.equal(result.fallback_baseline, 'NO_TRADE');
  });

  it('decision_state is TRADE_CANDIDATES_AVAILABLE when at least one candidate qualifies', () => {
    const contractsMap = contractsMapWithSpreads({ 'OPRA:TEST261002C100.0': 3 });
    const result = rankStrategyCandidates([longCallCandidate({ score_bias: 'good' }), noTradeCandidate()], CTX, contractsMap);
    assert.equal(result.decision_state, 'TRADE_CANDIDATES_AVAILABLE');
    assert.ok(result.top_trade_candidate_id);
  });
});

describe('rankStrategyCandidates() — output shape sanity', () => {
  it('exposes ranking_model, score_disclaimer, weights, and per-candidate raw_metrics/component_scores', () => {
    const contractsByTicker = contractsMapWithSpreads({ 'OPRA:GOOD261002C100.0': 2, 'OPRA:GOOD261002C110.0': 2 });
    const result = rankStrategyCandidates([superiorSpreadCandidate()], CTX, contractsByTicker);
    assert.equal(result.ranking_model, 'RANKING_MODEL_V1');
    assert.match(result.score_disclaimer, /not probability or expected return/);
    const entry = result.ranked_candidates[0];
    assert.ok(entry.raw_metrics);
    assert.ok(entry.component_scores);
    assert.deepEqual(entry.component_weights, { base: 0.35, downside: 0.25, upside: 0.20, breakeven: 0.15, execution: 0.05 });
  });
});
