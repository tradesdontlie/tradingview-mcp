// VN Unified Check — Computation tests (updated for review fixes)
// Run: node test_vn_check.mjs
import assert from 'node:assert/strict';
import { classifyVnSetup } from './check_one.mjs';

// SMA20_PULLBACK: price near SMA20, uptrend
{
  const r = classifyVnSetup({ price: 23500, sma20: 23300, sma100: 22000, structure: 'UPTREND', aboveSma100: true });
  assert.equal(r.setup, 'SMA20_PULLBACK', 'SMA20 pullback trong uptrend');
  assert.ok(r.zone_low < r.zone_high);
}

// SMA20_PULLBACK: >3% from SMA20 = not SMA20 pullback
{
  const r = classifyVnSetup({ price: 24500, sma20: 23300, sma100: 22000, structure: 'UPTREND', aboveSma100: true });
  assert.notEqual(r.setup, 'SMA20_PULLBACK', '>3% tu SMA20 -> khong phai SMA20 pullback');
}

// SMA100_PULLBACK_RECLAIM: SMA20 far away
{
  const r = classifyVnSetup({ price: 22500, sma20: 23500, sma100: 22000, structure: 'SIDEWAYS', aboveSma100: true });
  assert.equal(r.setup, 'SMA100_PULLBACK_RECLAIM', 'SMA100 reclaim khi SMA20 xa');
  assert.ok(r.zone_low < r.zone_high);
}

// SMA100_PULLBACK_RECLAIM: SMA20 too close -> prefers SMA20 if uptrend
{
  const r = classifyVnSetup({ price: 22200, sma20: 22100, sma100: 22000, structure: 'UPTREND', aboveSma100: true });
  assert.equal(r.setup, 'SMA20_PULLBACK', 'SMA20 gan + uptrend -> SMA20 pullback');
}

// PM_VAH_PULLBACK_RETEST: price must be at or below VAH for retest
{
  const r = classifyVnSetup({ price: 23800, pmPoc: 23500, pmVah: 23900, pmVal: 23000, aboveSma100: true });
  assert.equal(r.setup, 'PM_VAH_PULLBACK_RETEST', 'PM VAH retest');
  assert.ok(r.zone_low <= r.zone_high);
  assert.ok(r.zone_high <= 23900, 'zone_high <= VAH');
}

// PM_VAL_PULLBACK_RECLAIM
{
  const r = classifyVnSetup({ price: 23200, pmPoc: 24000, pmVah: 24500, pmVal: 23000, aboveSma100: true });
  assert.equal(r.setup, 'PM_VAL_PULLBACK_RECLAIM', 'PM VAL reclaim');
  // Zone must be at or above VAL for reclaim
  assert.ok(r.zone_low >= 23000, 'zone_low >= VAL');
}

// BREAKOUT_RETEST: needs fromLowPct >= 5% AND valid VSA pattern
{
  const r = classifyVnSetup({ price: 25000, sma20: 24000, sma100: 22000, fromLowPct: 8, vsaPattern: 'SIGN_OF_STRENGTH', aboveSma100: true });
  assert.equal(r.setup, 'BREAKOUT_RETEST', 'breakout retest with VSA confirmation');
}

// BREAKOUT_RETEST: fromLowPct < 5% -> rejected
{
  const r = classifyVnSetup({ price: 24000, sma20: 23500, sma100: 22000, fromLowPct: 3, vsaPattern: 'SIGN_OF_STRENGTH', aboveSma100: true });
  assert.notEqual(r.setup, 'BREAKOUT_RETEST', 'fromLowPct < 5% -> khong phai BREAKOUT');
}

// BREAKOUT_RETEST: no VSA pattern -> rejected
{
  const r = classifyVnSetup({ price: 25000, sma20: 24000, sma100: 22000, fromLowPct: 8, vsaPattern: null, aboveSma100: true });
  assert.notEqual(r.setup, 'BREAKOUT_RETEST', 'khong co VSA pattern -> rejected');
}

// VSA veto blocks all setups
{
  const r = classifyVnSetup({ price: 23500, sma20: 23300, sma100: 22000, structure: 'UPTREND', vsaPattern: 'UPTHRUST', aboveSma100: true });
  assert.equal(r.setup, null, 'UPTHRUST veto blocks all');
}

// Below SMA100 -> no setup
{
  const r = classifyVnSetup({ price: 21000, sma20: 22000, sma100: 21500, structure: 'UPTREND', aboveSma100: false });
  assert.equal(r.setup, null, 'duoi SMA100 -> khong co setup');
}

// No price
{
  const r = classifyVnSetup({ price: null, sma20: 23300, aboveSma100: true });
  assert.equal(r.setup, null, 'thieu price -> null');
}

// Profile setup below SMA100 blocked
{
  const r = classifyVnSetup({ price: 23800, pmPoc: 24000, pmVah: 24500, pmVal: 23500, aboveSma100: false });
  assert.equal(r.setup, null, 'PM setup duoi SMA100 bi chan');
}

// Overextended case: price far above both MAs → still can have SMA setup
{
  const r = classifyVnSetup({ price: 27000, sma20: 24000, sma100: 22000, structure: 'UPTREND', aboveSma100: true });
  assert.equal(r.setup, null, 'SMA20 >3% xa -> khong SMA20_PULLBACK, SMA100 >5% -> khong SMA100 reclaim');
}

// Non-VSA pattern in VSA_BREAKOUT_OK list → BREAKOUT_RETEST works
{
  const r = classifyVnSetup({ price: 25000, sma20: 24000, sma100: 22000, fromLowPct: 7, vsaPattern: 'EFFORT_TO_RISE', aboveSma100: true });
  assert.equal(r.setup, 'BREAKOUT_RETEST', 'EFFORT_TO_RISE triggers BREAKOUT_RETEST');
}

console.log('ALL PASS');
