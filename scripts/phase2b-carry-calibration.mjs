// Phase 2B — market input & implied carry live calibration (Steps 15-19).
// Diagnostic-only script, not wired into production. Run manually:
//   node scripts/phase2b-carry-calibration.mjs
import { readFileSync } from 'node:fs';
import { normalizeTreasuryDiscountRate, normalizeSofrDiscountRate } from '../src/core/options/marketInputs/rateNormalization.js';
import { extractMatchedPairs, calibrationMid, syntheticForwardEstimate, effectiveCarryFromForward, robustCrossStrikeCarry } from '../src/core/options/marketInputs/impliedForward.js';
import { classifyCarryConfidence, fitCrrImpliedCarry, evaluateHoldoutError, compareCarryEstimators } from '../src/core/options/marketInputs/impliedCarry.js';
import { priceCrrAmerican } from '../src/core/options/pricing/crrAmerican.js';

const fx = JSON.parse(readFileSync(new URL('../docs/fixtures/phase2b-market-inputs-20260829.json', import.meta.url)));

function contractsFor(list) {
  return fx[list].map(c => ({ option_type: c.type, expiration: '2026-EXPIRY', strike: c.strike, bid: c.bid, ask: c.ask, delta: c.delta, iv: c.iv / 100 }));
}

function discountRateFor(dte) {
  const t = normalizeTreasuryDiscountRate({ dte, billRates: fx.treasury_bill_rates_coupon_equivalent, asOfDate: fx.treasury_bill_rates_observation_date });
  const s = normalizeSofrDiscountRate({ sofrDecimal: fx.sofr_overnight.rate, asOfDate: fx.sofr_overnight.observation_date });
  return { treasury: t.discount_rate, sofr: s.discount_rate };
}

function analyzeExpiry(symbol, spot, dte, listKey, maxSpreadPctForPairs = 5) {
  const contracts = contractsFor(listKey);
  const rates = discountRateFor(dte);
  const T = dte / 365;

  const pairsAt = (maxSpreadPct, deltaWindows) => extractMatchedPairs(contracts, { maxSpreadPct, ...(deltaWindows || {}) });
  const pairsDefault = pairsAt(maxSpreadPctForPairs);
  const pairsWidened = pairsAt(20); // diagnostic-only widened threshold, labeled explicitly

  function computeParityQ(pairs, rate) {
    const estimates = pairs.map(p => {
      const callMid = calibrationMid(p.call), putMid = calibrationMid(p.put);
      const { forward_estimate } = syntheticForwardEstimate({ strike: p.strike, callMid, putMid, discountRate: rate, timeToExpiryYears: T });
      const q_eff = effectiveCarryFromForward({ spot, forward: forward_estimate, discountRate: rate, timeToExpiryYears: T });
      const width = (p.call.ask - p.call.bid) + (p.put.ask - p.put.bid);
      return { q_eff, weight: 1 / Math.max(width, 1e-6), strike: p.strike };
    });
    return { estimates, robust: robustCrossStrikeCarry(estimates) };
  }

  const parity = computeParityQ(pairsWidened, rates.treasury);
  const meanSpreadPct = pairsWidened.length
    ? pairsWidened.reduce((s, p) => s + (((p.call.ask - p.call.bid) / ((p.call.ask + p.call.bid) / 2)) + ((p.put.ask - p.put.bid) / ((p.put.ask + p.put.bid) / 2))) / 2 * 100, 0) / pairsWidened.length
    : null;
  const confidence = pairsWidened.length ? classifyCarryConfidence({ pairCount: pairsWidened.length, mad: parity.robust.mad, meanSpreadPct }) : 'LOW';

  // Calibration/holdout split: near-ATM (smallest |strike-spot|) half = calibration, rest = holdout.
  const sortedByMoneyness = [...pairsWidened].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const half = Math.ceil(sortedByMoneyness.length / 2);
  const calibPairs = sortedByMoneyness.slice(0, half);
  const holdoutPairs = sortedByMoneyness.slice(half);

  function pairsToQuotes(pairs) {
    const quotes = [];
    for (const p of pairs) {
      quotes.push({ option_type: 'call', strike: p.strike, iv: p.call.delta != null ? contracts.find(c => c.strike === p.strike && c.option_type === 'call').iv : null, mid: calibrationMid(p.call) });
      quotes.push({ option_type: 'put', strike: p.strike, iv: contracts.find(c => c.strike === p.strike && c.option_type === 'put').iv, mid: calibrationMid(p.put) });
    }
    return quotes;
  }
  const calibQuotes = pairsToQuotes(calibPairs);
  const holdoutQuotes = holdoutPairs.length ? pairsToQuotes(holdoutPairs) : pairsToQuotes(calibPairs); // fallback if too few pairs to split

  let crrFit = null;
  if (calibQuotes.length >= 2) {
    crrFit = fitCrrImpliedCarry(calibQuotes, { spot, discountRate: rates.treasury, timeToExpiryYears: T, steps: 200 });
  }

  const models = {
    q0: evaluateHoldoutError(holdoutQuotes, 0, { spot, discountRate: rates.treasury, timeToExpiryYears: T }),
    parityQ: evaluateHoldoutError(holdoutQuotes, parity.robust.median_q, { spot, discountRate: rates.treasury, timeToExpiryYears: T }),
    crrFitQ: crrFit ? evaluateHoldoutError(holdoutQuotes, crrFit.best_q, { spot, discountRate: rates.treasury, timeToExpiryYears: T }) : null,
  };

  const cmp = crrFit ? compareCarryEstimators(parity.robust.median_q, crrFit.best_q) : null;

  return {
    symbol, dte, spot, rates, pair_count_default5pct: pairsDefault.length, pair_count_widened20pct: pairsWidened.length,
    parity_q_median: parity.robust.median_q, parity_dispersion: parity.robust, confidence,
    crr_fit: crrFit, compare: cmp, models, calib_n: calibQuotes.length, holdout_n: holdoutQuotes.length,
  };
}

function printResult(r) {
  console.log(`\n--- ${r.symbol} DTE=${r.dte} spot=${r.spot} ---`);
  console.log(`treasury_rate=${(r.rates.treasury * 100).toFixed(3)}% sofr_rate=${(r.rates.sofr * 100).toFixed(3)}%`);
  console.log(`pairs @5% default=${r.pair_count_default5pct} @20% widened(diagnostic)=${r.pair_count_widened20pct}`);
  if (r.pair_count_widened20pct === 0) { console.log('INSUFFICIENT_PAIRS — no carry estimate possible'); return; }
  console.log(`parity_q_median=${(r.parity_q_median * 100).toFixed(3)}% MAD=${r.parity_dispersion.mad.toFixed(4)} min=${r.parity_dispersion.min.toFixed(4)} max=${r.parity_dispersion.max.toFixed(4)} confidence=${r.confidence}`);
  if (r.crr_fit) {
    console.log(`crr_fit_q=${(r.crr_fit.best_q * 100).toFixed(3)}% objective=${r.crr_fit.objective_value.toFixed(4)} pairs_used(calib)=${r.calib_n / 2}`);
    console.log(`estimator diff=${r.compare.diff_bps.toFixed(1)}bps warnings=${r.compare.warnings.join(',') || 'none'}`);
  }
  console.log(`HOLDOUT (n=${r.holdout_n / 2} pairs): model=q0        call_mae=${r.models.q0.call_mae?.toFixed(3)} put_mae=${r.models.q0.put_mae?.toFixed(3)} all_mae=${r.models.q0.all_mae?.toFixed(3)}`);
  console.log(`HOLDOUT: model=parity_q  call_mae=${r.models.parityQ.call_mae?.toFixed(3)} put_mae=${r.models.parityQ.put_mae?.toFixed(3)} all_mae=${r.models.parityQ.all_mae?.toFixed(3)}`);
  if (r.models.crrFitQ) console.log(`HOLDOUT: model=crr_fit_q call_mae=${r.models.crrFitQ.call_mae?.toFixed(3)} put_mae=${r.models.crrFitQ.put_mae?.toFixed(3)} all_mae=${r.models.crrFitQ.all_mae?.toFixed(3)}`);
}

console.log('=== PANW (primary) ===');
const panw27 = analyzeExpiry('PANW', 371.59, 27, 'PANW_260925');
const panw41 = analyzeExpiry('PANW', 371.59, 41, 'PANW_261009_FROM_PHASE2A1');
const panw48 = analyzeExpiry('PANW', 371.59, 48, 'PANW_261016');
printResult(panw27); printResult(panw41); printResult(panw48);

console.log('\n=== AAPL ===');
const aapl41 = analyzeExpiry('AAPL', 319.70, 41, 'AAPL_261009');
printResult(aapl41);
console.log(`(for interpretation only — known dividend_yield_pct ≈ 0.334%, NOT forced into the estimator)`);

console.log('\n=== NVDA ===');
const nvda41 = analyzeExpiry('NVDA', 217.55, 41, 'NVDA_261009');
printResult(nvda41);

console.log('\n=== STEP 19: RATE-SOURCE SENSITIVITY (Treasury vs SOFR anchor, PANW 41dte) ===');
{
  const dte = 41, spot = 371.59, T = dte / 365;
  const contracts = contractsFor('PANW_261009_FROM_PHASE2A1');
  const pairs = extractMatchedPairs(contracts, { maxSpreadPct: 20 });
  for (const [label, rate] of [['treasury', panw41.rates.treasury], ['sofr', panw41.rates.sofr]]) {
    const estimates = pairs.map(p => {
      const callMid = calibrationMid(p.call), putMid = calibrationMid(p.put);
      const { forward_estimate } = syntheticForwardEstimate({ strike: p.strike, callMid, putMid, discountRate: rate, timeToExpiryYears: T });
      const q_eff = effectiveCarryFromForward({ spot, forward: forward_estimate, discountRate: rate, timeToExpiryYears: T });
      return { q_eff, weight: 1 };
    });
    const robust = robustCrossStrikeCarry(estimates);
    console.log(`${label}: rate=${(rate * 100).toFixed(3)}% median_q=${(robust.median_q * 100).toFixed(3)}% mad=${robust.mad.toFixed(4)}`);
  }
}
