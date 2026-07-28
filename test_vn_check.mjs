// VN Unified Check — Computation tests (Task 3)
// Run: node test_vn_check.mjs
import assert from 'node:assert/strict';
import { classifyVnSetup } from './check_one.mjs';

// ===== buildClosedH6History tests =====

// Helper: create a bar
function bar(close, open, high, low, volume) {
  return { time: 0, open, high, low, close, volume: volume ?? 100000 };
}

// Manual test of buildClosedH6History (imported inline)
import { buildClosedH6History, sma } from './check_one.mjs';

// 101 completed bars + 1 active bar
{
  const completed = [];
  for (let i = 0; i < 101; i++) {
    completed.push(bar(100 + i * 0.1, 99 + i * 0.1, 101 + i * 0.1, 98 + i * 0.1));
  }
  const active = bar(500, 490, 510, 485, 5000000); // 10x volume, extreme price

  const history = buildClosedH6History({ bars: completed, activeBarClosed: true });
  assert.ok(history.sma20 > 0, 'history SMA20 computed');
  assert.ok(history.sma100 > 0, 'history SMA100 computed');
  assert.ok(history.avg_vol_20 > 0, 'history Avg20 computed');

  // Active bar mutation must NOT change history
  const history2 = buildClosedH6History({ bars: completed, activeBarClosed: false, activeBar: active });
  assert.equal(history.sma20, history2.sma20, 'mutating active close must not change SMA20');
  assert.equal(history.sma100, history2.sma100, 'mutating active close must not change SMA100');
  assert.equal(history.avg_vol_20, history2.avg_vol_20, 'mutating active volume must not change Avg20');
  assert.equal(history.structure, history2.structure, 'mutating active must not change structure');
  assert.equal(history.protected_low, history2.protected_low, 'mutating active must not change protected low');
}

// ==== classifyVnSetup setup-path tests =====

// VAH retest requires previousClose > pmVah and current price <= pmVah
{
  const r = classifyVnSetup({
    price: 23800, previousClosedPrice: 24200,
    sma20: 23000, sma100: 22000,
    pmVah: 24000, aboveSma100: true,
  });
  assert.equal(r.setup, 'PM_VAH_PULLBACK_RETEST', 'VAH retest: previous above, current at/below');
}

// VAH retest blocked: previous was already below VAH (no pullback from above)
{
  const r = classifyVnSetup({
    price: 23800, previousClosedPrice: 23800,
    pmVah: 24000, aboveSma100: true,
  });
  assert.notEqual(r.setup, 'PM_VAH_PULLBACK_RETEST', 'previous below VAH → not VAH retest');
}

// VAL reclaim requires previousClose < pmVal and current price >= pmVal
{
  const r = classifyVnSetup({
    price: 23200, previousClosedPrice: 22800,
    sma20: 23000, sma100: 22000,
    pmVal: 23000, aboveSma100: true,
  });
  assert.equal(r.setup, 'PM_VAL_PULLBACK_RECLAIM', 'VAL reclaim: previous below, current at/above');
}

// VAL reclaim blocked: previous was already above VAL (no dip)
{
  const r = classifyVnSetup({
    price: 23200, previousClosedPrice: 23300,
    pmVal: 23000, aboveSma100: true,
  });
  assert.notEqual(r.setup, 'PM_VAL_PULLBACK_RECLAIM', 'previous above VAL → not VAL reclaim');
}

// BREAKOUT_RETEST requires breakoutLevel + breakoutConfirmed (close above level)
{
  const r = classifyVnSetup({
    price: 23500, previousClosedPrice: 23200,
    sma20: 23000, sma100: 22000,
    breakoutLevel: 23400, breakoutConfirmed: true,
    vsaPattern: 'SIGN_OF_STRENGTH', aboveSma100: true,
  });
  assert.equal(r.setup, 'BREAKOUT_RETEST', 'breakout + retest with level confirmation');
}

// BREAKOUT_RETEST blocked: fromLowPct=20 with no breakoutLevel → no setup
{
  const r = classifyVnSetup({
    price: 25000, previousClosedPrice: 20000,
    sma20: 23000, sma100: 22000,
    fromLowPct: 20,  // big move but no breakout level
    vsaPattern: 'SIGN_OF_STRENGTH', aboveSma100: true,
  });
  assert.notEqual(r.setup, 'BREAKOUT_RETEST', 'fromLowPct alone cannot create breakout');
  assert.equal(r.setup, null, 'no breakout = no setup');
}

// BREAKOUT_RETEST blocked: breakout not confirmed
{
  const r = classifyVnSetup({
    price: 23300, previousClosedPrice: 23200,
    breakoutLevel: 23400, breakoutConfirmed: false,
    vsaPattern: 'SIGN_OF_STRENGTH', aboveSma100: true,
  });
  assert.notEqual(r.setup, 'BREAKOUT_RETEST', 'unconfirmed breakout blocked');
}

// ===== SMA20/SMA100/Pullback tests =====

{
  const r = classifyVnSetup({ price: 23500, sma20: 23300, sma100: 22000, structure: 'UPTREND', aboveSma100: true });
  assert.equal(r.setup, 'SMA20_PULLBACK', 'SMA20 pullback');
}

{
  const r = classifyVnSetup({ price: 22500, sma20: 23500, sma100: 22000, structure: 'SIDEWAYS', aboveSma100: true });
  assert.equal(r.setup, 'SMA100_PULLBACK_RECLAIM', 'SMA100 reclaim');
}

{
  const r = classifyVnSetup({ price: 21000, sma20: 22000, sma100: 21500, aboveSma100: false });
  assert.equal(r.setup, null, 'below SMA100 → no setup');
}

// VSA veto
{
  const r = classifyVnSetup({ price: 23500, sma20: 23300, sma100: 22000, structure: 'UPTREND', vsaPattern: 'UPTHRUST', aboveSma100: true });
  assert.equal(r.setup, null, 'UPTHRUST veto');
}

// No price
{
  const r = classifyVnSetup({ price: null, aboveSma100: true });
  assert.equal(r.setup, null, 'no price');
}

console.log('ALL PASS');
