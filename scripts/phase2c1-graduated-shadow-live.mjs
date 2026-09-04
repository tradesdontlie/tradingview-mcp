// Phase 2C.1 — graduated (5/15/30-day) CRR shadow vs LOCAL_GREEK_APPROXIMATION
// comparison, plus borrow/dividend ablations and NVDA rank-instability
// decomposition. Diagnostic-only, not wired into production.
//
// OFF_HOURS_DIAGNOSTIC: run on Sunday 2026-08-30 UTC — U.S. equity/options
// markets were closed. Per Phase 2C.1 Step 30, this result is NOT used for
// the production-readiness verdict; it is reported as an off-hours
// diagnostic against the same (only) live TradingView snapshot available
// this session (see docs/fixtures/phase2c-live-chains-20260830.json,
// itself confirmed unchanged from the prior session in Phase 2C).
//
// IBKR: confirmed UNAVAILABLE this session (no Client Portal Gateway
// reachable on localhost:5000/5001 — connection refused / timeout).
// Borrow ablation therefore uses an explicitly labeled SYNTHETIC fixture
// fee rate, never presented as real IBKR data.
import { readFileSync } from 'node:fs';
import { generateStrategyCandidates } from '../src/core/options/strategyCandidates.js';
import { generateCandidateScenarioResults } from '../src/core/options/strategyScenarios.js';
import { rankStrategyCandidates } from '../src/core/options/strategyRanking.js';
import { generateCandidateScenarioResultsCrrShadow, computeModelDisagreement } from '../src/core/options/marketInputs/crrShadowScenario.js';
import { resolveDiscountRate, resolveDividendInput, DIVIDEND_MODES, buildMarketInputRecord } from '../src/core/options/marketInputs/productionMarketInputs.js';
import { notConnectedBorrowProvider, toBorrowInput, fixtureBorrowProvider } from '../src/core/options/marketInputs/borrowProviders.js';

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
function contractsByTicker(chain) { return new Map(chain.contracts.map(c => [c.contract, c])); }

async function buildMarketInputsByExpiration(symbol, expirations, { borrowProvider = notConnectedBorrowProvider } = {}) {
  const divYieldPct = fx.symbols[symbol].dividend_yield_pct;
  const borrowResult = await borrowProvider(symbol);
  const borrow = toBorrowInput(borrowResult);
  const map = new Map();
  for (const { expiration, dte } of expirations) {
    const discount = resolveDiscountRate({ dte, billRates: fx.treasury_bill_rates_coupon_equivalent, asOfDate: fx.treasury_bill_rates_observation_date });
    const dividend = divYieldPct === 0
      ? resolveDividendInput({ mode: DIVIDEND_MODES.ZERO_DIVIDEND_CONFIRMED, source: 'DOCUMENTED_NO_DIVIDEND' })
      : resolveDividendInput({ mode: DIVIDEND_MODES.TRAILING_DIVIDEND_YIELD_APPROXIMATION, trailingYieldDecimal: divYieldPct / 100, source: 'TRADINGVIEW_KEY_STATS_TRAILING_YIELD', asOfUtc: fx.as_of_utc });
    map.set(expiration, buildMarketInputRecord({ expiration, daysToExpiry: dte, discount, dividend, borrow }));
  }
  return map;
}

const HORIZONS = [
  { label: 'LOCAL_5D', daysForward: 5, multipliers: [0.98, 1.00, 1.02] },
  { label: 'MODERATE_15D', daysForward: 15, multipliers: [0.95, 1.00, 1.05] },
  { label: 'STRESS_30D', daysForward: 30, multipliers: [0.90, 1.00, 1.10] },
];

function scenariosFor(spot, horizon) {
  const ids = ['DOWN', 'MID', 'UP'];
  return horizon.multipliers.map((m, i) => ({ scenario_id: `${horizon.label}_${ids[i]}`, underlying_price: Math.round(spot * m * 100) / 100, days_forward: horizon.daysForward, iv_change_points: 0 }));
}

function stats(arr) {
  if (!arr.length) return { median: null, p75: null, p95: null, max: null, n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p75: s[Math.floor(s.length * 0.75)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], n: s.length };
}

async function runSymbol(symbol) {
  const chain = buildChain(symbol);
  const cByT = contractsByTicker(chain);
  const spot = chain.underlying_price;
  const candidatesResult = generateStrategyCandidates(chain, { direction: 'bullish', underlying_price: spot, horizon_days: 30, max_loss: 100000, max_spread_pct: 100 });
  const candidates = candidatesResult.candidates;
  console.log(`\n=== ${symbol} spot=${spot} candidates=${candidates.length} [OFF_HOURS_DIAGNOSTIC] ===`);

  const expirations = [...new Set(candidates.map(c => c.expiration).filter(Boolean))].map(expiration => ({ expiration, dte: candidates.find(c => c.expiration === expiration).days_to_expiry }));
  const marketInputByExpiration = await buildMarketInputsByExpiration(symbol, expirations);
  const cfg = { contractMultiplier: 100, currentUnderlyingPrice: spot, marketInputByExpiration };

  const horizonResults = {};
  const warningBuckets = { warned: [], unwarned: [] };

  for (const horizon of HORIZONS) {
    const scenarios = scenariosFor(spot, horizon);
    const disagreements = [];
    for (const c of candidates) {
      const local = generateCandidateScenarioResults(c, scenarios, cByT, { contractMultiplier: 100, currentUnderlyingPrice: spot });
      const shadow = generateCandidateScenarioResultsCrrShadow(c, scenarios, cByT, cfg);
      for (let i = 0; i < scenarios.length; i++) {
        const l = local.scenario_results[i], s = shadow.scenario_results[i];
        if (!l?.available || !s?.available) continue;
        const d = computeModelDisagreement(l.scenario_pnl, s.scenario_pnl, c.max_loss);
        disagreements.push(d.model_disagreement_pct_of_risk);
        const warned = (l.warnings ?? []).some(w => ['LARGE_TIME_STEP', 'NEAR_EXPIRATION', 'LARGE_SPOT_MOVE', 'INTRINSIC_FLOOR_APPLIED'].includes(w));
        (warned ? warningBuckets.warned : warningBuckets.unwarned).push(d.model_disagreement_pct_of_risk);
      }
    }
    horizonResults[horizon.label] = stats(disagreements);
  }

  console.log('Horizon disagreement (% of max risk):');
  for (const [label, s] of Object.entries(horizonResults)) console.log(`  ${label}: n=${s.n} median=${s.median} P75=${s.p75} P95=${s.p95} max=${s.max}`);

  const meanOf = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : 'n/a';
  console.log(`Warning correlation (all horizons pooled): warned n=${warningBuckets.warned.length} mean=${meanOf(warningBuckets.warned)}% | unwarned n=${warningBuckets.unwarned.length} mean=${meanOf(warningBuckets.unwarned)}%`);

  return { symbol, candidates, chain, cByT, expirations, spot };
}

// --- Borrow ablation (Step 25) — SYNTHETIC fixture fee rate, IBKR unavailable ---
async function borrowAblation({ symbol, candidates, cByT, expirations, spot }) {
  const SYNTHETIC_FEE_RATE = 0.0075; // 75bp, illustrative only — NOT real IBKR data
  const noBorrowInputs = await buildMarketInputsByExpiration(symbol, expirations, { borrowProvider: notConnectedBorrowProvider });
  const withBorrowInputs = await buildMarketInputsByExpiration(symbol, expirations, { borrowProvider: fixtureBorrowProvider({ [symbol]: { borrow_fee_rate: SYNTHETIC_FEE_RATE } }) });

  const scenarios = scenariosFor(spot, HORIZONS[2]); // STRESS_30D
  const cfgNo = { contractMultiplier: 100, currentUnderlyingPrice: spot, marketInputByExpiration: noBorrowInputs };
  const cfgWith = { contractMultiplier: 100, currentUnderlyingPrice: spot, marketInputByExpiration: withBorrowInputs };

  let sumAbsPriceDiff = 0, sumAbsPnlDiff = 0, n = 0;
  for (const c of candidates) {
    const shadowNo = generateCandidateScenarioResultsCrrShadow(c, scenarios, cByT, cfgNo);
    const shadowWith = generateCandidateScenarioResultsCrrShadow(c, scenarios, cByT, cfgWith);
    for (let i = 0; i < scenarios.length; i++) {
      const a = shadowNo.scenario_results[i], b = shadowWith.scenario_results[i];
      if (!a?.available || !b?.available) continue;
      sumAbsPnlDiff += Math.abs((b.scenario_pnl ?? 0) - (a.scenario_pnl ?? 0));
      n++;
    }
  }
  console.log(`\n[${symbol}] BORROW ABLATION (synthetic ${SYNTHETIC_FEE_RATE * 100}bp fee, STRESS_30D, n=${n}): mean |ΔP&L| = $${n ? (sumAbsPnlDiff / n).toFixed(2) : 'n/a'}`);

  const rankingContext = { downside_scenario_id: scenarios[0].scenario_id, base_scenario_id: scenarios[1].scenario_id, upside_scenario_id: scenarios[2].scenario_id, current_underlying_price: spot, chain_completeness: 'COMPLETE', configured_max_spread_pct: 100 };
  const enrichedNo = candidates.map(c => generateCandidateScenarioResultsCrrShadow(c, scenarios, cByT, cfgNo));
  const enrichedWith = candidates.map(c => generateCandidateScenarioResultsCrrShadow(c, scenarios, cByT, cfgWith));
  const rankNo = rankStrategyCandidates(enrichedNo, rankingContext, cByT, {});
  const rankWith = rankStrategyCandidates(enrichedWith, rankingContext, cByT, {});
  const top5No = rankNo.ranked_candidates.slice(0, 5).map(c => c.candidate_id);
  const top5With = rankWith.ranked_candidates.slice(0, 5).map(c => c.candidate_id);
  const overlap = top5No.filter(id => top5With.includes(id)).length;
  console.log(`[${symbol}] BORROW ABLATION ranking top-5 overlap: ${overlap}/5`);
}

// --- Dividend ablation (Step 26): trailing yield vs a synthetic "IBKR-shaped" forward value ---
async function dividendAblation({ symbol, candidates, cByT, expirations, spot }) {
  if (fx.symbols[symbol].dividend_yield_pct === 0) { console.log(`\n[${symbol}] DIVIDEND ABLATION: skipped (zero-dividend name)`); return; }
  const trailingInputs = await buildMarketInputsByExpiration(symbol, expirations);
  // SYNTHETIC forward-dividend value for ablation only (IBKR unavailable) —
  // illustrative: assume the forward 12m dividend equals trailing yield * spot
  // (i.e. no change), to isolate whether the MODE label alone (forward vs
  // trailing) changes anything when the underlying number is held constant.
  const divYieldPct = fx.symbols[symbol].dividend_yield_pct;
  const forwardMap = new Map();
  for (const [exp, rec] of trailingInputs) {
    const dividend = resolveDividendInput({ mode: DIVIDEND_MODES.FORWARD_ANNUAL_DIVIDEND_APPROXIMATION, spot, expected12mDividendPerShare: (divYieldPct / 100) * spot, source: 'SYNTHETIC_FIXTURE_FOR_ABLATION_ONLY_NOT_LIVE_IBKR' });
    const discount = resolveDiscountRate({ dte: rec.days_to_expiry, billRates: fx.treasury_bill_rates_coupon_equivalent, asOfDate: fx.treasury_bill_rates_observation_date });
    const borrow = toBorrowInput(await notConnectedBorrowProvider(symbol));
    forwardMap.set(exp, buildMarketInputRecord({ expiration: exp, daysToExpiry: rec.days_to_expiry, discount, dividend, borrow }));
  }
  const scenarios = scenariosFor(spot, HORIZONS[2]);
  const cfgTrailing = { contractMultiplier: 100, currentUnderlyingPrice: spot, marketInputByExpiration: trailingInputs };
  const cfgForward = { contractMultiplier: 100, currentUnderlyingPrice: spot, marketInputByExpiration: forwardMap };
  let sumAbsPnlDiff = 0, n = 0;
  for (const c of candidates) {
    const a = generateCandidateScenarioResultsCrrShadow(c, scenarios, cByT, cfgTrailing);
    const b = generateCandidateScenarioResultsCrrShadow(c, scenarios, cByT, cfgForward);
    for (let i = 0; i < scenarios.length; i++) {
      if (!a.scenario_results[i]?.available || !b.scenario_results[i]?.available) continue;
      sumAbsPnlDiff += Math.abs(b.scenario_results[i].scenario_pnl - a.scenario_results[i].scenario_pnl);
      n++;
    }
  }
  console.log(`[${symbol}] DIVIDEND MODE ABLATION (trailing-yield-derived q vs same-magnitude forward-labeled q, STRESS_30D, n=${n}): mean |ΔP&L| = $${n ? (sumAbsPnlDiff / n).toFixed(2) : 'n/a'} (numerically ~0 expected since q is held equal — this isolates that the MODE LABEL alone doesn't change pricing, only real IBKR forward-dividend VALUES would)`);
}

// --- NVDA rank-instability decomposition (Step 27) ---------------------------
async function nvdaDecomposition({ candidates, cByT, expirations, spot }) {
  const scenarios = scenariosFor(spot, HORIZONS[2]); // STRESS_30D, same as Phase 2C's standardized set
  const rankingContext = { downside_scenario_id: scenarios[0].scenario_id, base_scenario_id: scenarios[1].scenario_id, upside_scenario_id: scenarios[2].scenario_id, current_underlying_price: spot, chain_completeness: 'COMPLETE', configured_max_spread_pct: 100 };

  const enrichedLocal = candidates.map(c => generateCandidateScenarioResults(c, scenarios, cByT, { contractMultiplier: 100, currentUnderlyingPrice: spot }));
  const rankLocal = rankStrategyCandidates(enrichedLocal, rankingContext, cByT, {});

  const noBorrow = await buildMarketInputsByExpiration('NVDA', expirations, { borrowProvider: notConnectedBorrowProvider });
  const cfgNoBorrow = { contractMultiplier: 100, currentUnderlyingPrice: spot, marketInputByExpiration: noBorrow };
  const enrichedCrrNoBorrow = candidates.map(c => generateCandidateScenarioResultsCrrShadow(c, scenarios, cByT, cfgNoBorrow));
  const rankCrrNoBorrow = rankStrategyCandidates(enrichedCrrNoBorrow, rankingContext, cByT, {});

  const withBorrow = await buildMarketInputsByExpiration('NVDA', expirations, { borrowProvider: fixtureBorrowProvider({ NVDA: { borrow_fee_rate: 0.0075 } }) });
  const cfgWithBorrow = { contractMultiplier: 100, currentUnderlyingPrice: spot, marketInputByExpiration: withBorrow };
  const enrichedCrrWithBorrow = candidates.map(c => generateCandidateScenarioResultsCrrShadow(c, scenarios, cByT, cfgWithBorrow));
  const rankCrrWithBorrow = rankStrategyCandidates(enrichedCrrWithBorrow, rankingContext, cByT, {});

  function compare(rankA, rankB, label) {
    const top5A = rankA.ranked_candidates.slice(0, 5).map(c => c.candidate_id);
    const top5B = rankB.ranked_candidates.slice(0, 5).map(c => c.candidate_id);
    const overlap = top5A.filter(id => top5B.includes(id)).length;
    const posA = new Map(rankA.ranked_candidates.map((c, i) => [c.candidate_id, i + 1]));
    const posB = new Map(rankB.ranked_candidates.map((c, i) => [c.candidate_id, i + 1]));
    let maxMove = 0, maxMoveId = null;
    const n = rankA.ranked_candidates.length;
    let sumDsq = 0, pairCount = 0;
    for (const id of posA.keys()) {
      if (!posB.has(id)) continue;
      const move = Math.abs(posA.get(id) - posB.get(id));
      if (move > maxMove) { maxMove = move; maxMoveId = id; }
      sumDsq += move * move; pairCount++;
    }
    const spearman = pairCount > 1 ? 1 - (6 * sumDsq) / (pairCount * (pairCount * pairCount - 1)) : null;
    console.log(`  ${label}: top-5 overlap=${overlap}/5 spearman=${spearman?.toFixed(3)} largest_move=${maxMove} (${maxMoveId})`);
  }

  console.log('\n[NVDA] RANK INSTABILITY DECOMPOSITION (STRESS_30D):');
  compare(rankLocal, rankCrrNoBorrow, 'LOCAL -> CRR (no borrow)');
  compare(rankCrrNoBorrow, rankCrrWithBorrow, 'CRR no-borrow -> CRR +synthetic-borrow');
  compare(rankLocal, rankCrrWithBorrow, 'LOCAL -> CRR +synthetic-borrow (total)');
}

const results = {};
for (const symbol of ['NVDA', 'AAPL', 'PANW']) {
  results[symbol] = await runSymbol(symbol);
  await borrowAblation(results[symbol]);
  await dividendAblation(results[symbol]);
}
await nvdaDecomposition(results.NVDA);
