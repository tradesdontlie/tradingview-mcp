// Phase 2B.1 — joint discount-rate + effective-carry live evaluation.
// Diagnostic-only, not wired into production. Run manually:
//   node scripts/phase2b1-joint-carry-live.mjs
//
// Reuses the Phase 2B fixture (single live market session — see report
// Section J for why a second independent snapshot could not be obtained
// this session: a same-day re-pull on 2026-08-30 returned identical
// bid/ask to the 2026-08-29 snapshot, confirming the underlying market
// session had not advanced).
import { readFileSync } from 'node:fs';
import {
  fitRawParityJoint, fitAmericanCorrectedJointCarry, selectCalibrationTier,
  splitCalibrationHoldout, evaluateJointHoldout, classifyJointConfidence,
  checkTermStructureStability,
} from '../src/core/options/marketInputs/jointCarryRegression.js';
import { normalizeTreasuryDiscountRate, normalizeSofrDiscountRate } from '../src/core/options/marketInputs/rateNormalization.js';
import { evaluateHoldoutError } from '../src/core/options/marketInputs/impliedCarry.js';

const fx = JSON.parse(readFileSync(new URL('../docs/fixtures/phase2b-market-inputs-20260829.json', import.meta.url)));

function buildPairs(listKey) {
  const byStrike = new Map();
  for (const c of fx[listKey]) {
    if (!byStrike.has(c.strike)) byStrike.set(c.strike, {});
    byStrike.get(c.strike)[c.type] = { bid: c.bid, ask: c.ask, delta: c.delta, iv: c.iv / 100 };
  }
  const pairs = [];
  for (const [strike, { call, put }] of byStrike) {
    if (call && put) pairs.push({ strike, call, put });
  }
  return pairs;
}

function ratesFor(dte) {
  const t = normalizeTreasuryDiscountRate({ dte, billRates: fx.treasury_bill_rates_coupon_equivalent, asOfDate: fx.treasury_bill_rates_observation_date });
  const s = normalizeSofrDiscountRate({ sofrDecimal: fx.sofr_overnight.rate, asOfDate: fx.sofr_overnight.observation_date });
  return { treasury: t.discount_rate, sofr: s.discount_rate };
}

function runExpiry(symbol, spot, dte, listKey) {
  const allPairs = buildPairs(listKey);
  const { tier, pairs } = selectCalibrationTier(allPairs, { minPairs: 5 });
  const T = dte / 365;
  const rates = ratesFor(dte);

  if (pairs.length < 2) {
    return { symbol, dte, spot, tier, pair_count: pairs.length, insufficient: true, rates };
  }

  const { calibration, holdout } = splitCalibrationHoldout(pairs);
  const calibForFit = calibration.length >= 2 ? calibration : pairs;

  const rawFit = fitRawParityJoint(calibForFit, { spot, timeToExpiryYears: T });
  const correctedFit = fitAmericanCorrectedJointCarry(calibForFit, { spot, timeToExpiryYears: T, initialDiscountRate: rates.treasury, initialCarryYield: 0 });

  const confidence = classifyJointConfidence({
    retainedPairs: correctedFit.retained_pair_count ?? rawFit.retained_pair_count,
    tier, r2: correctedFit.r2 ?? rawFit.r2,
    residualMad: correctedFit.residual_mad ?? rawFit.residual_mad,
    converged: correctedFit.converged, boundHit: correctedFit.bound_hit,
  });

  const holdoutSet = holdout.length ? holdout : pairs;
  // Model A: Treasury r + q=0
  const modelA = evaluateJointHoldout(holdoutSet, { spot, timeToExpiryYears: T, discountRate: rates.treasury, carryYield: 0 });
  // Model C: joint option-implied r + q (American-corrected)
  const modelC = evaluateJointHoldout(holdoutSet, { spot, timeToExpiryYears: T, discountRate: correctedFit.discount_rate, carryYield: correctedFit.effective_carry_yield });

  return {
    symbol, dte, spot, tier, rates, pair_count: pairs.length,
    calib_n: calibForFit.length, holdout_n: holdoutSet.length,
    raw_fit: rawFit, corrected_fit: correctedFit, confidence,
    model_a: modelA, model_c: modelC,
  };
}

function printExpiry(r) {
  console.log(`\n--- ${r.symbol} DTE=${r.dte} spot=${r.spot} tier=${r.tier} pairs=${r.pair_count} ---`);
  if (r.insufficient) { console.log('INSUFFICIENT_PAIRS for joint regression (<2)'); return; }
  console.log(`treasury=${(r.rates.treasury * 100).toFixed(3)}% sofr=${(r.rates.sofr * 100).toFixed(3)}%`);
  console.log(`RAW_PARITY:       r=${(r.raw_fit.discount_rate * 100).toFixed(3)}% q=${(r.raw_fit.effective_carry_yield * 100).toFixed(3)}% R2=${r.raw_fit.r2.toFixed(4)} retained=${r.raw_fit.retained_pair_count}/${r.raw_fit.initial_pair_count} MAD=${r.raw_fit.residual_mad.toFixed(4)}`);
  console.log(`AMERICAN_CORRECTED: r=${(r.corrected_fit.discount_rate * 100).toFixed(3)}% q=${(r.corrected_fit.effective_carry_yield * 100).toFixed(3)}% converged=${r.corrected_fit.converged} iters=${r.corrected_fit.iterations}`);
  console.log(`confidence=${r.confidence}`);
  console.log(`HOLDOUT (n=${r.holdout_n} pairs) Model A (Treasury,q=0): call=${r.model_a.call_mae?.toFixed(3)} put=${r.model_a.put_mae?.toFixed(3)} all=${r.model_a.all_mae?.toFixed(3)} c/p=${r.model_a.cp_ratio?.toFixed(2)}`);
  console.log(`HOLDOUT Model C (joint r,q):              call=${r.model_c.call_mae?.toFixed(3)} put=${r.model_c.put_mae?.toFixed(3)} all=${r.model_c.all_mae?.toFixed(3)} c/p=${r.model_c.cp_ratio?.toFixed(2)}`);
}

console.log('=== PANW (term structure across 3 expiries) ===');
const panw27 = runExpiry('PANW', 371.59, 27, 'PANW_260925');
const panw41 = runExpiry('PANW', 371.59, 41, 'PANW_261009_FROM_PHASE2A1');
const panw48 = runExpiry('PANW', 371.59, 48, 'PANW_261016');
[panw27, panw41, panw48].forEach(printExpiry);

console.log('\nTerm structure discontinuity check:');
const panwPoints = [panw27, panw41, panw48].filter(r => !r.insufficient).map(r => ({
  expiration: `${r.dte}dte`, dte: r.dte,
  option_implied_discount_rate: r.corrected_fit.discount_rate,
  effective_carry_yield: r.corrected_fit.effective_carry_yield,
}));
const discontinuities = checkTermStructureStability(panwPoints);
console.log(discontinuities.length ? JSON.stringify(discontinuities, null, 2) : 'none flagged (thresholds: 150bp r, 150bp q)');

console.log('\n=== AAPL ===');
const aapl41 = runExpiry('AAPL', 319.70, 41, 'AAPL_261009');
printExpiry(aapl41);

console.log('\n=== NVDA ===');
const nvda41 = runExpiry('NVDA', 217.55, 41, 'NVDA_261009');
printExpiry(nvda41);
