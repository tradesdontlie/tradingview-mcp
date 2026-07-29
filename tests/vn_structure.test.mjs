// VN Structure v2 — pure unit tests
// Run: node --test C:\Users\ADMIN\tradingview-mcp\tests\vn_structure.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBoundary, deriveCandidate, compatibilityStructure, computeVnStructure, VN_STRUCTURE_VERSION } from '../src/core/vn_structure.mjs';

// --- helpers ---
function bar(time, o, h, l, c, v = 100000) {
  return { time, open: o, high: h, low: l, close: c, volume: v };
}

// monotonically rising bars: each bar's high/low increase by stepHigh/stepLow
function risingBars(n, { stepHigh = 0.5, stepLow = 0.5, baseHigh = 100, baseLow = 99 } = {}) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const h = baseHigh + i * stepHigh;
    const l = baseLow + i * stepLow;
    bars.push(bar(i, h - 0.3, h, l, h - 0.1));
  }
  return bars;
}

// ── classifyBoundary ──

test('classifyBoundary non-finite inputs', () => {
  assert.equal(classifyBoundary(NaN, 100), 'UNKNOWN');
  assert.equal(classifyBoundary(100, NaN), 'UNKNOWN');
  assert.equal(classifyBoundary(100, null), 'UNKNOWN');
  assert.equal(classifyBoundary(undefined, 100), 'UNKNOWN');
});

test('classifyBoundary clear FLAT (well inside band)', () => {
  // 100.4 vs 100: 100.4/100 = 1.004, well within ±0.005 band
  assert.equal(classifyBoundary(100.4, 100), 'FLAT');
  assert.equal(classifyBoundary(99.6, 100), 'FLAT');
});

test('classifyBoundary clear UP (well above band)', () => {
  // 100.6 vs 100: 100.6/100 = 1.006 > 1.005
  assert.equal(classifyBoundary(100.6, 100), 'UP');
  // integer reference avoids IEEE 754 drift
  assert.equal(classifyBoundary(2011, 2000), 'UP');   // 2011/2000 = 1.0055 > 1.005
});

test('classifyBoundary clear DOWN (well below band)', () => {
  // 99.4 vs 100: 99.4/100 = 0.994 < 0.995
  assert.equal(classifyBoundary(99.4, 100), 'DOWN');
  assert.equal(classifyBoundary(1989, 2000), 'DOWN');  // 1989/2000 = 0.9945 < 0.995
});

test('classifyBoundary at exact ratio boundary using integers', () => {
  // Use ref=2000, 2000*1.005=2010, 2000*0.995=1990
  assert.equal(classifyBoundary(2010, 2000), 'FLAT');   // exactly at UP threshold
  assert.equal(classifyBoundary(1990, 2000), 'FLAT');   // exactly at DOWN threshold
  assert.equal(classifyBoundary(2011, 2000), 'UP');     // one unit above
  assert.equal(classifyBoundary(1989, 2000), 'DOWN');   // one unit below
});

// ── deriveCandidate ──

test('deriveCandidate table rows', () => {
  // UP/UP + SMA20>SMA100 → UP/SHIFTING
  assert.deepEqual(
    deriveCandidate({ upperDirection: 'UP', lowerDirection: 'UP', sma20: 110, sma100: 100 }),
    { trendState: 'UP', rangeState: 'SHIFTING' },
  );
  // UP/UP without MA order → MIXED/SHIFTING (Other finite combination)
  assert.deepEqual(
    deriveCandidate({ upperDirection: 'UP', lowerDirection: 'UP', sma20: 100, sma100: 110 }),
    { trendState: 'MIXED', rangeState: 'SHIFTING' },
  );
  // DOWN/DOWN + SMA20<SMA100 → DOWN/SHIFTING
  assert.deepEqual(
    deriveCandidate({ upperDirection: 'DOWN', lowerDirection: 'DOWN', sma20: 90, sma100: 100 }),
    { trendState: 'DOWN', rangeState: 'SHIFTING' },
  );
  // DOWN/DOWN without MA order → MIXED/SHIFTING
  assert.deepEqual(
    deriveCandidate({ upperDirection: 'DOWN', lowerDirection: 'DOWN', sma20: 110, sma100: 100 }),
    { trendState: 'MIXED', rangeState: 'SHIFTING' },
  );
  // FLAT/FLAT + finite MA → RANGE/STABLE
  assert.deepEqual(
    deriveCandidate({ upperDirection: 'FLAT', lowerDirection: 'FLAT', sma20: 100, sma100: 90 }),
    { trendState: 'RANGE', rangeState: 'STABLE' },
  );
  // UP/DOWN → MIXED/EXPANDING
  assert.deepEqual(
    deriveCandidate({ upperDirection: 'UP', lowerDirection: 'DOWN', sma20: 100, sma100: 90 }),
    { trendState: 'MIXED', rangeState: 'EXPANDING' },
  );
  // DOWN/UP → MIXED/CONTRACTING
  assert.deepEqual(
    deriveCandidate({ upperDirection: 'DOWN', lowerDirection: 'UP', sma20: 100, sma100: 90 }),
    { trendState: 'MIXED', rangeState: 'CONTRACTING' },
  );
  // UP/FLAT → MIXED/SHIFTING (Other finite)
  assert.deepEqual(
    deriveCandidate({ upperDirection: 'UP', lowerDirection: 'FLAT', sma20: 100, sma100: 90 }),
    { trendState: 'MIXED', rangeState: 'SHIFTING' },
  );
  // FLAT/DOWN → MIXED/SHIFTING
  assert.deepEqual(
    deriveCandidate({ upperDirection: 'FLAT', lowerDirection: 'DOWN', sma20: 100, sma100: 90 }),
    { trendState: 'MIXED', rangeState: 'SHIFTING' },
  );
  // FLAT/FLAT without finite MA → UNKNOWN/UNKNOWN
  assert.deepEqual(
    deriveCandidate({ upperDirection: 'FLAT', lowerDirection: 'FLAT', sma20: null, sma100: null }),
    { trendState: 'UNKNOWN', rangeState: 'UNKNOWN' },
  );
  // UNKNOWN/anything → UNKNOWN/UNKNOWN
  assert.deepEqual(
    deriveCandidate({ upperDirection: 'UNKNOWN', lowerDirection: 'UP', sma20: 100, sma100: 90 }),
    { trendState: 'UNKNOWN', rangeState: 'UNKNOWN' },
  );
  assert.deepEqual(
    deriveCandidate({ upperDirection: 'UP', lowerDirection: 'UNKNOWN', sma20: 100, sma100: 90 }),
    { trendState: 'UNKNOWN', rangeState: 'UNKNOWN' },
  );
});

// ── compatibilityStructure ──

test('compatibilityStructure mapping', () => {
  assert.equal(compatibilityStructure('UP'), 'UPTREND');
  assert.equal(compatibilityStructure('DOWN'), 'DOWNTREND');
  assert.equal(compatibilityStructure('RANGE'), 'SIDEWAYS');
  assert.equal(compatibilityStructure('MIXED'), 'MIXED');
  assert.equal(compatibilityStructure('UNKNOWN'), 'INSUFFICIENT_DATA');
});

// ── computeVnStructure ──

test('computeVnStructure: 22 bars → UNKNOWN', () => {
  const bars = risingBars(22);
  const r = computeVnStructure(bars, { sma20: 105, sma100: 100 });
  assert.equal(r.trend_state, 'UNKNOWN');
  assert.equal(r.range_state, 'UNKNOWN');
  assert.equal(r.confirmed, false);
  assert.equal(r.version, VN_STRUCTURE_VERSION);
});

test('computeVnStructure: 23 bars → provisional', () => {
  const bars = risingBars(23);
  // SMA20 will be above SMA100 since prices are rising
  const r = computeVnStructure(bars, { sma20: 105, sma100: 100 });
  assert.equal(r.trend_state, 'UP');
  assert.equal(r.range_state, 'SHIFTING');
  assert.equal(r.confirmed, false, '23 bars = only 1 evaluation → provisional');
  assert.ok(Number.isFinite(r.upper));
  assert.ok(Number.isFinite(r.upper_ref));
  assert.ok(Number.isFinite(r.lower));
  assert.ok(Number.isFinite(r.lower_ref));
  assert.equal(r.version, VN_STRUCTURE_VERSION);
});

test('computeVnStructure: 24 bars monotonically rising → confirmed UP/SHIFTING', () => {
  const bars = risingBars(24);
  const r = computeVnStructure(bars, { sma20: 105, sma100: 100 });
  assert.equal(r.trend_state, 'UP');
  assert.equal(r.range_state, 'SHIFTING');
  assert.equal(r.confirmed, true, '24 bars = 2 consistent evaluations → confirmed');
});

test('computeVnStructure: MIXED/EXPANDING when lower drops', () => {
  // Start with 24 rising bars, then make the last bar have a new extreme low
  const bars = risingBars(24);
  // Ponytail: drop the last bar's low to 95 — well below the floor of the reference window
  // (reference window low ≈ 99.5, 95 < 99.5*0.995 ≈ 99.0 → clear DOWN)
  const last = bars[bars.length - 1];
  bars[bars.length - 1] = { ...last, low: 95 };
  
  const r = computeVnStructure(bars, { sma20: 105, sma100: 100 });
  assert.equal(r.trend_state, 'MIXED');
  assert.equal(r.range_state, 'EXPANDING');
  // Only 1 consistent evaluation → provisional (previous was UP/SHIFTING)
  assert.equal(r.confirmed, false);
});

test('computeVnStructure: CONTRACTING when lower rises faster than upper', () => {
  // Upper FLAT, lower UP → MIXED/CONTRACTING (DOWN/UP but with lower UP... wait, that's FLAT/UP)
  // Actually DOWN/UP = CONTRACTING. Let me make upper direction DOWN, lower direction UP.
  // Upper DOWN means current high < ref high * 0.995
  // Lower UP means current low > ref low * 1.005
  const bars = [];
  for (let i = 0; i < 24; i++) {
    // Highs DECREASE (to get upper DOWN), Lows INCREASE (to get lower UP)
    const h = 200 - i * 2;
    const l = 100 + i * 2;
    bars.push(bar(i, h - 1, h, l, h - 2));
  }
  // Need sma20 and sma100 finite for a valid non-UNKNOWN result
  const r = computeVnStructure(bars, { sma20: 150, sma100: 130 });
  // Upper DOWN + Lower UP → MIXED/CONTRACTING
  assert.equal(r.trend_state, 'MIXED');
  assert.equal(r.range_state, 'CONTRACTING');
});

test('computeVnStructure: 22,23,24 bar count progression', () => {
  let bars = risingBars(22);
  assert.equal(computeVnStructure(bars, { sma20: 105, sma100: 100 }).trend_state, 'UNKNOWN');
  
  bars = risingBars(23);
  const r23 = computeVnStructure(bars, { sma20: 105, sma100: 100 });
  assert.equal(r23.confirmed, false);
  
  bars = risingBars(24);
  const r24 = computeVnStructure(bars, { sma20: 105, sma100: 100 });
  assert.equal(r24.confirmed, true);
});

test('computeVnStructure: deterministic — identical inputs → identical outputs', () => {
  const bars = risingBars(24);
  const ma = { sma20: 105, sma100: 100 };
  const a = computeVnStructure(bars, ma);
  const b = computeVnStructure(bars, ma);
  assert.deepEqual(a, b);
});

test('computeVnStructure: empty bars', () => {
  const r = computeVnStructure([], { sma20: 100, sma100: 90 });
  assert.equal(r.trend_state, 'UNKNOWN');
  assert.equal(r.range_state, 'UNKNOWN');
  assert.equal(r.confirmed, false);
});

test('computeVnStructure: no mutation of input bars', () => {
  const bars = risingBars(24);
  const copy = JSON.parse(JSON.stringify(bars));
  computeVnStructure(bars, { sma20: 105, sma100: 100 });
  assert.deepEqual(bars, copy, 'input bars must not be mutated');
});

// ── version constant ──

test('VN_STRUCTURE_VERSION is exact', () => {
  assert.equal(VN_STRUCTURE_VERSION, 'vn-structure-v2-channel-20-3-005-2');
});
