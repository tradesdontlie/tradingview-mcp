// VN Unified Check — Computation tests
// Run: node test_vn_check.mjs
import assert from 'node:assert/strict';
import { classifyVnSetup } from './check_one.mjs';

// ============ TESTS ============

// SMA20_PULLBACK
{
  const r = classifyVnSetup({ price: 23500, sma20: 23300, sma100: 22000, structure: 'UPTREND' });
  assert.equal(r.setup, 'SMA20_PULLBACK', 'SMA20 pullback trong uptrend');
  assert.ok(r.zone_low < r.zone_high);
}

// SMA20_PULLBACK: >3% from SMA20 = not SMA20 pullback
{
  const r = classifyVnSetup({ price: 24500, sma20: 23300, sma100: 22000, structure: 'UPTREND' });
  assert.notEqual(r.setup, 'SMA20_PULLBACK', '>3% tu SMA20 -> khong phai SMA20 pullback');
}

// SMA100_PULLBACK_RECLAIM
{
  const r = classifyVnSetup({ price: 22500, sma20: 23500, sma100: 22000, structure: 'SIDEWAYS' });
  assert.equal(r.setup, 'SMA100_PULLBACK_RECLAIM', 'SMA100 reclaim khi SMA20 xa');
  assert.ok(r.zone_low < r.zone_high);
}

// SMA100_PULLBACK_RECLAIM: SMA20 too close -> prefers SMA20
{
  const r = classifyVnSetup({ price: 22200, sma20: 22100, sma100: 22000, structure: 'SIDEWAYS' });
  assert.notEqual(r.setup, 'SMA100_PULLBACK_RECLAIM', 'SMA20 gan -> khong phai SMA100 reclaim');
}

// PM_VAH_PULLBACK_RETEST
{
  const r = classifyVnSetup({ price: 24000, pmPoc: 23500, pmVah: 23900, pmVal: 23000 });
  assert.equal(r.setup, 'PM_VAH_PULLBACK_RETEST', 'PM VAH retest');
}

// PM_VAL_PULLBACK_RECLAIM
{
  const r = classifyVnSetup({ price: 23200, pmPoc: 24000, pmVah: 24500, pmVal: 23000 });
  assert.equal(r.setup, 'PM_VAL_PULLBACK_RECLAIM', 'PM VAL reclaim');
}

// BREAKOUT_RETEST
{
  const r = classifyVnSetup({ price: 24000, sma20: 23500, sma100: 22000, fromLowPct: 5, structure: 'UPTREND' });
  assert.equal(r.setup, 'BREAKOUT_RETEST', 'breakout retest');
}

// BREAKOUT_RETEST: fromLowPct too small
{
  const r = classifyVnSetup({ price: 24000, sma20: 23500, sma100: 22000, fromLowPct: 1, structure: 'UPTREND' });
  assert.notEqual(r.setup, 'BREAKOUT_RETEST', 'fromLowPct qua nho -> khong phai BREAKOUT');
}

// No setup
{
  const r = classifyVnSetup({ price: 30000, sma20: 25000, sma100: 21000 });
  assert.equal(r.setup, null, 'gia qua xa -> khong co setup');
}

// No price
{
  const r = classifyVnSetup({ price: null, sma20: 23300 });
  assert.equal(r.setup, null, 'thieu price -> null');
}

console.log('ALL PASS');
