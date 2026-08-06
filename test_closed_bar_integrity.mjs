// Closed-bar integrity regression tests. Run: node test_closed_bar_integrity.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClosedH6History, buildVnCoreAssembly, computeClosedSma } from './check_one.mjs';
import { buildScanStructure } from './scan_live.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));

function makeBars(count = 120, active = null) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const base = 100 + i * 0.2 + (i % 7 === 0 ? 4 : 0);
    bars.push({
      time: 1_700_000_000 + i * 21_600,
      open: base,
      high: base + 2 + (i % 5 === 0 ? 1 : 0),
      low: base - 2,
      close: base + 1,
      volume: 100_000 + i * 100,
    });
  }
  if (active) bars.push({
    time: 1_700_000_000 + count * 21_600,
    open: active.open ?? 500,
    high: active.high ?? 900,
    low: active.low ?? 50,
    close: active.close ?? 850,
    volume: active.volume ?? 9_000_000,
  });
  return bars;
}

function closedInputs(bars, activeBarClosed) {
  const history = buildClosedH6History({ bars, activeBarClosed });
  const completed = activeBarClosed ? bars : bars.slice(0, -1);
  const structure = buildScanStructure({
    bars,
    activeBarClosed,
    sma20: history.sma20,
    sma100: history.sma100,
  });
  return { history, structure, completed };
}

function makeConfirmedBars(count = 120, active = null) {
  const bars = Array.from({ length: count }, (_, i) => ({
    time: 1_700_000_000 + i * 21_600,
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 101 + i,
    volume: 100_000 + i * 100,
  }));
  if (active) bars.push({
    time: 1_700_000_000 + count * 21_600,
    open: active.open ?? 500,
    high: active.high ?? 900,
    low: active.low ?? 50,
    close: active.close ?? 850,
    volume: active.volume ?? 9_000_000,
  });
  return bars;
}

// Regression: an open H6 candle is observation-only. Mutating it cannot alter
// any closed-derived history or downstream structural inputs.
{
  const baselineBars = makeBars();
  const openBarsA = makeBars(120, { close: 101, high: 105, low: 98, volume: 150_000 });
  const openBarsB = makeBars(120, { close: 850, high: 900, low: 50, volume: 9_000_000 });
  const a = closedInputs(openBarsA, false);
  const b = closedInputs(openBarsB, false);
  const baseline = closedInputs(baselineBars, true);

  assert.deepEqual(a.history, b.history, 'active mutation must not change closed H6 history');
  assert.deepEqual(a.structure, b.structure, 'active mutation must not change structure/pivots');
  assert.deepEqual(a.history, baseline.history, 'closed history matches the same completed bars');
  assert.deepEqual(a.structure, baseline.structure, 'closed structure matches the same completed bars');

  // Canonical assembly consumes the closed history and produces a provisional
  // gate bar when the current candle is open.
  const common = {
    price: 101,
    h6History: a.history,
    h6Live: { price: 101, vol_ratio: 1.01 },
    entryWindow: { window: 'HIGH', priority: false, reason: '' },
    overheadResistance: 130,
    trail: { status: 'SAFE' },
  };
  const assembled = buildVnCoreAssembly({ ...common, bar: { closed: false, age_pct: 50 } });
  assert.equal(assembled.gateView.bar.closed, false, 'open output must remain PROVISIONAL');
  assert.equal(assembled.gateView.bar.age_pct, 50);
  assert.equal(assembled.gateView.bar.closed_bars, a.history.bars_completed);
}

// Scan structure has the same closed-only boundary and must ignore an active
// bar mutation while preserving the structure_v2 contract.
{
  const barsA = makeConfirmedBars(120, { close: 101, high: 105, low: 98, volume: 150_000 });
  const barsB = makeConfirmedBars(120, { close: 850, high: 900, low: 50, volume: 9_000_000 });
  const a = buildScanStructure({ bars: barsA, activeBarClosed: false, sma20: 1, sma100: 9999 });
  const b = buildScanStructure({ bars: barsB, activeBarClosed: false, sma20: 9999, sma100: 1 });
  assert.deepEqual(a, b, 'scan_live closed structure must ignore active-bar mutation');
  const canonical = buildScanStructure({ bars: makeConfirmedBars(120), activeBarClosed: true });
  assert.deepEqual(a, canonical, 'scan structure must use completed OHLCV instead of live MA inputs');
  assert.equal(a.structure_v2.confirmed, true, 'closed structure remains confirmed with sufficient history');
  assert.equal(a.structure_v2.trend_state, 'UP', 'fixture genuinely confirms an UP channel');
}

// Open-bar top-level compatibility SMA100 uses the full completed history,
// independent of the legacy 65-bar analysis window and the active candle.
{
  const bars = makeConfirmedBars(120, { close: 9999, high: 10000, low: 1 });
  const sma100 = computeClosedSma({ bars, activeBarClosed: false, period: 100 });
  assert.ok(Number.isFinite(sma100), '>=100 completed bars must produce finite SMA100');
  assert.equal(sma100, computeClosedSma({ bars: makeConfirmedBars(120), activeBarClosed: true, period: 100 }));
}

// scan_live's direct self-test is import-safe and must exercise the timezone
// contract without opening CDP or writing scan artifacts.
{
  const selfTest = spawnSync(process.execPath, ['scan_live.mjs', '--self-test-timezone'], {
    cwd: REPO_DIR,
    env: { ...process.env },
    encoding: 'utf8',
  });
  assert.equal(selfTest.status, 0, `scan_live timezone self-test failed: ${selfTest.stderr}`);
  assert.match(selfTest.stdout, /\"date\":\"20260805\"/);
  assert.match(selfTest.stdout, /\"scan_time\":\"00:30\"/);
  assert.match(selfTest.stdout, /\"display_time\":\"00:30:45\"/);
  assert.match(selfTest.stdout, /\"phase\":\"CONT_AM\"/);

  const guardEnv = { ...process.env };
  for (const key of ['SCAN_CANONICAL_CONTEXT', 'SCAN_DATA_LOCK_ROOT', 'SCOUT_SCAN_PATH',
    'SCAN_LATEST_PATH', 'SCAN_CANDIDATES_PATH', 'CLAUDE_OS_COS', 'FOREIGN_LATEST_PATH',
    'REGIME_LATEST_PATH', 'SECTOR_MAP_PATH', 'PYTHON_EXECUTABLE']) delete guardEnv[key];
  const direct = spawnSync(process.execPath, ['scan_live.mjs'], {
    cwd: REPO_DIR,
    env: guardEnv,
    encoding: 'utf8',
  });
  assert.notEqual(direct.status, 0, 'direct scan_live without canonical context must fail closed');
  assert.match(`${direct.stdout}\n${direct.stderr}`, /Missing SCAN_CANONICAL_CONTEXT/);
}

console.log('ALL PASS');
