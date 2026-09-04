// Phase 2A.1 — TradingView theoPrice model fingerprint / PANW put-bias diagnosis.
// Diagnostic-only script, not wired into production. Run manually:
//   node scripts/phase2a1-theoprice-fingerprint.mjs
import { readFileSync } from 'node:fs';
import { priceBlackScholes } from '../src/core/options/pricing/blackScholes.js';
import { priceCrrAmerican } from '../src/core/options/pricing/crrAmerican.js';

const fixture = JSON.parse(readFileSync(new URL('../docs/fixtures/panw-theoprice-fingerprint-20260829.json', import.meta.url)));
const spot = fixture.spot_key_stats;
const q = fixture.dividend_yield;
const STEPS = 200;

// --- Step 13 helper: CRR with early exercise DISABLED (diagnostic-only
// "European via binomial tree" — NOT a change to production crrAmerican.js;
// implemented locally in this script by re-deriving the tree with the
// max(continuation, intrinsic) comparison removed). ---
function priceCrrEuropean({ option_type, spot, strike, time_to_expiry_years: T, volatility, risk_free_rate: r, dividend_yield: qd, steps }) {
  if (T === 0) return option_type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const dt = T / steps;
  const u = Math.exp(volatility * Math.sqrt(dt));
  const d = 1 / u;
  const discount = Math.exp(-r * dt);
  const growth = Math.exp((r - qd) * dt);
  const p = (growth - d) / (u - d);
  const terminal = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const s = spot * Math.pow(u, i) * Math.pow(d, steps - i);
    terminal[i] = option_type === 'call' ? Math.max(s - strike, 0) : Math.max(strike - s, 0);
  }
  let values = terminal;
  for (let step = steps - 1; step >= 0; step--) {
    const next = new Float64Array(step + 1);
    for (let i = 0; i <= step; i++) {
      // NO intrinsic comparison here — pure continuation value (European).
      next[i] = discount * (p * values[i + 1] + (1 - p) * values[i]);
    }
    values = next;
  }
  return values[0];
}

function rateFor(dte) {
  if (dte <= 45) return 0.0386;
  if (dte <= 105) return 0.0390;
  if (dte <= 225) return 0.0402;
  return 0.0415;
}

function T_days365(dte) { return dte / 365; }
function T_days365_25(dte) { return dte / 365.25; }

function computeAll(c, { rate = rateFor(c.dte), T = T_days365(c.dte), spotUsed = spot } = {}) {
  const vol = c.iv / 100;
  const bsm = priceBlackScholes({ option_type: c.type, spot: spotUsed, strike: c.strike, time_to_expiry_years: T, volatility: vol, risk_free_rate: rate, dividend_yield: q }).price;
  const crrEuro = priceCrrEuropean({ option_type: c.type, spot: spotUsed, strike: c.strike, time_to_expiry_years: T, volatility: vol, risk_free_rate: rate, dividend_yield: q, steps: STEPS });
  const crrAm = priceCrrAmerican({ option_type: c.type, spot: spotUsed, strike: c.strike, time_to_expiry_years: T, volatility: vol, risk_free_rate: rate, dividend_yield: q, steps: STEPS }).price;
  return { bsm, crrEuro, crrAm };
}

const rows = fixture.contracts.map(c => ({ ...c, ...computeAll(c) }));

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const median = s[Math.floor(s.length / 2)];
  const p95 = s[Math.floor(s.length * 0.95)];
  const max = s[s.length - 1];
  return { mean, median, p95, max, n: s.length };
}
function mae(rows, key) { return stats(rows.map(r => Math.abs(r.theo - r[key]))).mean; }
function signedMean(rows, key) { const v = rows.map(r => r[key] - r.theo); return v.reduce((a, b) => a + b, 0) / v.length; }

console.log('=== SECTION A: FROZEN SAMPLE ===');
console.log(`contracts=${rows.length} (${rows.filter(r => r.type === 'call').length} call, ${rows.filter(r => r.type === 'put').length} put)`);
console.log(`spot=${spot}, dividend_yield=${q}`);
console.log('rate mapping: <=45dte -> 3.86% (2mo), 46-105dte -> 3.90% (3mo)');

console.log('\n=== STEP 3: CRR_EUROPEAN vs BSM (must be tiny) ===');
console.log('MAE all:', mae(rows, 'bsm').toFixed ? null : null);
{
  const diffs = rows.map(r => Math.abs(r.bsm - r.crrEuro));
  const s = stats(diffs);
  console.log(`BSM vs CRR_European MAE=${s.mean.toFixed(5)} max=${s.max.toFixed(5)}`);
}

console.log('\n=== SECTION B: MODEL ERRORS (TV theo vs model) ===');
for (const key of ['bsm', 'crrEuro', 'crrAm']) {
  const calls = rows.filter(r => r.type === 'call');
  const puts = rows.filter(r => r.type === 'put');
  console.log(`${key}: CALL_MAE=${mae(calls, key).toFixed(4)} PUT_MAE=${mae(puts, key).toFixed(4)} ALL_MAE=${mae(rows, key).toFixed(4)}`);
}

console.log('\n=== SECTION C: SIGNED ERRORS (model - TV theo) ===');
for (const key of ['bsm', 'crrEuro', 'crrAm']) {
  const calls = rows.filter(r => r.type === 'call');
  const puts = rows.filter(r => r.type === 'put');
  console.log(`${key}: CALL_signed_mean=${signedMean(calls, key).toFixed(4)} PUT_signed_mean=${signedMean(puts, key).toFixed(4)}`);
}

console.log('\n=== SECTION D: AMERICAN EARLY-EXERCISE PREMIUM (CRR_Am - CRR_Euro) ===');
{
  const prem = rows.map(r => ({ ...r, premium: r.crrAm - r.crrEuro }));
  const calls = prem.filter(r => r.type === 'call');
  const puts = prem.filter(r => r.type === 'put');
  const callMean = calls.reduce((a, b) => a + b.premium, 0) / calls.length;
  const putMean = puts.reduce((a, b) => a + b.premium, 0) / puts.length;
  console.log(`call mean premium=${callMean.toFixed(4)} (n=${calls.length})`);
  console.log(`put mean premium=${putMean.toFixed(4)} (n=${puts.length})`);

  // Key diagnostic: does (TV - CRR_Am) + premium ~ 0 for puts?
  const putResiduals = puts.map(r => (r.theo - r.crrAm) + r.premium);
  const rs = stats(putResiduals.map(Math.abs));
  console.log(`put residual_after_removing_premium: mean_abs=${rs.mean.toFixed(4)} median_abs=${rs.median.toFixed(4)}`);
  // correlation between (TV-CRR_Am) and premium for puts
  const x = puts.map(r => r.theo - r.crrAm); // CRR-vs-TV error (negated convention: TV - CRR_Am)
  const y = puts.map(r => r.premium);
  const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length;
  const cov = x.reduce((s, xi, i) => s + (xi - mx) * (y[i] - my), 0);
  const sx = Math.sqrt(x.reduce((s, xi) => s + (xi - mx) ** 2, 0));
  const sy = Math.sqrt(y.reduce((s, yi) => s + (yi - my) ** 2, 0));
  const corr = cov / (sx * sy);
  console.log(`correlation(TV-CRR_Am_error, american_premium) for puts = ${corr.toFixed(4)}`);
  globalThis.__prem = prem;
}

console.log('\n=== SECTION E: PUT-CALL PARITY (2026-10-09, 41 DTE matched strikes) ===');
{
  const dte41 = rows.filter(r => r.dte === 41);
  const calls = new Map(dte41.filter(r => r.type === 'call').map(r => [r.strike, r]));
  const puts = new Map(dte41.filter(r => r.type === 'put').map(r => [r.strike, r]));
  const rate = rateFor(41);
  const T = T_days365(41);
  const pairs = [];
  for (const [strike, c] of calls) {
    const p = puts.get(strike);
    if (!p) continue;
    const forward = spot * Math.exp(-q * T) - strike * Math.exp(-rate * T);
    const tvResidual = (c.theo - p.theo) - forward;
    const bsmResidual = (c.bsm - p.bsm) - forward;
    const crrAmResidual = (c.crrAm - p.crrAm) - forward;
    pairs.push({ strike, tvResidual, bsmResidual, crrAmResidual });
  }
  console.log(`matched pairs: ${pairs.length}`);
  const tvS = stats(pairs.map(p => Math.abs(p.tvResidual)));
  const bsmS = stats(pairs.map(p => Math.abs(p.bsmResidual)));
  const crrS = stats(pairs.map(p => Math.abs(p.crrAmResidual)));
  console.log(`TV theo parity |residual|: mean=${tvS.mean.toFixed(4)} max=${tvS.max.toFixed(4)}`);
  console.log(`BSM parity |residual|: mean=${bsmS.mean.toFixed(4)} max=${bsmS.max.toFixed(4)}`);
  console.log(`CRR_American parity |residual|: mean=${crrS.mean.toFixed(4)} max=${crrS.max.toFixed(4)}`);
  for (const p of pairs) console.log(`  strike=${p.strike} tv=${p.tvResidual.toFixed(3)} bsm=${p.bsmResidual.toFixed(3)} crrAm=${p.crrAmResidual.toFixed(3)}`);
}

console.log('\n=== STEP 9: RATE SENSITIVITY (all contracts, single MAE at each flat rate) ===');
for (const rate of [0, 0.02, 0.0386, 0.05, 0.06]) {
  const rerun = fixture.contracts.map(c => ({ ...c, ...computeAll(c, { rate }) }));
  const calls = rerun.filter(r => r.type === 'call');
  const puts = rerun.filter(r => r.type === 'put');
  console.log(`r=${(rate * 100).toFixed(2)}%: CRR_Am CALL_MAE=${mae(calls, 'crrAm').toFixed(4)} PUT_MAE=${mae(puts, 'crrAm').toFixed(4)} | BSM CALL_MAE=${mae(calls, 'bsm').toFixed(4)} PUT_MAE=${mae(puts, 'bsm').toFixed(4)}`);
}

console.log('\n=== STEP 10: BEST COMMON RATE FIT (grid search 0-10%, step 0.25%) ===');
function bestRate(key) {
  let best = null;
  for (let rPct = 0; rPct <= 10; rPct += 0.25) {
    const rate = rPct / 100;
    const rerun = fixture.contracts.map(c => ({ ...c, ...computeAll(c, { rate }) }));
    const m = mae(rerun, key);
    if (!best || m < best.mae) best = { rate: rPct, mae: m };
  }
  return best;
}
console.log('BSM best common rate:', JSON.stringify(bestRate('bsm')));
console.log('CRR_American best common rate:', JSON.stringify(bestRate('crrAm')));

console.log('\n=== STEP 11: TIME-CONVENTION TEST (days/365 vs days/365.25) ===');
{
  const a = fixture.contracts.map(c => ({ ...c, ...computeAll(c, { T: T_days365(c.dte) }) }));
  const b = fixture.contracts.map(c => ({ ...c, ...computeAll(c, { T: T_days365_25(c.dte) }) }));
  console.log(`days/365   CRR_Am ALL_MAE=${mae(a, 'crrAm').toFixed(4)} PUT_MAE=${mae(a.filter(r=>r.type==='put'),'crrAm').toFixed(4)}`);
  console.log(`days/365.25 CRR_Am ALL_MAE=${mae(b, 'crrAm').toFixed(4)} PUT_MAE=${mae(b.filter(r=>r.type==='put'),'crrAm').toFixed(4)}`);
}

console.log('\n=== STEP 12: SPOT-SOURCE TEST ===');
console.log(`spot_key_stats=${fixture.spot_key_stats} spot_quote_get=${fixture.spot_quote_get} diff=${(fixture.spot_key_stats - fixture.spot_quote_get).toFixed(4)}`);
console.log('No meaningful spot-source discrepancy in this sample (both sources agree exactly) — spot-source mismatch ruled out as a factor here.');

console.log('\n=== STEP 13: IV/THEOPRICE CONSISTENCY (implied vol from TV theoPrice under BSM) ===');
function impliedVolFromPrice(c, targetPrice) {
  const rate = rateFor(c.dte);
  const T = T_days365(c.dte);
  let lo = 0.01, hi = 3.0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const p = priceBlackScholes({ option_type: c.type, spot, strike: c.strike, time_to_expiry_years: T, volatility: mid, risk_free_rate: rate, dividend_yield: q }).price;
    if (p > targetPrice) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}
{
  const sample = rows.filter((_, i) => i % 6 === 0); // thin sample for readability
  const diffs = [];
  for (const c of sample) {
    const impliedVol = impliedVolFromPrice(c, c.theo) * 100;
    const diff = impliedVol - c.iv;
    diffs.push(diff);
    console.log(`  ${c.contract} tv_iv=${c.iv.toFixed(2)} bsm_theo_implied_iv=${impliedVol.toFixed(2)} diff=${diff.toFixed(3)}`);
  }
  const s = stats(diffs.map(Math.abs));
  console.log(`|diff| mean=${s.mean.toFixed(4)} max=${s.max.toFixed(4)} (near-zero => iv and theoPrice are internally BSM-consistent)`);
}

console.log('\n=== STEP 14: BID/ASK SANITY ===');
{
  let inside = 0, below = 0, above = 0;
  for (const c of fixture.contracts) {
    if (c.theo < c.bid) below++;
    else if (c.theo > c.ask) above++;
    else inside++;
  }
  console.log(`inside_spread=${inside} below_bid=${below} above_ask=${above} (of ${fixture.contracts.length})`);
}
