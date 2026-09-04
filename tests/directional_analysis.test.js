/**
 * Phase 1A — deterministic, network-free tests for the directional analysis
 * orchestrator (src/core/options/directionalAnalysis.js). Uses injected
 * mock dependencies (getOptionChain/getKeyStats) so no live TradingView
 * session is required. Live orchestration is exercised separately as a
 * manual smoke test against NASDAQ:NVDA.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDirectional } from '../src/core/options/directionalAnalysis.js';

function contract({ expiration, dte, strike, type, bid, ask, iv = 30, delta, gamma = 0.02, theta = -0.1, vega = 0.2, rho = 0.05 }) {
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  return {
    contract: `OPRA:TEST${expiration.replace(/-/g, '').slice(2)}${type === 'call' ? 'C' : 'P'}${strike.toFixed(1)}`,
    root: 'TEST', expiration, days_to_expiry: dte, strike, option_type: type, currency: 'USD',
    bid, ask, theoretical_price: mid, iv, bid_iv: iv - 1, ask_iv: iv + 1,
    delta, gamma, theta, vega, rho, mid, spread,
    spread_pct: mid > 0 ? Math.round((spread / mid) * 1000) / 10 : null,
    iv_spread: 2, quality_flags: [],
  };
}

function buildFixtureContracts({ dte = 45, expiration = '2026-10-16' } = {}) {
  return [
    contract({ expiration, dte, strike: 95, type: 'call', bid: 8.4, ask: 8.6, delta: 0.60 }),
    contract({ expiration, dte, strike: 100, type: 'call', bid: 5.0, ask: 5.2, delta: 0.50 }),
    contract({ expiration, dte, strike: 105, type: 'call', bid: 2.9, ask: 3.1, delta: 0.35 }),
    contract({ expiration, dte, strike: 110, type: 'call', bid: 1.4, ask: 1.6, delta: 0.25 }),
    contract({ expiration, dte, strike: 105, type: 'put', bid: 8.4, ask: 8.6, delta: -0.60 }),
    contract({ expiration, dte, strike: 100, type: 'put', bid: 5.0, ask: 5.2, delta: -0.50 }),
    contract({ expiration, dte, strike: 95, type: 'put', bid: 2.9, ask: 3.1, delta: -0.35 }),
    contract({ expiration, dte, strike: 90, type: 'put', bid: 1.4, ask: 1.6, delta: -0.25 }),
  ];
}

function mockDeps({ price = 100, chainCompleteness = 'COMPLETE', chainWarnings = [], contracts, dividendYieldPct = null } = {}) {
  return {
    getKeyStats: async () => (dividendYieldPct == null ? { price } : { price, dividend_yield_pct: dividendYieldPct }),
    getOptionChain: async () => ({
      symbol: 'TEST:FOO', source: 'TradingView Options Scanner', source_endpoint: '/options/scan2',
      retrieved_at_utc: '2026-01-01T00:00:00Z', chain_completeness: chainCompleteness, warnings: chainWarnings,
      contracts: contracts ?? buildFixtureContracts(),
    }),
  };
}

const BULLISH_BASE = { symbol: 'TEST:FOO', direction: 'bullish', horizon_days: 30, max_loss: 1000, base_target_price: 115 };
const BEARISH_BASE = { symbol: 'TEST:FOO', direction: 'bearish', horizon_days: 30, max_loss: 1000, base_target_price: 85 };

describe('A) bullish with explicit scenarios', () => {
  it('uses the exact user-supplied downside/upside targets and IV shocks', async () => {
    const result = await analyzeDirectional({
      ...BULLISH_BASE, downside_target_price: 90, upside_target_price: 125,
      downside_iv_change_points: 8, base_iv_change_points: 2, upside_iv_change_points: -5,
    }, mockDeps());
    assert.equal(result.scenario_definitions.downside.underlying_price, 90);
    assert.equal(result.scenario_definitions.downside.scenario_source, 'USER_EXPLICIT');
    assert.equal(result.scenario_definitions.upside.underlying_price, 125);
    assert.equal(result.scenario_definitions.upside.scenario_source, 'USER_EXPLICIT');
    assert.equal(result.scenario_definitions.downside.iv_change_points, 8);
    assert.ok(!result.data_source.warnings.includes('IV_SCENARIO_NOT_SPECIFIED'));
  });
});

describe('B) bearish with explicit scenarios', () => {
  it('uses the exact user-supplied downside/upside targets for a bearish thesis', async () => {
    const result = await analyzeDirectional({
      ...BEARISH_BASE, downside_target_price: 105, upside_target_price: 75,
    }, mockDeps());
    assert.equal(result.direction, 'bearish');
    assert.equal(result.scenario_definitions.downside.underlying_price, 105);
    assert.equal(result.scenario_definitions.upside.underlying_price, 75);
    const types = new Set(result.top_candidates.map(c => c.strategy_type));
    for (const t of types) assert.ok(['LONG_PUT', 'BEAR_PUT_SPREAD', 'NO_TRADE'].includes(t));
  });
});

describe('C) bullish helper-derived scenarios', () => {
  it('derives downside/upside from current spot and base target using the documented formula', async () => {
    // spot=100, base=115 -> expected_move=15, abs=15
    // downside = 100 - 0.5*15 = 92.5; upside = 115 + 0.5*15 = 122.5
    const result = await analyzeDirectional(BULLISH_BASE, mockDeps());
    assert.equal(result.scenario_definitions.downside.underlying_price, 92.5);
    assert.equal(result.scenario_definitions.downside.scenario_source, 'DETERMINISTIC_HELPER');
    assert.equal(result.scenario_definitions.upside.underlying_price, 122.5);
    assert.equal(result.scenario_definitions.upside.scenario_source, 'DETERMINISTIC_HELPER');
    assert.ok(result.data_source.warnings.includes('IV_SCENARIO_NOT_SPECIFIED'));
    for (const s of ['downside', 'base', 'upside']) assert.equal(result.scenario_definitions[s].iv_change_points, 0);
  });
});

describe('D) target direction mismatch', () => {
  it('rejects a bullish thesis with a target below current spot', async () => {
    await assert.rejects(
      () => analyzeDirectional({ ...BULLISH_BASE, base_target_price: 90 }, mockDeps({ price: 100 })),
      /TARGET_DIRECTION_MISMATCH/,
    );
  });

  it('rejects a bearish thesis with a target above current spot', async () => {
    await assert.rejects(
      () => analyzeDirectional({ ...BEARISH_BASE, base_target_price: 110 }, mockDeps({ price: 100 })),
      /TARGET_DIRECTION_MISMATCH/,
    );
  });
});

describe('E) missing base target', () => {
  it('rejects when base_target_price is absent', async () => {
    const { base_target_price, ...rest } = BULLISH_BASE;
    await assert.rejects(() => analyzeDirectional(rest, mockDeps()), /base_target_price/);
  });

  it('rejects other missing required fields with clear errors', async () => {
    await assert.rejects(() => analyzeDirectional({ ...BULLISH_BASE, symbol: '' }, mockDeps()), /Invalid symbol/);
    await assert.rejects(() => analyzeDirectional({ ...BULLISH_BASE, direction: 'sideways' }, mockDeps()), /Invalid direction/);
    await assert.rejects(() => analyzeDirectional({ ...BULLISH_BASE, horizon_days: -1 }, mockDeps()), /Invalid horizon_days/);
    await assert.rejects(() => analyzeDirectional({ ...BULLISH_BASE, max_loss: 0 }, mockDeps()), /Invalid max_loss/);
  });
});

describe('F) NO_TRADE_BASELINE_ONLY', () => {
  it('reports null top_trade_candidate_id and up to 5 near_miss_candidates with exact reasons', async () => {
    const result = await analyzeDirectional({
      ...BULLISH_BASE, minimum_score_for_consideration: 99.99, // impossible to hit -> nothing qualifies
    }, mockDeps());
    assert.equal(result.ranking.decision_state, 'NO_TRADE_BASELINE_ONLY');
    assert.equal(result.ranking.top_trade_candidate_id, null);
    assert.ok(result.near_miss_candidates.length > 0);
    assert.ok(result.near_miss_candidates.length <= 5);
    for (const nm of result.near_miss_candidates) {
      assert.equal(nm.consideration_eligible, false);
      assert.ok(nm.consideration_reasons.length > 0);
    }
    // NO_TRADE baseline must still be present.
    assert.ok(result.baselines.some(b => b.strategy_type === 'NO_TRADE'));
  });
});

describe('G) trade candidates available', () => {
  it('reports TRADE_CANDIDATES_AVAILABLE with a non-null top_trade_candidate_id when something qualifies', async () => {
    const result = await analyzeDirectional(BULLISH_BASE, mockDeps());
    assert.equal(result.ranking.decision_state, 'TRADE_CANDIDATES_AVAILABLE');
    assert.ok(result.ranking.top_trade_candidate_id);
    assert.equal(result.near_miss_candidates.length, 0); // only populated for NO_TRADE_BASELINE_ONLY
  });
});

describe('H) LOW-confidence high-score candidate remains ineligible', () => {
  it('a candidate whose scenarios carry LARGE_TIME_STEP/NEAR_EXPIRATION never becomes eligible under default thresholds', async () => {
    // horizon_days=30 against 45 DTE contracts triggers LARGE_TIME_STEP in Phase 0B
    // (30 > min(30, 0.5*45)=22.5), which forces LOW scenario_model_confidence,
    // which forces overall confidence LOW, which fails the default MEDIUM threshold
    // regardless of how attractive the score looks.
    const result = await analyzeDirectional(BULLISH_BASE, mockDeps());
    const lowConfEligible = result.top_candidates.filter(c => c.confidence === 'LOW' && c.consideration_eligible);
    assert.equal(lowConfEligible.length, 0, 'no LOW-confidence candidate should ever be consideration_eligible under the default MEDIUM threshold');
  });
});

describe('I) chain truncated warning preserved', () => {
  it('propagates CHAIN_POSSIBLY_TRUNCATED into data_source.warnings and lowers universe confidence', async () => {
    const result = await analyzeDirectional(BULLISH_BASE, mockDeps({ chainCompleteness: 'POSSIBLY_TRUNCATED', chainWarnings: ['CHAIN_POSSIBLY_TRUNCATED'] }));
    assert.equal(result.data_source.chain_completeness, 'POSSIBLY_TRUNCATED');
    assert.ok(result.data_source.warnings.includes('CHAIN_POSSIBLY_TRUNCATED'));
    for (const c of result.top_candidates) {
      if (c.strategy_type === 'NO_TRADE') continue;
      // Confidence can never exceed MEDIUM when the universe is possibly truncated.
      assert.notEqual(c.confidence, 'HIGH');
    }
  });
});

describe('J) determinism', () => {
  it('same snapshot + same input produces identical candidate IDs and ranking order across repeated runs', async () => {
    const deps = mockDeps();
    const r1 = await analyzeDirectional(BULLISH_BASE, deps);
    const r2 = await analyzeDirectional(BULLISH_BASE, deps);
    assert.deepEqual(r1.top_candidates.map(c => c.candidate_id), r2.top_candidates.map(c => c.candidate_id));
    assert.equal(r1.analysis_snapshot_id, r2.analysis_snapshot_id);
    assert.equal(r1.ranking.decision_state, r2.ranking.decision_state);
  });

  it('a different base_target_price changes the snapshot id', async () => {
    const deps = mockDeps();
    const r1 = await analyzeDirectional(BULLISH_BASE, deps);
    const r2 = await analyzeDirectional({ ...BULLISH_BASE, base_target_price: 120 }, deps);
    assert.notEqual(r1.analysis_snapshot_id, r2.analysis_snapshot_id);
  });

  it('analysis_snapshot_id is a string identifier, not a JS number', async () => {
    const result = await analyzeDirectional(BULLISH_BASE, mockDeps());
    assert.equal(typeof result.analysis_snapshot_id, 'string');
    assert.equal(JSON.parse(JSON.stringify(result)).analysis_snapshot_id, result.analysis_snapshot_id);
  });
});

describe('output shape / AI safety contract', () => {
  it('keeps CRR hybrid diagnostics guarded and not requested by default', async () => {
    const result = await analyzeDirectional(BULLISH_BASE, mockDeps());
    assert.equal(result.diagnostics.crr_hybrid_policy.status, 'NOT_REQUESTED');
    assert.equal(result.diagnostics.crr_hybrid_policy.mode, 'DIAGNOSTIC_ONLY_NO_RANKING_CHANGE');
  });

  it('reports CRR hybrid diagnostics unavailable when the provider hook is explicitly disabled', async () => {
    // Phase 2D.3 wires a real default provider (see below), so "no provider
    // configured" must now be forced explicitly to exercise this path —
    // `false` is not nullish, so it survives the `??` default and still
    // fails the typeof-function check.
    const result = await analyzeDirectional({ ...BULLISH_BASE, include_crr_hybrid_diagnostics: true }, {
      ...mockDeps(),
      buildCrrShadowMarketInputs: false,
    });
    assert.equal(result.diagnostics.crr_hybrid_policy.status, 'UNAVAILABLE');
    assert.equal(result.diagnostics.crr_hybrid_policy.reason, 'CRR_SHADOW_MARKET_INPUT_PROVIDER_NOT_CONFIGURED');
  });

  describe('Phase 2D.3 — default non-IBKR CRR diagnostic market-input provider', () => {
    it('returns AVAILABLE by default (no deps override) with PARTIAL_EXTERNAL_INPUTS and borrow unavailable', async () => {
      const result = await analyzeDirectional({ ...BULLISH_BASE, include_crr_hybrid_diagnostics: true }, mockDeps({ dividendYieldPct: 0.5 }));
      const diag = result.diagnostics.crr_hybrid_policy;
      assert.equal(diag.status, 'AVAILABLE');
      assert.ok(diag.market_inputs.length > 0);
      for (const mi of diag.market_inputs) {
        assert.equal(mi.mode, 'PARTIAL_EXTERNAL_INPUTS');
        assert.equal(mi.borrow_source, 'NOT_CONNECTED');
        assert.ok(mi.warnings.includes('BORROW_DATA_UNAVAILABLE'));
        assert.notEqual(mi.mode, 'FULL_EXTERNAL_INPUTS');
      }
    });

    it('treats an exact 0% TradingView dividend yield as ZERO_DIVIDEND_CONFIRMED (documented zero, e.g. PANW)', async () => {
      const result = await analyzeDirectional({ ...BULLISH_BASE, include_crr_hybrid_diagnostics: true }, mockDeps({ dividendYieldPct: 0 }));
      const diag = result.diagnostics.crr_hybrid_policy;
      assert.equal(diag.status, 'AVAILABLE');
      for (const mi of diag.market_inputs) assert.equal(mi.dividend_mode, 'ZERO_DIVIDEND_CONFIRMED');
    });

    it('uses TRAILING_DIVIDEND_YIELD_APPROXIMATION for a positive TradingView yield', async () => {
      const result = await analyzeDirectional({ ...BULLISH_BASE, include_crr_hybrid_diagnostics: true }, mockDeps({ dividendYieldPct: 0.33 }));
      const diag = result.diagnostics.crr_hybrid_policy;
      for (const mi of diag.market_inputs) assert.equal(mi.dividend_mode, 'TRAILING_DIVIDEND_YIELD_APPROXIMATION');
    });

    it('fails safely (no fabricated data) when dividend data is unavailable, without crashing the analysis', async () => {
      // mockDeps() default omits dividend_yield_pct entirely.
      const result = await analyzeDirectional({ ...BULLISH_BASE, include_crr_hybrid_diagnostics: true }, mockDeps());
      const diag = result.diagnostics.crr_hybrid_policy;
      assert.equal(diag.status, 'AVAILABLE'); // the provider itself still runs and returns structured records
      for (const mi of diag.market_inputs) {
        assert.equal(mi.mode, 'MARKET_INPUT_UNAVAILABLE');
        assert.equal(mi.dividend_mode, 'DIVIDEND_DATA_UNAVAILABLE');
      }
    });

    it('does not change ranking order, top candidate, decision state, score, or confidence when the default diagnostics are enabled', async () => {
      const base = await analyzeDirectional(BULLISH_BASE, mockDeps({ dividendYieldPct: 0.5 }));
      const withDiagnostics = await analyzeDirectional({ ...BULLISH_BASE, include_crr_hybrid_diagnostics: true }, mockDeps({ dividendYieldPct: 0.5 }));

      assert.deepEqual(withDiagnostics.top_candidates.map(c => c.candidate_id), base.top_candidates.map(c => c.candidate_id));
      assert.equal(withDiagnostics.ranking.top_trade_candidate_id, base.ranking.top_trade_candidate_id);
      assert.equal(withDiagnostics.ranking.decision_state, base.ranking.decision_state);
      assert.deepEqual(withDiagnostics.top_candidates.map(c => c.score), base.top_candidates.map(c => c.score));
      assert.deepEqual(withDiagnostics.top_candidates.map(c => c.confidence), base.top_candidates.map(c => c.confidence));
      assert.deepEqual(withDiagnostics.top_candidates.map(c => c.consideration_eligible), base.top_candidates.map(c => c.consideration_eligible));
      assert.equal(withDiagnostics.diagnostics.crr_hybrid_policy.status, 'AVAILABLE');
    });
  });

  it('adds CRR hybrid diagnostics without changing ranking semantics when a provider is injected', async () => {
    const base = await analyzeDirectional(BULLISH_BASE, mockDeps());
    const withDiagnostics = await analyzeDirectional({ ...BULLISH_BASE, include_crr_hybrid_diagnostics: true }, {
      ...mockDeps(),
      buildCrrShadowMarketInputs: async ({ expirations }) => new Map(expirations.map(({ expiration, dte }) => [expiration, {
        expiration,
        days_to_expiry: dte,
        discount_rate: 0.04,
        discount_rate_source: 'TEST_TREASURY',
        discount_rate_as_of_utc: '2026-01-01',
        dividend_input: { mode: 'ZERO_DIVIDEND_CONFIRMED', annualized_yield: 0, warnings: [] },
        borrow_input: { fee_rate: null, source: 'NOT_CONNECTED', warnings: ['BORROW_DATA_UNAVAILABLE'] },
        effective_carry_yield: 0,
        mode: 'PARTIAL_EXTERNAL_INPUTS',
        overall_confidence: 'MEDIUM',
        warnings: ['BORROW_DATA_UNAVAILABLE'],
      }])),
    });

    assert.deepEqual(withDiagnostics.top_candidates.map(c => c.candidate_id), base.top_candidates.map(c => c.candidate_id));
    assert.equal(withDiagnostics.ranking.top_trade_candidate_id, base.ranking.top_trade_candidate_id);
    assert.equal(withDiagnostics.ranking.decision_state, base.ranking.decision_state);
    assert.equal(withDiagnostics.diagnostics.crr_hybrid_policy.status, 'AVAILABLE');
    assert.ok(withDiagnostics.diagnostics.crr_hybrid_policy.summary.total_candidates > 0);
    assert.ok(withDiagnostics.diagnostics.crr_hybrid_policy.candidates.length > 0);
  });

  it('includes an ai_contract with rules and only allowed candidate ids', async () => {
    const result = await analyzeDirectional(BULLISH_BASE, mockDeps());
    assert.ok(Array.isArray(result.ai_contract.rules) && result.ai_contract.rules.length > 0);
    assert.equal(result.ai_contract.numeric_source_of_truth, 'THIS_ANALYSIS_PACKET');
    const allowedIds = new Set(result.ai_contract.allowed_candidate_ids);
    for (const c of result.top_candidates) assert.ok(allowedIds.has(c.candidate_id));
  });

  it('includes field_provenance covering MARKET_NATIVE/ENGINE_CALCULATED/USER_INPUT/DETERMINISTIC_ASSUMPTION', async () => {
    const result = await analyzeDirectional(BULLISH_BASE, mockDeps());
    assert.ok(result.field_provenance.MARKET_NATIVE.includes('bid'));
    assert.ok(result.field_provenance.ENGINE_CALCULATED.includes('max_loss'));
    assert.ok(result.field_provenance.USER_INPUT.includes('base_target_price'));
    assert.ok(result.field_provenance.DETERMINISTIC_ASSUMPTION.some(f => f.includes('downside_target_price')));
  });

  it('echoes exact normalized inputs', async () => {
    const result = await analyzeDirectional(BULLISH_BASE, mockDeps());
    assert.equal(result.input_echo.base_target_price, 115);
    assert.equal(result.input_echo.symbol, 'TEST:FOO');
    assert.equal(result.input_echo.direction, 'bullish');
  });

  it('respects max_ranked_results and its hard maximum', async () => {
    const result = await analyzeDirectional({ ...BULLISH_BASE, max_ranked_results: 2 }, mockDeps());
    assert.ok(result.top_candidates.length <= 2);
    await assert.rejects(() => analyzeDirectional({ ...BULLISH_BASE, max_ranked_results: 100 }, mockDeps()), /exceeds the hard maximum/);
  });

  it('every top candidate leg carries bid/ask/greeks needed to explain without recalculation', async () => {
    const result = await analyzeDirectional(BULLISH_BASE, mockDeps());
    const optionCandidate = result.top_candidates.find(c => c.legs.some(l => l.contract));
    if (optionCandidate) {
      for (const leg of optionCandidate.legs) {
        if (!leg.contract) continue;
        assert.ok(leg.bid != null && leg.ask != null && leg.delta != null);
      }
    }
  });
});

describe('Phase 2E.1 — CRR hybrid diagnostic contract stabilization', () => {
  // Freezes the public shape of diagnostics.crr_hybrid_policy documented in
  // docs/crr-hybrid-diagnostic-contract.md. These tests assert field
  // presence/type, not behavioral policy (that is hybrid_crr_policy.test.js's
  // job) — a shape regression here should fail even if the underlying policy
  // logic is otherwise untouched.

  it('NOT_REQUESTED shape: exactly status + mode, nothing else', async () => {
    const result = await analyzeDirectional(BULLISH_BASE, mockDeps());
    const diag = result.diagnostics.crr_hybrid_policy;
    assert.deepEqual(Object.keys(diag).sort(), ['mode', 'status']);
    assert.equal(diag.status, 'NOT_REQUESTED');
    assert.equal(diag.mode, 'DIAGNOSTIC_ONLY_NO_RANKING_CHANGE');
  });

  it('UNAVAILABLE shape: status + mode + reason, provider explicitly disabled', async () => {
    // The Phase 2D.3 default provider now makes a plain
    // include_crr_hybrid_diagnostics: true request AVAILABLE, so this path
    // must be forced via the dependency-injection seam (buildCrrShadowMarketInputs:
    // false — not nullish, so it survives the `??` default).
    const result = await analyzeDirectional({ ...BULLISH_BASE, include_crr_hybrid_diagnostics: true }, {
      ...mockDeps(),
      buildCrrShadowMarketInputs: false,
    });
    const diag = result.diagnostics.crr_hybrid_policy;
    assert.deepEqual(Object.keys(diag).sort(), ['mode', 'reason', 'status']);
    assert.equal(diag.status, 'UNAVAILABLE');
    assert.equal(diag.mode, 'DIAGNOSTIC_ONLY_NO_RANKING_CHANGE');
    assert.equal(diag.reason, 'CRR_SHADOW_MARKET_INPUT_PROVIDER_NOT_CONFIGURED');
  });

  it('AVAILABLE shape: status + mode + market_inputs + summary + candidates, via the default non-IBKR provider', async () => {
    const result = await analyzeDirectional({ ...BULLISH_BASE, include_crr_hybrid_diagnostics: true }, mockDeps({ dividendYieldPct: 0.5 }));
    const diag = result.diagnostics.crr_hybrid_policy;
    assert.deepEqual(Object.keys(diag).sort(), ['candidates', 'market_inputs', 'mode', 'status', 'summary']);
    assert.equal(diag.status, 'AVAILABLE');
    assert.equal(diag.mode, 'DIAGNOSTIC_ONLY_NO_RANKING_CHANGE');
    assert.ok(Array.isArray(diag.market_inputs));
    assert.ok(Array.isArray(diag.candidates));
    assert.equal(typeof diag.summary, 'object');
  });

  it('summary carries exactly the four documented aggregate fields with the expected types', async () => {
    const result = await analyzeDirectional({ ...BULLISH_BASE, include_crr_hybrid_diagnostics: true }, mockDeps({ dividendYieldPct: 0.5 }));
    const { summary } = result.diagnostics.crr_hybrid_policy;
    assert.deepEqual(Object.keys(summary).sort(), ['by_action', 'crr_shadow_available_count', 'local_warning_count', 'total_candidates']);
    assert.equal(typeof summary.total_candidates, 'number');
    assert.equal(typeof summary.by_action, 'object');
    for (const count of Object.values(summary.by_action)) assert.equal(typeof count, 'number');
    assert.equal(typeof summary.crr_shadow_available_count, 'number');
    assert.equal(typeof summary.local_warning_count, 'number');
    // by_action counts must sum to total_candidates — an internal consistency
    // check, not just a shape check.
    const sum = Object.values(summary.by_action).reduce((a, b) => a + b, 0);
    assert.equal(sum, summary.total_candidates);
  });

  it('every scoped candidate entry carries exactly the seven documented public fields with expected types', async () => {
    const result = await analyzeDirectional({ ...BULLISH_BASE, include_crr_hybrid_diagnostics: true }, mockDeps({ dividendYieldPct: 0.5 }));
    const { candidates } = result.diagnostics.crr_hybrid_policy;
    assert.ok(candidates.length > 0);
    const EXPECTED_FIELDS = ['action', 'candidate_id', 'crr_shadow_available', 'local_warnings', 'max_model_disagreement_level', 'reasons', 'strategy_type'];
    for (const c of candidates) {
      assert.deepEqual(Object.keys(c).sort(), EXPECTED_FIELDS);
      assert.equal(typeof c.candidate_id, 'string');
      assert.equal(typeof c.strategy_type, 'string');
      assert.ok(['NO_ACTION', 'LOCAL_ONLY', 'LOCAL_WITH_WARNING', 'CRR_SHADOW_REVIEW', 'HYBRID_REPRICE_CANDIDATE'].includes(c.action));
      assert.ok(Array.isArray(c.reasons));
      assert.ok(Array.isArray(c.local_warnings));
      assert.ok(c.max_model_disagreement_level === null || ['MODEL_DISAGREEMENT_LOW', 'MODEL_DISAGREEMENT_MEDIUM', 'MODEL_DISAGREEMENT_HIGH'].includes(c.max_model_disagreement_level));
      assert.equal(typeof c.crr_shadow_available, 'boolean');
    }
  });

  it('every market_inputs entry carries exactly the eight documented public fields with expected types, and never claims FULL_EXTERNAL_INPUTS for the non-IBKR provider', async () => {
    const result = await analyzeDirectional({ ...BULLISH_BASE, include_crr_hybrid_diagnostics: true }, mockDeps({ dividendYieldPct: 0.5 }));
    const { market_inputs: marketInputs } = result.diagnostics.crr_hybrid_policy;
    assert.ok(marketInputs.length > 0);
    const EXPECTED_FIELDS = ['days_to_expiry', 'discount_rate_source', 'dividend_mode', 'expiration', 'mode', 'overall_confidence', 'warnings', 'borrow_source'];
    for (const mi of marketInputs) {
      assert.deepEqual(Object.keys(mi).sort(), [...EXPECTED_FIELDS].sort());
      assert.equal(typeof mi.expiration, 'string');
      assert.equal(typeof mi.days_to_expiry, 'number');
      assert.equal(typeof mi.mode, 'string');
      assert.notEqual(mi.mode, 'FULL_EXTERNAL_INPUTS');
      assert.ok(mi.overall_confidence == null || typeof mi.overall_confidence === 'string');
      assert.ok(mi.discount_rate_source == null || typeof mi.discount_rate_source === 'string');
      assert.ok(mi.dividend_mode == null || typeof mi.dividend_mode === 'string');
      assert.ok(mi.borrow_source == null || typeof mi.borrow_source === 'string');
      assert.ok(Array.isArray(mi.warnings));
    }
  });

  it('enabling diagnostics changes nothing in ranking.decision_state, ranking.top_trade_candidate_id, or any top_candidates ranking field', async () => {
    const base = await analyzeDirectional(BULLISH_BASE, mockDeps({ dividendYieldPct: 0.5 }));
    const withDiagnostics = await analyzeDirectional({ ...BULLISH_BASE, include_crr_hybrid_diagnostics: true }, mockDeps({ dividendYieldPct: 0.5 }));

    assert.equal(withDiagnostics.ranking.decision_state, base.ranking.decision_state);
    assert.equal(withDiagnostics.ranking.top_trade_candidate_id, base.ranking.top_trade_candidate_id);
    assert.deepEqual(withDiagnostics.top_candidates.map(c => c.candidate_id), base.top_candidates.map(c => c.candidate_id));
    assert.deepEqual(withDiagnostics.top_candidates.map(c => c.score), base.top_candidates.map(c => c.score));
    assert.deepEqual(withDiagnostics.top_candidates.map(c => c.confidence), base.top_candidates.map(c => c.confidence));
    assert.deepEqual(withDiagnostics.top_candidates.map(c => c.consideration_eligible), base.top_candidates.map(c => c.consideration_eligible));
  });
});
