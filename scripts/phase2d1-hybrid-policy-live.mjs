// Phase 2D.1 — active-market hybrid CRR policy acceptance.
// Diagnostic-only. No production pricing switch, no ranking/confidence changes,
// no order functionality, and no IBKR dependency.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getKeyStats, getOptionChain, getQuote } from '../src/core/data.js';
import { generateStrategyCandidates } from '../src/core/options/strategyCandidates.js';
import { generateCandidateScenarioResults } from '../src/core/options/strategyScenarios.js';
import { rankStrategyCandidates } from '../src/core/options/strategyRanking.js';
import { generateCandidateScenarioResultsCrrShadow } from '../src/core/options/marketInputs/crrShadowScenario.js';
import { evaluateHybridCrrPolicy } from '../src/core/options/marketInputs/hybridCrrPolicy.js';
import { resolveDiscountRate, buildMarketInputRecord } from '../src/core/options/marketInputs/productionMarketInputs.js';
import { resolveDividendWithPrecedence, resolveBorrowWithPrecedence } from '../src/core/options/marketInputs/marketInputPrecedence.js';

const SYMBOLS = ['NASDAQ:NVDA', 'NASDAQ:AAPL', 'NASDAQ:PANW'];
const OUTPUT_DIR = 'docs/fixtures/phase2d1-hybrid-policy-live-20260902';

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

function rankingContext(scenarios, spot, chainCompleteness) {
  return {
    downside_scenario_id: scenarios[0].scenario_id,
    base_scenario_id: scenarios[1].scenario_id,
    upside_scenario_id: scenarios[2].scenario_id,
    current_underlying_price: spot,
    chain_completeness: chainCompleteness,
    configured_max_spread_pct: 100,
  };
}

function top5Overlap(localRanking, shadowRanking) {
  const local = localRanking.ranked_candidates.slice(0, 5).map(c => c.candidate_id);
  const shadow = shadowRanking.ranked_candidates.slice(0, 5).map(c => c.candidate_id);
  return {
    overlap: local.filter(id => shadow.includes(id)).length,
    local_top5: local,
    shadow_top5: shadow,
    entered_top5: shadow.filter(id => !local.includes(id)),
    left_top5: local.filter(id => !shadow.includes(id)),
  };
}

function rankById(ranking) {
  return new Map(ranking.ranked_candidates.map(c => [c.candidate_id, c]));
}

function candidateById(candidates) {
  return new Map(candidates.map(c => [c.candidate_id, c]));
}

function buildMovementDiagnostics({ localRanking, shadowRanking, localEnriched, shadowEnriched, policy }) {
  const localRanks = rankById(localRanking);
  const shadowRanks = rankById(shadowRanking);
  const localById = candidateById(localEnriched);
  const shadowById = candidateById(shadowEnriched);
  const policyById = new Map(policy.candidates.map(c => [c.candidate_id, c]));
  const ids = [...new Set([...localRanks.keys(), ...shadowRanks.keys()])];

  return ids.map(id => {
    const localRank = localRanks.get(id);
    const shadowRank = shadowRanks.get(id);
    const localCandidate = localById.get(id);
    const shadowCandidate = shadowById.get(id);
    const localScenarioWarnings = [...new Set((localCandidate?.scenario_results ?? []).flatMap(sr => sr.warnings ?? []))];

    return {
      candidate_id: id,
      strategy_type: localCandidate?.strategy_type ?? shadowCandidate?.strategy_type ?? null,
      expiration: localCandidate?.expiration ?? shadowCandidate?.expiration ?? null,
      local_rank: localRank?.rank ?? null,
      shadow_rank: shadowRank?.rank ?? null,
      rank_delta_shadow_minus_local: localRank && shadowRank ? shadowRank.rank - localRank.rank : null,
      abs_rank_move: localRank && shadowRank ? Math.abs(shadowRank.rank - localRank.rank) : null,
      local_score: localRank?.score ?? null,
      shadow_score: shadowRank?.score ?? null,
      score_delta_shadow_minus_local: localRank && shadowRank ? round2((shadowRank.score ?? 0) - (localRank.score ?? 0)) : null,
      local_confidence: localRank?.confidence ?? null,
      shadow_confidence: shadowRank?.confidence ?? null,
      local_warnings: localScenarioWarnings,
      hybrid_policy: policyById.get(id) ?? null,
    };
  }).sort((a, b) => {
    const aBoundary = Math.min(a.local_rank ?? Infinity, a.shadow_rank ?? Infinity);
    const bBoundary = Math.min(b.local_rank ?? Infinity, b.shadow_rank ?? Infinity);
    return aBoundary - bBoundary || (b.abs_rank_move ?? 0) - (a.abs_rank_move ?? 0) || a.candidate_id.localeCompare(b.candidate_id);
  });
}

function explainTop5Movement(top5, movementDiagnostics) {
  const movedIds = [...new Set([...top5.entered_top5, ...top5.left_top5])];
  const byId = new Map(movementDiagnostics.map(row => [row.candidate_id, row]));
  const rows = movedIds.map(id => byId.get(id)).filter(Boolean);
  return {
    moved_count: rows.length,
    explained_by_hybrid_policy_count: rows.filter(row =>
      ['HYBRID_REPRICE_CANDIDATE', 'CRR_SHADOW_REVIEW'].includes(row.hybrid_policy?.action)
    ).length,
    moved_candidates: rows,
  };
}

async function getLiveChain(exchangeSymbol) {
  const [quote, keyStats, callChain, putChain] = await Promise.all([
    getQuote({ symbol: exchangeSymbol }),
    getKeyStats({ symbol: exchangeSymbol }),
    getOptionChain({ symbol: exchangeSymbol, min_dte: 5, max_dte: 75, option_type: 'call', min_delta: 0.05, max_delta: 0.85, max_results: 500 }),
    getOptionChain({ symbol: exchangeSymbol, min_dte: 5, max_dte: 75, option_type: 'put', min_delta: -0.85, max_delta: -0.05, max_results: 500 }),
  ]);

  const byContract = new Map();
  for (const contract of [...callChain.contracts, ...putChain.contracts]) byContract.set(contract.contract, contract);
  const contracts = [...byContract.values()].sort((a, b) =>
    a.expiration.localeCompare(b.expiration) || a.strike - b.strike || a.option_type.localeCompare(b.option_type)
  );
  const spot = keyStats.price ?? quote.last ?? quote.close;
  const chainCompleteness = callChain.chain_completeness === 'POSSIBLY_TRUNCATED' || putChain.chain_completeness === 'POSSIBLY_TRUNCATED'
    ? 'POSSIBLY_TRUNCATED'
    : 'COMPLETE';

  return {
    quote,
    keyStats,
    spot,
    chain: {
      underlying: exchangeSymbol,
      underlying_price: spot,
      chain_completeness: chainCompleteness,
      contracts,
    },
    option_chain: {
      retrieved_at_utc: { calls: callChain.retrieved_at_utc, puts: putChain.retrieved_at_utc },
      returned_contracts: contracts.length,
      matched_contracts: { calls: callChain.matched_contracts, puts: putChain.matched_contracts },
      scanned: { calls: callChain.total_contracts_scanned, puts: putChain.total_contracts_scanned },
      completeness: chainCompleteness,
      data_quality: { calls: callChain.data_quality, puts: putChain.data_quality },
    },
  };
}

function buildMarketInputs({ expirations, root, spot, dividendYieldPct }) {
  const map = new Map();
  for (const { expiration, dte } of expirations) {
    const discount = resolveDiscountRate({ dte, billRates: TREASURY.billRates, asOfDate: TREASURY.asOfDate });
    const documentedZeroSource = root === 'PANW' ? 'DOCUMENTED_NO_DIVIDEND' : null;
    const dividend = resolveDividendWithPrecedence({
      spot,
      ibkrResult: null,
      tvTrailingYieldPct: documentedZeroSource && dividendYieldPct === 0 ? null : dividendYieldPct,
      documentedZeroSource,
    });
    const borrow = resolveBorrowWithPrecedence({ ibkrResult: null });
    map.set(expiration, buildMarketInputRecord({ expiration, daysToExpiry: dte, discount, dividend, borrow }));
  }
  return map;
}

async function runSymbol(exchangeSymbol) {
  const root = exchangeSymbol.split(':').at(-1);
  const live = await getLiveChain(exchangeSymbol);
  const candidates = generateStrategyCandidates(live.chain, {
    direction: 'bullish',
    underlying_price: live.spot,
    horizon_days: 30,
    max_loss: 100000,
    max_spread_pct: 100,
  }).candidates;
  const contractsByTicker = new Map(live.chain.contracts.map(c => [c.contract, c]));
  const expirations = [...new Map(candidates.filter(c => c.expiration).map(c => [c.expiration, c.days_to_expiry])).entries()]
    .map(([expiration, dte]) => ({ expiration, dte }));
  const marketInputByExpiration = buildMarketInputs({
    expirations,
    root,
    spot: live.spot,
    dividendYieldPct: live.keyStats.dividend_yield_pct,
  });

  const scenarioSets = {};
  for (const set of SCENARIO_SETS) {
    const scenarios = scenariosFor(live.spot, set);
    const context = rankingContext(scenarios, live.spot, live.chain.chain_completeness);
    const localEnriched = candidates.map(c => generateCandidateScenarioResults(c, scenarios, contractsByTicker, {
      contractMultiplier: 100,
      currentUnderlyingPrice: live.spot,
    }));
    const shadowEnriched = candidates.map(c => generateCandidateScenarioResultsCrrShadow(c, scenarios, contractsByTicker, {
      contractMultiplier: 100,
      currentUnderlyingPrice: live.spot,
      marketInputByExpiration,
    }));
    const localRanking = rankStrategyCandidates(localEnriched, context, contractsByTicker, {});
    const shadowRanking = rankStrategyCandidates(shadowEnriched, context, contractsByTicker, {});
    const policy = evaluateHybridCrrPolicy(localEnriched, shadowEnriched, { rankingContext: context });
    const top5 = top5Overlap(localRanking, shadowRanking);
    const movementDiagnostics = buildMovementDiagnostics({ localRanking, shadowRanking, localEnriched, shadowEnriched, policy });

    scenarioSets[set.label] = {
      scenarios,
      top5,
      hybrid_policy_summary: policy.summary,
      top5_movement_explanation: explainTop5Movement(top5, movementDiagnostics),
      top10_boundary_policy: movementDiagnostics.slice(0, 10),
    };
  }

  return {
    symbol: exchangeSymbol,
    root,
    quote: { last: live.quote.last, exchange: live.quote.exchange, time: live.quote.time },
    key_stats: {
      price: live.keyStats.price,
      dividend_yield_pct: live.keyStats.dividend_yield_pct,
      volume: live.keyStats.volume,
      next_earnings_date: live.keyStats.next_earnings_date,
    },
    option_chain: live.option_chain,
    candidates: candidates.length,
    market_inputs: [...marketInputByExpiration.values()].map(r => ({
      expiration: r.expiration,
      dte: r.days_to_expiry,
      mode: r.mode,
      confidence: r.overall_confidence,
      discount_rate_pct: r.discount_rate == null ? null : round2(r.discount_rate * 100),
      dividend_mode: r.dividend_input.mode,
      dividend_yield_pct: r.dividend_input.annualized_yield == null ? null : round2(r.dividend_input.annualized_yield * 100),
      borrow_fee_rate_pct: r.borrow_input.fee_rate == null ? null : round2(r.borrow_input.fee_rate * 100),
      warnings: r.warnings,
    })),
    scenario_sets: scenarioSets,
  };
}

const startedAt = new Date().toISOString();
const results = [];
for (const symbol of SYMBOLS) results.push(await runSymbol(symbol));

const report = {
  phase: 'Phase 2D.1 Active-Market Hybrid CRR Policy Acceptance',
  status: 'DIAGNOSTIC_ONLY_NO_PRODUCTION_SWITCH',
  started_at_utc: startedAt,
  completed_at_utc: new Date().toISOString(),
  treasury: TREASURY,
  symbols: results,
};

mkdirSync(OUTPUT_DIR, { recursive: true });
const output = join(OUTPUT_DIR, 'phase2d1-hybrid-policy-live-20260902.json');
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  output,
  started_at_utc: report.started_at_utc,
  completed_at_utc: report.completed_at_utc,
  symbols: results.map(symbol => ({
    symbol: symbol.symbol,
    contracts: symbol.option_chain.returned_contracts,
    candidates: symbol.candidates,
    stress30_top5_overlap: `${symbol.scenario_sets.STRESS_30D.top5.overlap}/5`,
    stress30_policy: symbol.scenario_sets.STRESS_30D.hybrid_policy_summary.by_action,
    stress30_moved_explained: `${symbol.scenario_sets.STRESS_30D.top5_movement_explanation.explained_by_hybrid_policy_count}/${symbol.scenario_sets.STRESS_30D.top5_movement_explanation.moved_count}`,
    original30_top5_overlap: `${symbol.scenario_sets.PHASE2C_ORIGINAL_30D.top5.overlap}/5`,
    original30_policy: symbol.scenario_sets.PHASE2C_ORIGINAL_30D.hybrid_policy_summary.by_action,
    original30_moved_explained: `${symbol.scenario_sets.PHASE2C_ORIGINAL_30D.top5_movement_explanation.explained_by_hybrid_policy_count}/${symbol.scenario_sets.PHASE2C_ORIGINAL_30D.top5_movement_explanation.moved_count}`,
  })),
}, null, 2));

process.exit(0);
