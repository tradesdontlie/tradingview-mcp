// Phase 2A — CRR convergence & performance benchmark (Steps 10-11).
// Not part of the test suite / not wired into any tool. Run manually:
//   node scripts/benchmark-crr-american.mjs
import { priceCrrAmerican } from '../src/core/options/pricing/crrAmerican.js';

const FIXTURES = [
  { label: 'ATM put, no div', params: { option_type: 'put', spot: 100, strike: 100, time_to_expiry_years: 0.5, volatility: 0.3, risk_free_rate: 0.045, dividend_yield: 0 } },
  { label: 'ITM call, div-bearing', params: { option_type: 'call', spot: 150, strike: 130, time_to_expiry_years: 0.25, volatility: 0.35, risk_free_rate: 0.045, dividend_yield: 0.008 } },
  { label: 'OTM put, div-bearing', params: { option_type: 'put', spot: 220, strike: 190, time_to_expiry_years: 0.16, volatility: 0.4, risk_free_rate: 0.045, dividend_yield: 0.005 } },
];

const STEP_COUNTS = [50, 100, 200, 400, 800, 1600];

console.log('=== CONVERGENCE STUDY ===');
for (const fixture of FIXTURES) {
  console.log(`\n-- ${fixture.label} --`);
  const prices = [];
  const times = [];
  for (const steps of STEP_COUNTS) {
    const t0 = performance.now();
    const { price } = priceCrrAmerican({ ...fixture.params, steps });
    const t1 = performance.now();
    prices.push(price);
    times.push(t1 - t0);
  }
  const reference = prices[prices.length - 1];
  console.log('steps\tprice\t\tdiff_vs_1600\ttime_ms');
  for (let i = 0; i < STEP_COUNTS.length; i++) {
    console.log(`${STEP_COUNTS[i]}\t${prices[i].toFixed(6)}\t${Math.abs(prices[i] - reference).toFixed(6)}\t${times[i].toFixed(3)}`);
  }
}

console.log('\n=== THROUGHPUT ===');
const perfFixture = FIXTURES[0].params;
for (const steps of [100, 200, 400]) {
  for (const n of [1, 100, 500]) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) priceCrrAmerican({ ...perfFixture, steps });
    const t1 = performance.now();
    const total = t1 - t0;
    console.log(`steps=${steps} n=${n}: total=${total.toFixed(2)}ms avg=${(total / n).toFixed(4)}ms`);
  }
}
