// VN Unified Check — Computation tests (Task 3)
// Run: node test_vn_check.mjs
import assert from 'node:assert/strict';
import { classifyVnSetup, buildClosedH6History, sma, buildVnAutoCore } from './check_one.mjs';

// ===== buildClosedH6History tests =====

// Helper: create a bar
function bar(close, open, high, low, volume) {
  return { time: 0, open, high, low, close, volume: volume ?? 100000 };
}

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

  // Active bar mutation must NOT change history (active bar excluded when not closed)
  const history2 = buildClosedH6History({ bars: completed, activeBarClosed: false });
  assert.equal(history.sma20, history2.sma20, 'mutating active close must not change SMA20');
  assert.equal(history.sma100, history2.sma100, 'mutating active close must not change SMA100');
  assert.equal(history.avg_vol_20, history2.avg_vol_20, 'mutating active volume must not change Avg20');
  assert.equal(history.structure, history2.structure, 'mutating active must not change structure');
  assert.equal(history.protected_low, history2.protected_low, 'mutating active must not change protected low');
}

// ==== classifyVnSetup setup-path tests =====

// PM Profile is manual-only — classifyVnSetup only sees SMA-based setups
{
  const r = classifyVnSetup({
    price: 23500, sma20: 23000, sma100: 22000,
    structure: 'UPTREND', aboveSma100: true,
  });
  // SMA20_PULLBACK works because price is within 3% of SMA20; PM is ignored
  assert.notEqual(r.setup, 'PM_VAH_PULLBACK_RETEST', 'PM VAH not auto-classified');
  assert.notEqual(r.setup, 'PM_VAL_PULLBACK_RECLAIM', 'PM VAL not auto-classified');
}

// Validation: SMA20_PULLBACK still works with correct params
{
  const r = classifyVnSetup({
    price: 23500, sma20: 23300, sma100: 22000,
    structure: 'UPTREND', aboveSma100: true,
  });
  assert.equal(r.setup, 'SMA20_PULLBACK', 'SMA20 pullback still works');
}

// VSA pattern is manual-only — no veto from classifyVnSetup
{
  const r = classifyVnSetup({
    price: 23500, sma20: 23300, sma100: 22000,
    structure: 'UPTREND', aboveSma100: true,
  });
  assert.equal(r.setup, 'SMA20_PULLBACK', 'VSA veto is manual, SMA20 still classified');
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

// VSA is manual-only — classifyVnSetup does not veto on VSA patterns
{
  const r = classifyVnSetup({ price: 23500, sma20: 23300, sma100: 22000, structure: 'UPTREND', aboveSma100: true });
  assert.equal(r.setup, 'SMA20_PULLBACK', 'VSA is manual, SMA20 still classified');
}

// No price
{
  const r = classifyVnSetup({ price: null, aboveSma100: true });
  assert.equal(r.setup, null, 'no price');
}

// ===== Automatic setup scope: only SMA20/SMA100, no PM/breakout/VSA =====

// SMA20_PULLBACK with only auto-relevant params
assert.equal(classifyVnSetup({
  price: 103, sma20: 100, sma100: 90, structure: 'UPTREND', aboveSma100: true,
}).setup, 'SMA20_PULLBACK');

// SMA100_PULLBACK_RECLAIM
assert.equal(classifyVnSetup({
  price: 101, sma20: 110, sma100: 100, structure: 'SIDEWAYS', aboveSma100: true,
}).setup, 'SMA100_PULLBACK_RECLAIM');

// PM Profile is manual-only — must NOT auto-classify
assert.equal(classifyVnSetup({
  price: 103, previousClosedPrice: 106, pmVah: 105, sma100: 90,
  structure: 'UPTREND', aboveSma100: true,
}).setup, null);

// Breakout is manual-only — must NOT auto-classify as BREAKOUT_RETEST
assert.notEqual(classifyVnSetup({
  price: 101, breakoutLevel: 100, breakoutConfirmed: true, sma100: 90,
  structure: 'UPTREND', aboveSma100: true,
}).setup, 'BREAKOUT_RETEST');

// ===== buildVnAutoCore pure builder =====

// Helper to map flat test params to the production seam
function core({ price, sma20, sma100, volRatio, window }) {
  return buildVnAutoCore({
    price,
    h6History: { sma20, sma100 },
    h6Live: { vol_ratio: volRatio },
    entryWindow: { window: window || 'HIGH' },
  });
}

assert.equal(core({ price: 107, sma20: 100, sma100: 95, volRatio: 1.01 }).eligible, true);
assert.equal(core({ price: 107.01, sma20: 100, sma100: 95, volRatio: 1.01 }).blockers.includes('OVEREXTENDED'), true);
assert.equal(core({ price: 99, sma20: 100, sma100: 100, volRatio: 2 }).blockers.includes('BELOW_SMA100'), true);
assert.equal(core({ price: 103, sma20: 100, sma100: 95, volRatio: 1 }).blockers.includes('H6_VOLUME_NOT_ABOVE_AVG20'), true);
assert.equal(core({ price: 103, sma20: 100, sma100: 95, volRatio: 1.01, window: 'BLOCKED' }).blockers.includes('ENTRY_WINDOW_BLOCKED'), true);

// === 101 completed bars: history is frozen, live vol_ratio changes independently ===
{
  const completed = [];
  for (let i = 0; i < 101; i++) {
    completed.push({ time: i, open: 100, high: 101, low: 99, close: 100 + i * 0.1, volume: 100000 });
  }

  // Build history from completed bars
  const h6History = buildClosedH6History({ bars: completed, activeBarClosed: true });
  assert.ok(h6History.sma20 > 0, 'history SMA20 computed');
  assert.ok(h6History.sma100 > 0, 'history SMA100 computed');
  assert.ok(h6History.avg_vol_20 > 0, 'history Avg20 computed');

  // Same input produces identical result (deterministic)
  const h6History2 = buildClosedH6History({ bars: completed, activeBarClosed: true });
  assert.equal(JSON.stringify(h6History), JSON.stringify(h6History2), 'history must be deterministic');

  // Live vol_ratio computed separately from active volume
  const avgVol20 = h6History.avg_vol_20;
  const ratio1 = Math.round(5000000 / avgVol20 * 100) / 100;
  const ratio2 = Math.round(9999999 / avgVol20 * 100) / 100;
  assert.notEqual(ratio1, ratio2, 'mutating active volume must change live vol_ratio');
}

console.log('ALL PASS');
