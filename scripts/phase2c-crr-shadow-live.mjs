// Phase 2C — read-only live CRR shadow vs LOCAL_GREEK_APPROXIMATION
// comparison for NVDA, AAPL, PANW. Diagnostic-only, not wired into
// production. These are TEST scenarios (fixed DOWNSIDE/BASE/UPSIDE
// multipliers), not a user thesis or recommendation. Run manually:
//   node scripts/phase2c-crr-shadow-live.mjs
import { readFileSync } from 'node:fs';
import { generateStrategyCandidates } from '../src/core/options/strategyCandidates.js';
import { generateCandidateScenarioResults } from '../src/core/options/strategyScenarios.js';
import { rankStrategyCandidates } from '../src/core/options/strategyRanking.js';
import { generateCandidateScenarioResultsCrrShadow, computeModelDisagreement } from '../src/core/options/marketInputs/crrShadowScenario.js';
import { resolveDiscountRate, resolveDividendInput, DIVIDEND_MODES, buildMarketInputRecord } from '../src/core/options/marketInputs/productionMarketInputs.js';
import { notConnectedBorrowProvider, toBorrowInput } from '../src/core/options/marketInputs/borrowProviders.js';

const fx = JSON.parse(readFileSync(new URL('../docs/fixtures/phase2c-live-chains-20260830.json', import.meta.url)));

function buildChain(symbol) {
  const spot = fx.symbols[symbol].spot;
  const contracts = fx[`${symbol}_contracts`].map(c => ({
    contract: c.contract, root: symbol, expiration: c.expiration, days_to_expiry: c.dte, strike: c.strike,
    option_type: c.type, currency: 'USD', bid: c.bid, ask: c.ask, theoretical_price: c.theoretical_price,
    iv: c.iv, bid_iv: c.iv - 1, ask_iv: c.iv + 1, delta: c.delta, gamma: c.gamma, theta: c.theta, vega: c.vega, rho: c.rho,
    mid: (c.bid + c.ask) / 2, spread: c.ask - c.bid, spread_pct: Math.round(((c.ask - c.bid) / ((c.ask + c.bid) / 2)) * 1000) / 10,
    iv_spread: 2, quality_flags: [],
  }));
  return { underlying: `NASDAQ:${symbol}`, underlying_price: spot, chain_completeness: 'COMPLETE', contracts };
}

async function buildMarketInputsByExpiration(symbol, expirations) {
  const spot = fx.symbols[symbol].spot;
  const divYieldPct = fx.symbols[symbol].dividend_yield_pct;
  const borrowResult = await notConnectedBorrowProvider(symbol);
  const borrow = toBorrowInput(borrowResult);

  const map = new Map();
  for (const { expiration, dte } of expirations) {
    const discount = resolveDiscountRate({ dte, billRates: fx.treasury_bill_rates_coupon_equivalent, asOfDate: fx.treasury_bill_rates_observation_date });
    const dividend = divYieldPct === 0
      ? resolveDividendInput({ mode: DIVIDEND_MODES.ZERO_DIVIDEND_CONFIRMED, source: 'DOCUMENTED_NO_DIVIDEND' })
      : resolveDividendInput({ mode: DIVIDEND_MODES.TRAILING_DIVIDEND_YIELD_APPROXIMATION, trailingYieldDecimal: divYieldPct / 100, source: 'TRADINGVIEW_KEY_STATS_TRAILING_YIELD', asOfUtc: fx.as_of_utc });
    const record = buildMarketInputRecord({ expiration, daysToExpiry: dte, discount, dividend, borrow });
    map.set(expiration, record);
  }
  return map;
}

function standardScenarios(spot) {
  return [
    { scenario_id: 'DOWNSIDE', underlying_price: Math.round(spot * 0.90 * 100) / 100, days_forward: 30, iv_change_points: 0 },
    { scenario_id: 'BASE', underlying_price: Math.round(spot * 1.05 * 100) / 100, days_forward: 30, iv_change_points: 0 },
    { scenario_id: 'UPSIDE', underlying_price: Math.round(spot * 1.10 * 100) / 100, days_forward: 30, iv_change_points: 0 },
  ];
}

async function runSymbol(symbol) {
  const chain = buildChain(symbol);
  const cByT = new Map(chain.contracts.map(c => [c.contract, c]));
  const spot = chain.underlying_price;

  const candidatesResult = generateStrategyCandidates(chain, { direction: 'bullish', underlying_price: spot, horizon_days: 30, max_loss: 100000, max_spread_pct: 100 });
  const candidates = candidatesResult.candidates;
  console.log(`\n=== ${symbol} spot=${spot} candidates=${candidates.length} ===`);
  if (candidates.length === 0) { console.log('No candidates generated (fixture too thin) — skipping.'); return; }

  const expirations = [...new Set(candidates.map(c => c.expiration).filter(Boolean))].map(expiration => ({ expiration, dte: candidates.find(c => c.expiration === expiration).days_to_expiry }));
  const marketInputByExpiration = await buildMarketInputsByExpiration(symbol, expirations);

  console.log('Market input status:');
  for (const [exp, rec] of marketInputByExpiration) {
    console.log(`  ${exp}: mode=${rec.mode} discount_rate=${(rec.discount_rate * 100).toFixed(3)}% dividend_mode=${rec.dividend_input.mode} dividend_yield=${rec.dividend_input.annualized_yield != null ? (rec.dividend_input.annualized_yield * 100).toFixed(4) + '%' : 'null'} borrow=${rec.borrow_input.fee_rate ?? 'UNAVAILABLE'} confidence=${rec.overall_confidence}`);
  }

  const scenarios = standardScenarios(spot);
  const cfg = { contractMultiplier: 100, currentUnderlyingPrice: spot, marketInputByExpiration };

  const enrichedLocal = candidates.map(c => generateCandidateScenarioResults(c, scenarios, cByT, { contractMultiplier: 100, currentUnderlyingPrice: spot }));
  const enrichedShadow = candidates.map(c => generateCandidateScenarioResultsCrrShadow(c, scenarios, cByT, cfg));

  // Model disagreement per candidate, BASE scenario (Step 16-18).
  const disagreements = [];
  for (let i = 0; i < candidates.length; i++) {
    const local = enrichedLocal[i].scenario_results.find(s => s.scenario_id === 'BASE');
    const shadow = enrichedShadow[i].scenario_results.find(s => s.scenario_id === 'BASE');
    if (!local?.available || !shadow?.available) continue;
    const d = computeModelDisagreement(local.scenario_pnl, shadow.scenario_pnl, candidates[i].max_loss);
    const hasWarning = (local.warnings ?? []).some(w => ['LARGE_TIME_STEP', 'NEAR_EXPIRATION', 'LARGE_SPOT_MOVE'].includes(w));
    disagreements.push({ candidate_id: candidates[i].candidate_id, strategy_type: candidates[i].strategy_type, ...d, has_local_warning: hasWarning });
  }
  disagreements.sort((a, b) => a.model_disagreement_pct_of_risk - b.model_disagreement_pct_of_risk);
  const pcts = disagreements.map(d => d.model_disagreement_pct_of_risk);
  const median = pcts.length ? pcts[Math.floor(pcts.length / 2)] : null;
  const p75 = pcts.length ? pcts[Math.floor(pcts.length * 0.75)] : null;
  const p95 = pcts.length ? pcts[Math.floor(pcts.length * 0.95)] : null;
  const max = pcts.length ? pcts[pcts.length - 1] : null;
  console.log(`\nBASE-scenario disagreement (n=${disagreements.length}): median=${median}% P75=${p75}% P95=${p95}% max=${max}%`);

  const withWarning = disagreements.filter(d => d.has_local_warning);
  const withoutWarning = disagreements.filter(d => !d.has_local_warning);
  const meanPct = arr => arr.length ? (arr.reduce((s, d) => s + d.model_disagreement_pct_of_risk, 0) / arr.length).toFixed(2) : 'n/a';
  console.log(`With LOCAL_GREEK warning (n=${withWarning.length}): mean disagreement=${meanPct(withWarning)}%`);
  console.log(`Without LOCAL_GREEK warning (n=${withoutWarning.length}): mean disagreement=${meanPct(withoutWarning)}%`);

  // Shadow ranking (Step 26-27) — production ranking vs shadow-scenario ranking, same candidates.
  const rankingContext = { downside_scenario_id: 'DOWNSIDE', base_scenario_id: 'BASE', upside_scenario_id: 'UPSIDE', current_underlying_price: spot, chain_completeness: 'COMPLETE', configured_max_spread_pct: 100 };
  const prodRanking = rankStrategyCandidates(enrichedLocal, rankingContext, cByT, {});
  const shadowRanking = rankStrategyCandidates(enrichedShadow, rankingContext, cByT, {});

  const prodTop5 = prodRanking.ranked_candidates.slice(0, 5).map(c => c.candidate_id);
  const shadowTop5 = shadowRanking.ranked_candidates.slice(0, 5).map(c => c.candidate_id);
  const overlap = prodTop5.filter(id => shadowTop5.includes(id)).length;
  console.log(`\nSHADOW_RANKING_ONLY: top-5 overlap = ${overlap}/5`);

  const scoreById = new Map(shadowRanking.ranked_candidates.map(c => [c.candidate_id, c.score]));
  const rankChanges = prodRanking.ranked_candidates.map((c, i) => {
    const shadowIdx = shadowRanking.ranked_candidates.findIndex(s => s.candidate_id === c.candidate_id);
    return { candidate_id: c.candidate_id, prod_rank: i + 1, shadow_rank: shadowIdx + 1, prod_score: c.score, shadow_score: scoreById.get(c.candidate_id) };
  });
  const biggestMove = [...rankChanges].sort((a, b) => Math.abs(b.prod_rank - b.shadow_rank) - Math.abs(a.prod_rank - a.shadow_rank))[0];
  if (biggestMove) console.log(`Largest rank change: ${biggestMove.candidate_id} prod_rank=${biggestMove.prod_rank} shadow_rank=${biggestMove.shadow_rank} (prod_score=${biggestMove.prod_score}, shadow_score=${biggestMove.shadow_score})`);
}

for (const symbol of ['NVDA', 'AAPL', 'PANW']) {
  await runSymbol(symbol);
}
