// Phase 2C.4 — active-market synthetic borrow sensitivity diagnostic.
// Diagnostic-only. Synthetic fee rates are NOT live borrow data and must
// never be promoted to FULL_EXTERNAL_INPUTS or user-facing confidence.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getKeyStats, getOptionChain, getQuote } from '../src/core/data.js';
import { generateStrategyCandidates } from '../src/core/options/strategyCandidates.js';
import { rankStrategyCandidates } from '../src/core/options/strategyRanking.js';
import { generateCandidateScenarioResultsCrrShadow } from '../src/core/options/marketInputs/crrShadowScenario.js';
import { resolveDiscountRate, buildMarketInputRecord } from '../src/core/options/marketInputs/productionMarketInputs.js';
import { resolveDividendWithPrecedence } from '../src/core/options/marketInputs/marketInputPrecedence.js';
import { resolveBorrowInput } from '../src/core/options/marketInputs/productionMarketInputs.js';

const SYMBOLS = ['NASDAQ:NVDA', 'NASDAQ:AAPL', 'NASDAQ:PANW'];
const OUTPUT_DIR = 'docs/fixtures/phase2c4-borrow-sensitivity-20260902';

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

const FEE_GRID = [
  { label: '25BP', feeRate: 0.0025 },
  { label: '75BP', feeRate: 0.0075 },
  { label: '250BP', feeRate: 0.025 },
  { label: '1000BP', feeRate: 0.10 },
];

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

function top5Overlap(a, b) {
  const left = a.ranked_candidates.slice(0, 5).map(c => c.candidate_id);
  const right = b.ranked_candidates.slice(0, 5).map(c => c.candidate_id);
  return {
    overlap: left.filter(id => right.includes(id)).length,
    no_borrow_top5: left,
    borrow_top5: right,
    entered_top5: right.filter(id => !left.includes(id)),
    left_top5: left.filter(id => !right.includes(id)),
  };
}

function rankPositions(ranking) {
  return new Map(ranking.ranked_candidates.map(c => [c.candidate_id, c.rank]));
}

function candidateMap(enriched) {
  return new Map(enriched.map(c => [c.candidate_id, c]));
}

function rankById(ranking) {
  return new Map(ranking.ranked_candidates.map(c => [c.candidate_id, c]));
}

function scenarioPnlMap(candidate) {
  return new Map(candidate.scenario_results.map(s => [s.scenario_id, s.scenario_pnl]));
}

function compareRankings({ noBorrowRanking, borrowRanking, noBorrowEnriched, borrowEnriched }) {
  const noPos = rankPositions(noBorrowRanking);
  const withPos = rankPositions(borrowRanking);
  const noRanked = rankById(noBorrowRanking);
  const withRanked = rankById(borrowRanking);
  const noEnriched = candidateMap(noBorrowEnriched);
  const withEnriched = candidateMap(borrowEnriched);

  let largestMove = null;
  const pnlDeltas = [];

  for (const [id, from] of noPos) {
    const to = withPos.get(id);
    if (!to) continue;
    const noCandidate = noEnriched.get(id);
    const withCandidate = withEnriched.get(id);
    const noPnl = scenarioPnlMap(noCandidate);
    const withPnl = scenarioPnlMap(withCandidate);
    const scenario_deltas = noCandidate.scenario_results.map(s => {
      const delta = round2((withPnl.get(s.scenario_id) ?? 0) - (noPnl.get(s.scenario_id) ?? 0));
      pnlDeltas.push(Math.abs(delta));
      return { scenario_id: s.scenario_id, no_borrow_pnl: noPnl.get(s.scenario_id), borrow_pnl: withPnl.get(s.scenario_id), delta };
    });
    const move = Math.abs(to - from);
    const row = {
      candidate_id: id,
      strategy_type: noCandidate.strategy_type,
      expiration: noCandidate.expiration ?? null,
      no_borrow_rank: from,
      borrow_rank: to,
      abs_rank_move: move,
      no_borrow_score: noRanked.get(id)?.score ?? null,
      borrow_score: withRanked.get(id)?.score ?? null,
      score_delta: round2((withRanked.get(id)?.score ?? 0) - (noRanked.get(id)?.score ?? 0)),
      scenario_deltas,
    };
    if (!largestMove || row.abs_rank_move > largestMove.abs_rank_move) largestMove = row;
  }

  return {
    largest_move: largestMove,
    mean_abs_pnl_delta: pnlDeltas.length ? round2(pnlDeltas.reduce((a, b) => a + b, 0) / pnlDeltas.length) : null,
    max_abs_pnl_delta: pnlDeltas.length ? round2(Math.max(...pnlDeltas)) : null,
  };
}

function buildBorrowInput(symbol, feeRate) {
  if (feeRate == null) {
    return resolveBorrowInput({ connected: false, feeRate: null, source: 'NOT_CONNECTED', shortableStatus: 'UNKNOWN' });
  }
  return resolveBorrowInput({
    connected: true,
    feeRate,
    source: 'SYNTHETIC_BORROW_FEE_GRID_DIAGNOSTIC_ONLY',
    asOfUtc: new Date().toISOString(),
    confidence: 'LOW',
    shortableStatus: `SYNTHETIC_${symbol}`,
  });
}

function buildMarketInputs({ expirations, root, spot, dividendYieldPct, feeRate }) {
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
    const borrow = buildBorrowInput(root, feeRate);
    map.set(expiration, buildMarketInputRecord({ expiration, daysToExpiry: dte, discount, dividend, borrow }));
  }
  return map;
}

async function getLiveChain(exchangeSymbol) {
  const [quote, keyStats, callChain, putChain] = await Promise.all([
    getQuote({ symbol: exchangeSymbol }),
    getKeyStats({ symbol: exchangeSymbol }),
    getOptionChain({ symbol: exchangeSymbol, min_dte: 5, max_dte: 75, option_type: 'call', min_delta: 0.05, max_delta: 0.85, max_results: 500 }),
    getOptionChain({ symbol: exchangeSymbol, min_dte: 5, max_dte: 75, option_type: 'put', min_delta: -0.85, max_delta: -0.05, max_results: 500 }),
  ]);

  const byContract = new Map();
  for (const c of [...callChain.contracts, ...putChain.contracts]) byContract.set(c.contract, c);
  const contracts = [...byContract.values()].sort((a, b) =>
    a.expiration.localeCompare(b.expiration) || a.strike - b.strike || a.option_type.localeCompare(b.option_type)
  );
  const spot = keyStats.price ?? quote.last ?? quote.close;
  return {
    quote,
    keyStats,
    spot,
    chain: {
      underlying: exchangeSymbol,
      underlying_price: spot,
      chain_completeness: callChain.chain_completeness === 'POSSIBLY_TRUNCATED' || putChain.chain_completeness === 'POSSIBLY_TRUNCATED' ? 'POSSIBLY_TRUNCATED' : 'COMPLETE',
      contracts,
    },
    option_chain: {
      retrieved_at_utc: { calls: callChain.retrieved_at_utc, puts: putChain.retrieved_at_utc },
      returned_contracts: contracts.length,
      matched_contracts: { calls: callChain.matched_contracts, puts: putChain.matched_contracts },
      scanned: { calls: callChain.total_contracts_scanned, puts: putChain.total_contracts_scanned },
      completeness: callChain.chain_completeness === 'POSSIBLY_TRUNCATED' || putChain.chain_completeness === 'POSSIBLY_TRUNCATED' ? 'POSSIBLY_TRUNCATED' : 'COMPLETE',
      data_quality: { calls: callChain.data_quality, puts: putChain.data_quality },
    },
  };
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

  const scenarioResults = {};
  for (const set of SCENARIO_SETS) {
    const scenarios = scenariosFor(live.spot, set);
    const noBorrowInputs = buildMarketInputs({
      expirations,
      root,
      spot: live.spot,
      dividendYieldPct: live.keyStats.dividend_yield_pct,
      feeRate: null,
    });
    const noBorrowEnriched = candidates.map(c => generateCandidateScenarioResultsCrrShadow(c, scenarios, contractsByTicker, {
      contractMultiplier: 100,
      currentUnderlyingPrice: live.spot,
      marketInputByExpiration: noBorrowInputs,
    }));
    const noBorrowRanking = rankStrategyCandidates(noBorrowEnriched, rankingContext(scenarios, live.spot, live.chain.chain_completeness), contractsByTicker, {});

    scenarioResults[set.label] = {};
    for (const fee of FEE_GRID) {
      const borrowInputs = buildMarketInputs({
        expirations,
        root,
        spot: live.spot,
        dividendYieldPct: live.keyStats.dividend_yield_pct,
        feeRate: fee.feeRate,
      });
      const borrowEnriched = candidates.map(c => generateCandidateScenarioResultsCrrShadow(c, scenarios, contractsByTicker, {
        contractMultiplier: 100,
        currentUnderlyingPrice: live.spot,
        marketInputByExpiration: borrowInputs,
      }));
      const borrowRanking = rankStrategyCandidates(borrowEnriched, rankingContext(scenarios, live.spot, live.chain.chain_completeness), contractsByTicker, {});
      scenarioResults[set.label][fee.label] = {
        synthetic_fee_rate_pct: round2(fee.feeRate * 100),
        top5: top5Overlap(noBorrowRanking, borrowRanking),
        ...compareRankings({ noBorrowRanking, borrowRanking, noBorrowEnriched, borrowEnriched }),
      };
    }
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
    scenarios: scenarioResults,
  };
}

const startedAt = new Date().toISOString();
const symbols = [];
for (const symbol of SYMBOLS) symbols.push(await runSymbol(symbol));

const report = {
  phase: 'Phase 2C.4 Active-Market Synthetic Borrow Sensitivity',
  status: 'DIAGNOSTIC_ONLY_NO_PRODUCTION_SWITCH',
  warning: 'Synthetic fee rates are not live borrow data and cannot satisfy FULL_EXTERNAL_INPUTS.',
  started_at_utc: startedAt,
  completed_at_utc: new Date().toISOString(),
  treasury: TREASURY,
  fee_grid: FEE_GRID,
  symbols,
};

mkdirSync(OUTPUT_DIR, { recursive: true });
const output = join(OUTPUT_DIR, 'phase2c4-borrow-sensitivity-live-20260902.json');
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({
  output,
  started_at_utc: report.started_at_utc,
  completed_at_utc: report.completed_at_utc,
  symbols: symbols.map(symbol => ({
    symbol: symbol.symbol,
    contracts: symbol.option_chain.returned_contracts,
    candidates: symbol.candidates,
    stress30: Object.fromEntries(Object.entries(symbol.scenarios.STRESS_30D).map(([label, r]) => [label, {
      top5_overlap: `${r.top5.overlap}/5`,
      mean_abs_pnl_delta: r.mean_abs_pnl_delta,
      max_abs_pnl_delta: r.max_abs_pnl_delta,
      largest_move: r.largest_move?.abs_rank_move ?? null,
    }])),
  })),
}, null, 2));

process.exit(0);
