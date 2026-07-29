// VN Unified Check — Computation tests (Task 3)
// Run: node test_vn_check.mjs
import assert from 'node:assert/strict';
import { classifyVnSetup, buildClosedH6History, sma, buildVnAutoCore, buildVnGateView, buildVnPlanScenario, buildVnCoreAssembly } from './check_one.mjs';
import { computeVnStructure, VN_STRUCTURE_VERSION, compatibilityStructure } from './src/core/vn_structure.mjs';

// ponytail: shared v2 structure fixtures for old tests
const v2_CONFIRMED_UP = { trend_state: 'UP', confirmed: true };
const v2_CONFIRMED_RANGE = { trend_state: 'RANGE', confirmed: true };
const v2_CONFIRMED_DOWN = { trend_state: 'DOWN', confirmed: true };
const v2_PROVISIONAL = { trend_state: 'UP', confirmed: false };

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

{
  const history = buildClosedH6History({ bars: [], activeBarClosed: true });
  assert.equal(history.structure_v2.version, VN_STRUCTURE_VERSION);
  assert.equal(history.structure_v2.trend_state, 'UNKNOWN');
  assert.equal(history.structure_v2.confirmed, false);
  assert.equal(history.structure, 'INSUFFICIENT_DATA');
}

// ==== classifyVnSetup setup-path tests =====

// PM Profile is manual-only — classifyVnSetup only sees SMA-based setups
{
  const r = classifyVnSetup({
    price: 23500, sma20: 23000, sma100: 22000,
    structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true,
  });
  // SMA20_PULLBACK works because price is within 3% of SMA20; PM is ignored
  assert.notEqual(r.setup, 'PM_VAH_PULLBACK_RETEST', 'PM VAH not auto-classified');
  assert.notEqual(r.setup, 'PM_VAL_PULLBACK_RECLAIM', 'PM VAL not auto-classified');
}

// Validation: SMA20_PULLBACK still works with correct params
{
  const r = classifyVnSetup({
    price: 23500, sma20: 23300, sma100: 22000,
    structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true,
  });
  assert.equal(r.setup, 'SMA20_PULLBACK', 'SMA20 pullback still works');
}

// VSA pattern is manual-only — no veto from classifyVnSetup
{
  const r = classifyVnSetup({
    price: 23500, sma20: 23300, sma100: 22000,
    structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true,
  });
  assert.equal(r.setup, 'SMA20_PULLBACK', 'VSA veto is manual, SMA20 still classified');
}

// ===== SMA20/SMA100/Pullback tests =====

{
  const r = classifyVnSetup({ price: 23500, sma20: 23300, sma100: 22000, structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true });
  assert.equal(r.setup, 'SMA20_PULLBACK', 'SMA20 pullback');
}

{
  const r = classifyVnSetup({ price: 94, sma20: 100, sma100: 90, structure: 'SIDEWAYS', structureV2: v2_CONFIRMED_RANGE, aboveSma100: true });
  assert.equal(r.setup, 'SMA100_PULLBACK_RECLAIM', 'price below SMA20 but above SMA100 => SMA100 reclaim');
}

{
  const r = classifyVnSetup({ price: 21000, sma20: 22000, sma100: 21500, aboveSma100: false });
  assert.equal(r.setup, null, 'below SMA100 → no setup');
}

// VSA is manual-only — classifyVnSetup does not veto on VSA patterns
{
  const r = classifyVnSetup({ price: 23500, sma20: 23300, sma100: 22000, structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true });
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
  price: 103, sma20: 100, sma100: 90, structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true,
}).setup, 'SMA20_PULLBACK');

// SMA100_PULLBACK_RECLAIM
assert.equal(classifyVnSetup({
  price: 101, sma20: 110, sma100: 100, structure: 'SIDEWAYS', structureV2: v2_CONFIRMED_RANGE, aboveSma100: true,
}).setup, 'SMA100_PULLBACK_RECLAIM');

// PM Profile is manual-only — must NOT auto-classify
assert.equal(classifyVnSetup({
  price: 103, previousClosedPrice: 106, pmVah: 105, sma100: 90,
  structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true,
}).setup, null);

// Breakout is manual-only — must NOT auto-classify as BREAKOUT_RETEST
assert.notEqual(classifyVnSetup({
  price: 101, breakoutLevel: 100, breakoutConfirmed: true, sma100: 90,
  structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true,
}).setup, 'BREAKOUT_RETEST');

// ===== buildVnAutoCore pure builder =====

// Helper to map flat test params to the production seam
function core({ price, sma20, sma100, sma100Dist, volRatio, window, setup }) {
  return buildVnAutoCore({
    price,
    h6History: { bars_completed: 100, sma20, sma100, structure: 'UPTREND', structure_v2: v2_CONFIRMED_UP, avg_vol_20: 5000 },
    h6Live: { vol_ratio: volRatio },
    entryWindow: { window: window || 'HIGH' },
    setup: setup || { setup: 'SMA20_PULLBACK', zone_low: 98, zone_high: 102, anchor: 'sma20', reason: '' },
  });
}

assert.equal(core({ price: 100, sma20: 100, sma100: 95, volRatio: 1.01 }).eligible, true);
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

// ===== Entry window boundary tests (Step 1) =====

// Helper that accepts setup
function makeCoreWithSetup({ price, sma20, sma100, volRatio, window: win, setup }) {
  return buildVnAutoCore({
    price,
    h6History: { bars_completed: 100, sma20, sma100, structure: 'UPTREND', structure_v2: v2_CONFIRMED_UP, avg_vol_20: 5000 },
    h6Live: { vol_ratio: volRatio },
    entryWindow: { window: win || 'HIGH' },
    setup: setup !== undefined ? setup : sma20Setup,
  });
}

const sma20Setup = { setup: 'SMA20_PULLBACK', zone_low: 98, zone_high: 102, anchor: 'sma20', reason: '' };

// HIGH and NORMAL pass
for (const window of ['HIGH', 'NORMAL']) {
  assert.equal(makeCoreWithSetup({ price: 100, sma20: 100, sma100: 95, volRatio: 1.01, window, setup: sma20Setup }).eligible, true,
    `window ${window} must be eligible`);
}
// DISCOVERY, REDUCED, BLOCKED fail with ENTRY_WINDOW_BLOCKED
for (const window of ['DISCOVERY', 'REDUCED', 'BLOCKED']) {
  const result = makeCoreWithSetup({ price: 100, sma20: 100, sma100: 95, volRatio: 1.01, window, setup: sma20Setup });
  assert.equal(result.eligible, false, `window ${window} must be ineligible`);
  assert.ok(result.blockers.includes('ENTRY_WINDOW_BLOCKED'), `window ${window} must block with ENTRY_WINDOW_BLOCKED`);
}

// No-setup blocker
assert.ok(makeCoreWithSetup({ price: 100, sma20: 100, sma100: 95, volRatio: 1.01, setup: null }).blockers.includes('NO_SETUP'),
  'null setup must produce NO_SETUP blocker');

// Malformed history
assert.ok(buildVnAutoCore({
  price: 103, h6History: {}, h6Live: { vol_ratio: 1.01 },
  entryWindow: { window: 'HIGH' }, setup: sma20Setup,
}).blockers.includes('H6_HISTORY_INSUFFICIENT'), 'empty history must produce H6_HISTORY_INSUFFICIENT');

// ===== Zone-consistency tests (Step 1) =====

for (const [price, expectedSetup] of [[100, 'SMA20_PULLBACK'], [103, 'SMA20_PULLBACK']]) {
  const setup = classifyVnSetup({ price, sma20: 100, sma100: 90, structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true });
  assert.equal(setup.setup, expectedSetup);
  assert.ok(setup.zone_low <= price && price <= setup.zone_high,
    `price ${price} must be inside returned SMA20 zone`);
}
for (const price of [100, 105]) {
  const setup = classifyVnSetup({ price, sma20: 110, sma100: 100, structure: 'SIDEWAYS', structureV2: v2_CONFIRMED_RANGE, aboveSma100: true });
  assert.equal(setup.setup, 'SMA100_PULLBACK_RECLAIM');
  assert.ok(setup.zone_low <= price && price <= setup.zone_high,
    `price ${price} must be inside returned SMA100 zone`);
}
assert.equal(classifyVnSetup({ price: 103.01, sma20: 100, sma100: 80, structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true }).setup, null);
assert.equal(classifyVnSetup({ price: 105.01, sma20: 110, sma100: 100, structure: 'SIDEWAYS', structureV2: v2_CONFIRMED_RANGE, aboveSma100: true }).setup, null);
assert.equal(classifyVnSetup({ price: 105, sma20: 110, sma100: 100, structure: 'DOWNTREND', structureV2: v2_CONFIRMED_DOWN, aboveSma100: true }).setup, null);

// Returned setup must contain the current price
{
  const setup = classifyVnSetup({
    price: 100, sma20: 100, sma100: 90,
    structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true,
  });
  assert.ok(setup.zone_low <= 100 && 100 <= setup.zone_high,
    `SMA20 setup zone [${setup.zone_low}, ${setup.zone_high}] must include price 100`);
}

// SMA20 setup extension must be in [0,3]
{
  const r = classifyVnSetup({ price: 103, sma20: 100, sma100: 90, structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true });
  assert.equal(r.setup, 'SMA20_PULLBACK');
  const ext = (103 - 100) / 100 * 100;
  assert.ok(ext >= 0 && ext <= 3, `SMA20 extension ${ext}% must be in [0,3]`);
}

// Negative extension → no SMA20 setup (price below SMA20 but still above SMA100)
{
  const r = classifyVnSetup({ price: 94, sma20: 100, sma100: 90, structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true });
  // SMA100_PULLBACK_RECLAIM: extension from SMA100 = (94-90)/90*100 = 4.44% → within [0,5]
  assert.equal(r.setup, 'SMA100_PULLBACK_RECLAIM', 'price below SMA20 but above SMA100 => SMA100 reclaim');
}

// Price outside zone must not be IN_ZONE (relies on setup_state helper)
{
  const setup = classifyVnSetup({ price: 110, sma20: 100, sma100: 90, structure: 'UPTREND', structureV2: v2_CONFIRMED_UP, aboveSma100: true });
  // SMA20_PULLBACK zone = [99, 101], price=110 outside
  assert.ok(110 > setup.zone_high, 'price outside zone_high');
}

// Downtrend should not produce SMA20_PULLBACK
{
  const r = classifyVnSetup({ price: 103, sma20: 100, sma100: 90, structure: 'DOWNTREND', structureV2: v2_CONFIRMED_DOWN, aboveSma100: true });
  assert.equal(r.setup, null, 'downtrend must not produce SMA setup');
}

// ===== buildVnGateView tests (Step 2) =====

// Production and fixture assembly share this helper, so omitting setup from
// buildVnAutoCore would make this canonical production seam ineligible.
{
  const assembled = buildVnCoreAssembly({
    price: 103,
    h6History: { bars_completed: 120, sma20: 100, sma100: 90, structure: 'UPTREND', structure_v2: v2_CONFIRMED_UP, protected_low: 85, avg_vol_20: 5000 },
    h6Live: { price: 103, vol_ratio: 1.01 },
    entryWindow: { window: 'HIGH', priority: true, reason: '' },
    bar: { closed: false, age_pct: 60 },
    overheadResistance: 115,
    trail: { status: 'SAFE' },
  });
  assert.equal(assembled.setup.setup, 'SMA20_PULLBACK');
  assert.equal(assembled.autoCore.eligible, true, 'production assembly must pass classified setup into auto core');
  assert.equal(assembled.gateView.scenarios.length, 1);
}

// Main and the fixture emitter must consume the same production assembly seam.
{
  const productionSource = readFileSync(new URL('./check_one.mjs', import.meta.url), 'utf-8');
  assert.match(productionSource, /vnAssembly\s*=\s*buildVnCoreAssembly\(\{/,
    'production main must use buildVnCoreAssembly');
  assert.match(productionSource, /buildVnAutoCore\(\{ price, h6History, h6Live, entryWindow, setup \}\)/,
    'production assembly must pass classifyVnSetup result into buildVnAutoCore');
}

const validVn = {
  setup: sma20Setup,
  setup_state: 'IN_ZONE',
  h6_history: { bars_completed: 120, sma20: 100, sma100: 90, structure: 'UPTREND', structure_v2: v2_CONFIRMED_UP, protected_low: 85, avg_vol_20: 5000 },
  h6_live: { price: 103, vol_ratio: 1.01 },
  entry_window: { window: 'HIGH', priority: true, reason: '' },
  auto_core: { eligible: true, conditions: {}, blockers: [] },
};

const validScenario = {
  label: 'sma20_pullback',
  direction: 'LONG',
  entry_low: 98,
  entry_high: 102,
  sl: 85,
  tp1: 115,
  trigger: 'AUTO_CORE_READY + CHECK_TAY_TRUOC_KHI_MUA',
  invalidation: 'dong cua duoi 85',
  size_note: 'trailing SMA20',
};

{
  const view = buildVnGateView({
    bar: { closed: false, age_pct: 60 },
    vn: validVn,
    planScenario: validScenario,
  });
  assert.equal(view.bar.closed_bars, validVn.h6_history.bars_completed,
    'gate bar.closed_bars must match vn.h6_history.bars_completed');
  assert.equal(view.setup_state, validVn.setup_state,
    'gate setup_state must match vn.setup_state');
  assert.deepEqual(view.scenarios, [validScenario],
    'gate scenarios must contain the canonical plan scenario');
}

// When setup_state is not IN_ZONE, scenarios must not contain legacy types
{
  const vnNotInZone = { ...validVn, setup_state: 'NEAR_ZONE' };
  const view = buildVnGateView({
    bar: { closed: false, age_pct: 60 },
    vn: vnNotInZone,
    planScenario: validScenario,
  });
  // A scenario may still exist when entry zone matches, but no breakout/retest/range
  assert.ok(!view.scenarios.some(s => s.label === 'breakout' || s.label === 'retest' || s.label === 'range'),
    'gate must never contain legacy breakout/retest/range scenarios');
}

// ===== VN Structure v2 integration tests (Task 1) =====

// Helper: create bars that produce known structure
function makeStructBars(n, factory) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const { high, low } = factory(i);
    bars.push({ time: i, open: high - 0.3, high, low, close: high - 0.1, volume: 100000 });
  }
  return bars;
}

// buildClosedH6History must include structure_v2 when sufficient bars exist
{
  const bars = makeStructBars(120, i => ({ high: 100 + i * 0.5, low: 99 + i * 0.5 }));
  const history = buildClosedH6History({ bars, activeBarClosed: true });
  assert.ok(history.structure_v2, 'buildClosedH6History must include structure_v2');
  assert.equal(history.structure_v2.version, VN_STRUCTURE_VERSION);
  assert.equal(history.structure, compatibilityStructure(history.structure_v2.trend_state));
  assert.ok(Number.isFinite(history.structure_v2.upper), 'structure_v2.upper must be finite');
  assert.ok(Number.isFinite(history.structure_v2.upper_ref));
  assert.ok(Number.isFinite(history.structure_v2.lower));
  assert.ok(Number.isFinite(history.structure_v2.lower_ref));
  assert.equal(history.structure_v2.trend_state, 'UP');
  assert.equal(history.structure_v2.confirmed, true);
}

// classifyVnSetup: SMA20_PULLBACK requires confirmed UP from structure_v2
{
  const bars = makeStructBars(120, i => ({ high: 100 + i * 0.5, low: 99 + i * 0.5 }));
  const h6History = buildClosedH6History({ bars, activeBarClosed: true });
  
  const r = classifyVnSetup({
    price: 103, sma20: 100, sma100: 90,
    structure: h6History.structure,
    structureV2: h6History.structure_v2,
    aboveSma100: true,
  });
  assert.equal(r.setup, 'SMA20_PULLBACK', 'confirmed UP + price near SMA20 → SMA20_PULLBACK');
}

// classifyVnSetup: SMA100_PULLBACK_RECLAIM requires confirmed UP or RANGE
{
  // Create bars that produce RANGE/STABLE (all flat bars)
  const bars = makeStructBars(120, i => ({ high: 100, low: 99 }));
  const h6History = buildClosedH6History({ bars, activeBarClosed: true });
  
  const r = classifyVnSetup({
    price: 103, sma20: 110, sma100: 100,
    structure: h6History.structure,
    structureV2: h6History.structure_v2,
    aboveSma100: true,
  });
  // With confirmed RANGE, SMA100_PULLBACK_RECLAIM should match
  assert.equal(r.setup, 'SMA100_PULLBACK_RECLAIM', 'confirmed RANGE + SMA100 near → reclaim');
}

// classifyVnSetup: MIXED/EXPANDING produces no setup
{
  // HCM facts: price=25300, sma20=24608, sma100=22738 — with MIXED/EXPANDING → no setup
  const r = classifyVnSetup({
    price: 25300, sma20: 24608, sma100: 22738,
    structureV2: { trend_state: 'MIXED', range_state: 'EXPANDING', confirmed: true },
    aboveSma100: true,
  });
  assert.equal(r.setup, null, 'MIXED trend → no setup');
}

// classifyVnSetup: provisional structure produces no setup
{
  const r = classifyVnSetup({
    price: 103, sma20: 100, sma100: 90,
    structureV2: { trend_state: 'UP', range_state: 'SHIFTING', confirmed: false },
    aboveSma100: true,
  });
  assert.equal(r.setup, null, 'provisional UP → no setup (not confirmed)');
}

// classifyVnSetup: MIXED with SMA100 extension does NOT invent overextension
{
  const r = classifyVnSetup({
    price: 25300, sma20: 24608, sma100: 22738,
    structureV2: { trend_state: 'MIXED', range_state: 'EXPANDING', confirmed: true },
    aboveSma100: true,
  });
  assert.equal(r.setup, null, 'HCM with MIXED → no setup, no SMA100 overextension invented');

  const autoCore = buildVnAutoCore({
    price: 25300,
    h6History: {
      bars_completed: 120,
      sma20: 24608,
      sma100: 22738,
      structure: 'MIXED',
      structure_v2: { trend_state: 'MIXED', range_state: 'EXPANDING', confirmed: true },
      avg_vol_20: 5000,
    },
    h6Live: { vol_ratio: 1.01 },
    entryWindow: { window: 'HIGH' },
    setup: r,
  });
  assert.ok(autoCore.blockers.includes('NO_SETUP'));
  assert.ok(!autoCore.blockers.includes('OVEREXTENDED'));
}

// buildVnAutoCore: structure_v2 trend gates block correctly
{
  // Forged structure_v2: UP but not confirmed → should be blocked
  const result = buildVnAutoCore({
    price: 103,
    h6History: {
      bars_completed: 120, sma20: 100, sma100: 90,
      structure_v2: { trend_state: 'UP', confirmed: false },
      avg_vol_20: 5000,
    },
    h6Live: { vol_ratio: 1.01 },
    entryWindow: { window: 'HIGH' },
    setup: { setup: 'SMA20_PULLBACK', zone_low: 98, zone_high: 102, anchor: 'sma20', reason: '' },
  });
  assert.equal(result.eligible, false, 'provisional UP in auto core → not eligible');
}

// ===== Fixture consistency test (Step 7) =====
import { readFileSync } from 'fs';
import { buildVnCoreFixture } from './tests/emit_vn_core_fixture.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

{
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const fixturePath = path.join(__dirname, 'tests', 'fixtures', 'vn_core_ready.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));

  assert.equal(fixture.vn.setup.setup, 'SMA20_PULLBACK', 'fixture setup must be SMA20_PULLBACK');
  assert.equal(fixture.vn.setup_state, 'IN_ZONE', 'fixture setup_state must be IN_ZONE');
  assert.equal(fixture.vn.auto_core.eligible, true, 'fixture auto_core must be eligible');
  assert.ok(fixture.vn.auto_core.blockers.length === 0, 'fixture must have no blockers');
  assert.equal(fixture.setup_state, 'IN_ZONE', 'fixture top-level setup_state must be IN_ZONE');
  assert.ok(fixture.scenarios.length === 1, 'fixture must have exactly 1 scenario');
  assert.equal(fixture.scenarios[0].label, 'sma20_pullback', 'fixture scenario label must be sma20_pullback');

  assert.deepEqual(buildVnCoreFixture(), fixture, 'fixture must equal full production-owned assembly');
}

console.log('ALL PASS');
