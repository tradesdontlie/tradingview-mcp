// Phase 2C.3 — active-market per-candidate CRR shadow ranking decomposition.
// Diagnostic-only. No production pricing switch, no ranking/confidence changes,
// no order functionality.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getKeyStats, getOptionChain, getQuote } from '../src/core/data.js';
import { generateStrategyCandidates } from '../src/core/options/strategyCandidates.js';
import { generateCandidateScenarioResults } from '../src/core/options/strategyScenarios.js';
import { rankStrategyCandidates } from '../src/core/options/strategyRanking.js';
import {
  generateCandidateScenarioResultsCrrShadow,
  computeModelDisagreement,
} from '../src/core/options/marketInputs/crrShadowScenario.js';
import {
  resolveDiscountRate,
  buildMarketInputRecord,
  buildShadowSnapshotId,
} from '../src/core/options/marketInputs/productionMarketInputs.js';
import {
  resolveDividendWithPrecedence,
  resolveBorrowWithPrecedence,
  classifyShadowMarketInputConfidence,
} from '../src/core/options/marketInputs/marketInputPrecedence.js';
import { createClientPortalClient } from '../src/providers/ibkr/clientPortalClient.js';
import { fetchIbkrMarketInputs } from '../src/providers/ibkr/ibkrMarketInputsProvider.js';

const SYMBOLS = ['NASDAQ:NVDA', 'NASDAQ:AAPL', 'NASDAQ:PANW'];
const OUTPUT_DIR = 'docs/fixtures/phase2c3-ranking-decomposition-20260902';

// Latest Treasury Daily Treasury Bill Rates row available during the
// 2026-09-02 active-market runs. Keep explicit until a project-owned
// Treasury fetcher is added.
const TREASURY = Object.freeze({
  asOfDate: '2026-09-01',
  source: 'U.S. Treasury Daily Treasury Bill Rates, latest published row available during run',
  billRates: {
    fourWeek: 0.0375,
    sixWeek: 0.0381,
    eightWeek: 0.0382,
    thirteenWeek: 0.0387,
    seventeenWeek: 0.0393,
    twentySixWeek: 0.0403,
    fiftyTwoWeek: 0.0418,
  },
});

const SCENARIO_SETS = [
  { label: 'STRESS_30D', daysForward: 30, multipliers: [0.90, 1.00, 1.10] },
  { label: 'PHASE2C_ORIGINAL_30D', daysForward: 30, multipliers: [0.90, 1.05, 1.10] },
];

function round2(v) {
  return v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
}

function scenariosFor(spot, set) {
  const names = ['DOWN', 'BASE', 'UP'];
  return set.multipliers.map((m, i) => ({
    scenario_id: `${set.label}_${names[i]}`,
    role: names[i].toLowerCase(),
    underlying_price: round2(spot * m),
    days_forward: set.daysForward,
    iv_change_points: 0,
  }));
}

function keyedByCandidate(ranking) {
  return new Map(ranking.ranked_candidates.map(c => [c.candidate_id, c]));
}

function scenarioById(candidate) {
  return new Map(candidate.scenario_results.map(s => [s.scenario_id, s]));
}

function summarizeLegs(candidate) {
  return candidate.legs.map(leg => ({
    role: leg.role,
    contract: leg.contract,
    fill_price: leg.fill_price,
    quantity: leg.quantity ?? null,
    shares: leg.shares ?? null,
  }));
}

function candidateDiagnostics({ candidates, localEnriched, shadowEnriched, localRanking, shadowRanking, scenarios }) {
  const localRanked = keyedByCandidate(localRanking);
  const shadowRanked = keyedByCandidate(shadowRanking);
  const localById = new Map(localEnriched.map(c => [c.candidate_id, c]));
  const shadowById = new Map(shadowEnriched.map(c => [c.candidate_id, c]));
  const rows = [];

  for (const candidate of candidates) {
    const localRank = localRanked.get(candidate.candidate_id);
    const shadowRank = shadowRanked.get(candidate.candidate_id);
    if (!localRank || !shadowRank) continue;

    const localScenarios = scenarioById(localById.get(candidate.candidate_id));
    const shadowScenarios = scenarioById(shadowById.get(candidate.candidate_id));
    const perScenario = scenarios.map(scenario => {
      const local = localScenarios.get(scenario.scenario_id);
      const shadow = shadowScenarios.get(scenario.scenario_id);
      const disagreement = local?.available && shadow?.available
        ? computeModelDisagreement(local.scenario_pnl, shadow.scenario_pnl, candidate.max_loss)
        : null;
      return {
        role: scenario.role,
        scenario_id: scenario.scenario_id,
        underlying_price: scenario.underlying_price,
        local_pnl: local?.scenario_pnl ?? null,
        shadow_pnl: shadow?.scenario_pnl ?? null,
        pnl_delta_shadow_minus_local: local?.available && shadow?.available ? round2(shadow.scenario_pnl - local.scenario_pnl) : null,
        local_return_on_risk_pct: local?.scenario_return_on_risk_pct ?? null,
        shadow_return_on_risk_pct: shadow?.scenario_return_on_risk_pct ?? null,
        disagreement_pct_of_risk: disagreement?.model_disagreement_pct_of_risk ?? null,
        disagreement_level: disagreement?.level ?? null,
        local_warnings: local?.warnings ?? [],
        shadow_warnings: shadow?.warnings ?? [],
        local_leg_results: local?.leg_results ?? [],
        shadow_leg_results: shadow?.leg_results ?? [],
      };
    });

    rows.push({
      candidate_id: candidate.candidate_id,
      strategy_type: candidate.strategy_type,
      expiration: candidate.expiration ?? null,
      legs: summarizeLegs(candidate),
      max_loss: candidate.max_loss,
      max_profit: candidate.max_profit,
      max_profit_type: candidate.max_profit_type,
      breakeven: candidate.breakeven,
      capital_required: candidate.capital_required,
      local_rank: localRank.rank,
      shadow_rank: shadowRank.rank,
      rank_delta_shadow_minus_local: shadowRank.rank - localRank.rank,
      abs_rank_move: Math.abs(shadowRank.rank - localRank.rank),
      local_score: localRank.score,
      shadow_score: shadowRank.score,
      score_delta_shadow_minus_local: round2((shadowRank.score ?? 0) - (localRank.score ?? 0)),
      local_confidence: localRank.confidence,
      shadow_confidence: shadowRank.confidence,
      local_consideration_eligible: localRank.consideration_eligible,
      shadow_consideration_eligible: shadowRank.consideration_eligible,
      local_consideration_reasons: localRank.consideration_reasons,
      shadow_consideration_reasons: shadowRank.consideration_reasons,
      local_raw_metrics: localRank.raw_metrics,
      shadow_raw_metrics: shadowRank.raw_metrics,
      local_component_scores: localRank.component_scores,
      shadow_component_scores: shadowRank.component_scores,
      component_score_deltas_shadow_minus_local: Object.fromEntries(
        Object.keys(localRank.component_scores ?? {}).map(key => [
          key,
          round2((shadowRank.component_scores?.[key] ?? 0) - (localRank.component_scores?.[key] ?? 0)),
        ]),
      ),
      scenario_diagnostics: perScenario,
    });
  }

  rows.sort((a, b) => b.abs_rank_move - a.abs_rank_move || a.local_rank - b.local_rank || a.candidate_id.localeCompare(b.candidate_id));
  return rows;
}

function top5Overlap(localRanking, shadowRanking) {
  const local = localRanking.ranked_candidates.slice(0, 5).map(c => c.candidate_id);
  const shadow = shadowRanking.ranked_candidates.slice(0, 5).map(c => c.candidate_id);
  return {
    overlap: local.filter(id => shadow.includes(id)).length,
    local,
    shadow,
    entered_top5: shadow.filter(id => !local.includes(id)),
    left_top5: local.filter(id => !shadow.includes(id)),
  };
}

async function getIbkr(symbol) {
  for (const baseUrl of ['https://localhost:5000/v1/api', 'https://localhost:5001/v1/api']) {
    const result = await fetchIbkrMarketInputs(createClientPortalClient({ baseUrl, timeoutMs: 2500 }), symbol);
    if (result.connection_status !== 'UNAVAILABLE') return { baseUrl, result };
  }
  const result = await fetchIbkrMarketInputs(createClientPortalClient({ baseUrl: 'https://localhost:5000/v1/api', timeoutMs: 2500 }), symbol);
  return { baseUrl: 'https://localhost:5000/v1/api', result };
}

async function runSymbol(exchangeSymbol) {
  const root = exchangeSymbol.split(':').at(-1);
  const [quote, keyStats, callChain, putChain, ibkr] = await Promise.all([
    getQuote({ symbol: exchangeSymbol }),
    getKeyStats({ symbol: exchangeSymbol }),
    getOptionChain({ symbol: exchangeSymbol, min_dte: 5, max_dte: 75, option_type: 'call', min_delta: 0.05, max_delta: 0.85, max_results: 500 }),
    getOptionChain({ symbol: exchangeSymbol, min_dte: 5, max_dte: 75, option_type: 'put', min_delta: -0.85, max_delta: -0.05, max_results: 500 }),
    getIbkr(root),
  ]);

  const byContract = new Map();
  for (const c of [...callChain.contracts, ...putChain.contracts]) byContract.set(c.contract, c);
  const contracts = [...byContract.values()].sort((a, b) =>
    a.expiration.localeCompare(b.expiration) || a.strike - b.strike || a.option_type.localeCompare(b.option_type)
  );
  const spot = keyStats.price ?? quote.last ?? quote.close;
  const chain = {
    underlying: exchangeSymbol,
    underlying_price: spot,
    chain_completeness: callChain.chain_completeness === 'POSSIBLY_TRUNCATED' || putChain.chain_completeness === 'POSSIBLY_TRUNCATED' ? 'POSSIBLY_TRUNCATED' : 'COMPLETE',
    contracts,
  };
  const candidates = generateStrategyCandidates(chain, {
    direction: 'bullish',
    underlying_price: spot,
    horizon_days: 30,
    max_loss: 100000,
    max_spread_pct: 100,
  }).candidates;
  const contractsByTicker = new Map(contracts.map(c => [c.contract, c]));
  const expirations = [...new Map(candidates.filter(c => c.expiration).map(c => [c.expiration, c.days_to_expiry])).entries()]
    .map(([expiration, dte]) => ({ expiration, dte }));

  const marketInputByExpiration = new Map();
  const normalizedInputsForId = { symbol: exchangeSymbol, spot, treasury: TREASURY.asOfDate, expirations: {} };
  for (const { expiration, dte } of expirations) {
    const discount = resolveDiscountRate({ dte, billRates: TREASURY.billRates, asOfDate: TREASURY.asOfDate });
    const documentedZeroSource = root === 'PANW' ? 'DOCUMENTED_NO_DIVIDEND' : null;
    const dividend = resolveDividendWithPrecedence({
      spot,
      ibkrResult: ibkr.result,
      tvTrailingYieldPct: documentedZeroSource && keyStats.dividend_yield_pct === 0 ? null : keyStats.dividend_yield_pct,
      documentedZeroSource,
    });
    const borrow = resolveBorrowWithPrecedence({ ibkrResult: ibkr.result });
    const rec = buildMarketInputRecord({ expiration, daysToExpiry: dte, discount, dividend, borrow });
    marketInputByExpiration.set(expiration, {
      ...rec,
      shadow_input_confidence: classifyShadowMarketInputConfidence({
        discountAvailable: rec.discount_rate != null,
        dividendConfidence: dividend.confidence,
        borrowPresent: borrow.fee_rate != null,
        marketDataAvailability: ibkr.result.market_data_availability,
      }),
    });
    normalizedInputsForId.expirations[expiration] = { dte, discount, dividend, borrow, ibkr: ibkr.result.connection_status };
  }

  const scenarioSetReports = {};
  for (const set of SCENARIO_SETS) {
    const scenarios = scenariosFor(spot, set);
    const cfg = { contractMultiplier: 100, currentUnderlyingPrice: spot, marketInputByExpiration };
    const localEnriched = candidates.map(c => generateCandidateScenarioResults(c, scenarios, contractsByTicker, {
      contractMultiplier: 100,
      currentUnderlyingPrice: spot,
    }));
    const shadowEnriched = candidates.map(c => generateCandidateScenarioResultsCrrShadow(c, scenarios, contractsByTicker, cfg));
    const context = {
      downside_scenario_id: scenarios[0].scenario_id,
      base_scenario_id: scenarios[1].scenario_id,
      upside_scenario_id: scenarios[2].scenario_id,
      current_underlying_price: spot,
      chain_completeness: chain.chain_completeness,
      configured_max_spread_pct: 100,
    };
    const localRanking = rankStrategyCandidates(localEnriched, context, contractsByTicker, {});
    const shadowRanking = rankStrategyCandidates(shadowEnriched, context, contractsByTicker, {});
    const diagnostics = candidateDiagnostics({ candidates, localEnriched, shadowEnriched, localRanking, shadowRanking, scenarios });
    scenarioSetReports[set.label] = {
      scenarios,
      top5: top5Overlap(localRanking, shadowRanking),
      largest_moves: diagnostics.slice(0, 10),
      top5_boundary_diagnostics: diagnostics
        .filter(c => c.local_rank <= 8 || c.shadow_rank <= 8)
        .sort((a, b) => Math.min(a.local_rank, a.shadow_rank) - Math.min(b.local_rank, b.shadow_rank)),
      all_candidate_diagnostics: diagnostics,
    };
  }

  return {
    symbol: exchangeSymbol,
    root,
    quote: { last: quote.last, exchange: quote.exchange, time: quote.time },
    key_stats: {
      price: keyStats.price,
      dividend_yield_pct: keyStats.dividend_yield_pct,
      volume: keyStats.volume,
      next_earnings_date: keyStats.next_earnings_date,
    },
    option_chain: {
      retrieved_at_utc: { calls: callChain.retrieved_at_utc, puts: putChain.retrieved_at_utc },
      returned_contracts: contracts.length,
      matched_contracts: { calls: callChain.matched_contracts, puts: putChain.matched_contracts },
      scanned: { calls: callChain.total_contracts_scanned, puts: putChain.total_contracts_scanned },
      completeness: chain.chain_completeness,
      data_quality: { calls: callChain.data_quality, puts: putChain.data_quality },
    },
    ibkr: {
      probed_base_url: ibkr.baseUrl,
      connection_status: ibkr.result.connection_status,
      warnings: ibkr.result.warnings,
      fee_rate: ibkr.result.fee_rate,
      expected_12m_dividend_per_share: ibkr.result.expected_12m_dividend_per_share,
      market_data_availability: ibkr.result.market_data_availability,
    },
    candidates: candidates.length,
    market_inputs: [...marketInputByExpiration.values()].map(r => ({
      expiration: r.expiration,
      dte: r.days_to_expiry,
      mode: r.mode,
      confidence: r.overall_confidence,
      shadow_input_confidence: r.shadow_input_confidence,
      discount_rate_pct: r.discount_rate == null ? null : round2(r.discount_rate * 100),
      dividend_mode: r.dividend_input.mode,
      dividend_yield_pct: r.dividend_input.annualized_yield == null ? null : round2(r.dividend_input.annualized_yield * 100),
      borrow_fee_rate_pct: r.borrow_input.fee_rate == null ? null : round2(r.borrow_input.fee_rate * 100),
      warnings: r.warnings,
    })),
    shadow_snapshot_id: buildShadowSnapshotId(normalizedInputsForId),
    scenario_sets: scenarioSetReports,
  };
}

const startedAt = new Date().toISOString();
const results = [];
for (const symbol of SYMBOLS) results.push(await runSymbol(symbol));

const report = {
  phase: 'Phase 2C.3 Active-Market Ranking Decomposition',
  status: 'DIAGNOSTIC_ONLY_NO_PRODUCTION_SWITCH',
  started_at_utc: startedAt,
  completed_at_utc: new Date().toISOString(),
  treasury: TREASURY,
  symbols: results,
};

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'phase2c3-ranking-decomposition-live-20260902.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  output: join(OUTPUT_DIR, 'phase2c3-ranking-decomposition-live-20260902.json'),
  started_at_utc: report.started_at_utc,
  completed_at_utc: report.completed_at_utc,
  symbols: results.map(s => ({
    symbol: s.symbol,
    contracts: s.option_chain.returned_contracts,
    candidates: s.candidates,
    ibkr: s.ibkr.connection_status,
    stress30_top5_overlap: `${s.scenario_sets.STRESS_30D.top5.overlap}/5`,
    original30_top5_overlap: `${s.scenario_sets.PHASE2C_ORIGINAL_30D.top5.overlap}/5`,
    shadow_snapshot_id: s.shadow_snapshot_id,
  })),
}, null, 2));

process.exit(0);
