/**
 * Tests for Key Levels / Zones detection in core/levels.js.
 * Pure functions over OHLC bar arrays — no live chart/exchange connection needed.
 * Series use flat candles (open=high=low=close) so swing/zone/retest detection
 * is fully predictable from the close sequence alone.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findConsolidationRanges,
  detectZones,
  findZoneRetests,
  buildZoneTradePlan,
} from '../src/core/levels.js';

function bars(closes) {
  return closes.map(close => ({ open: close, high: close, low: close, close }));
}

// uptrend (0-6) -> tight range ~[100,102] (7-12) -> close-based breakout UP (13+)
const SUPPORT_CONTINUATION = [
  90, 92, 94, 96, 98, 100, 101,
  101, 102, 100, 101.5, 100.5, 101,
  103, 105, 107,
  101.5, // retest back into the zone
  108, 110,
];

// downtrend (0-6) -> tight range ~[98,100] (7-12) -> close-based breakout DOWN (13+)
const RESISTANCE_CONTINUATION = [
  110, 108, 106, 104, 102, 100, 99,
  99, 98, 100, 98.5, 99.5, 99,
  97, 95, 93,
  98.5,
  92, 90,
];

// downtrend (0-6) -> tight range ~[98,100] (7-12) -> close-based breakout UP (13+) — trend reversal
const SUPPORT_REVERSAL = [
  110, 108, 106, 104, 102, 100, 99,
  99, 100, 98, 99.5, 98.5, 99,
  101, 103, 105,
  99.5,
  106, 108,
];

// uptrend (0-6) -> tight range ~[100,102] (7-12) -> close-based breakout DOWN (13+) — trend reversal
const RESISTANCE_REVERSAL = [
  90, 92, 94, 96, 98, 100, 101,
  101, 100, 102, 100.5, 101.5, 101,
  99, 97, 95,
  100.5,
  94, 92,
];

describe('findConsolidationRanges()', () => {
  it('finds an adjacent swing-high/swing-low pair forming a tight range', () => {
    const ranges = findConsolidationRanges(bars(SUPPORT_CONTINUATION), { swingLookback: 2, maxRangePercent: 3 });
    assert.equal(ranges.length, 1);
    assert.deepEqual(ranges[0], { start_index: 8, end_index: 9, high: 102, low: 100 });
  });

  it('excludes pairs whose gap exceeds maxRangePercent', () => {
    const ranges = findConsolidationRanges(bars(SUPPORT_CONTINUATION), { swingLookback: 2, maxRangePercent: 0.5 });
    assert.equal(ranges.length, 0);
  });

  it('rejects an empty bar array', () => {
    assert.throws(() => findConsolidationRanges([]));
  });
});

describe('detectZones()', () => {
  it('classifies a breakout-up after an uptrend as a support continuation zone', () => {
    const zones = detectZones(bars(SUPPORT_CONTINUATION), { swingLookback: 2, maxRangePercent: 3, trendLookback: 5 });
    assert.equal(zones.length, 1);
    assert.equal(zones[0].type, 'support');
    assert.equal(zones[0].classification, 'continuation');
    assert.equal(zones[0].high, 102);
    assert.equal(zones[0].low, 100);
    assert.equal(zones[0].breakout_index, 13);
  });

  it('classifies a breakout-down after a downtrend as a resistance continuation zone', () => {
    const zones = detectZones(bars(RESISTANCE_CONTINUATION), { swingLookback: 2, maxRangePercent: 3, trendLookback: 5 });
    assert.equal(zones.length, 1);
    assert.equal(zones[0].type, 'resistance');
    assert.equal(zones[0].classification, 'continuation');
  });

  it('classifies a breakout-up after a downtrend as a support reversal zone (bullish reversal)', () => {
    const zones = detectZones(bars(SUPPORT_REVERSAL), { swingLookback: 2, maxRangePercent: 3, trendLookback: 5 });
    assert.equal(zones.length, 1);
    assert.equal(zones[0].type, 'support');
    assert.equal(zones[0].classification, 'reversal');
  });

  it('classifies a breakout-down after an uptrend as a resistance reversal zone (bearish reversal)', () => {
    const zones = detectZones(bars(RESISTANCE_REVERSAL), { swingLookback: 2, maxRangePercent: 3, trendLookback: 5 });
    assert.equal(zones.length, 1);
    assert.equal(zones[0].type, 'resistance');
    assert.equal(zones[0].classification, 'reversal');
  });

  it('excludes ranges with no confirmed breakout yet', () => {
    // chop the series off right after the range forms — no breakout bars follow
    const zones = detectZones(bars(SUPPORT_CONTINUATION.slice(0, 10)), { swingLookback: 2, maxRangePercent: 3, trendLookback: 5 });
    assert.equal(zones.length, 0);
  });

  it('rejects an empty bar array', () => {
    assert.throws(() => detectZones([]));
  });
});

describe('findZoneRetests()', () => {
  it('finds the first bar after the breakout whose range overlaps the zone, tagged "first"', () => {
    const series = bars(SUPPORT_CONTINUATION);
    const [zone] = detectZones(series, { swingLookback: 2, maxRangePercent: 3, trendLookback: 5 });
    const hits = findZoneRetests(series, zone);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].index, 16);
    assert.equal(hits[0].kind, 'first');
    assert.equal(hits[0].bar.close, 101.5);
  });

  it('tags a subsequent overlap as "retest" (repeat touch)', () => {
    const series = bars([...SUPPORT_CONTINUATION.slice(0, 17), 106, 101.2, 109]);
    const [zone] = detectZones(series, { swingLookback: 2, maxRangePercent: 3, trendLookback: 5 });
    const hits = findZoneRetests(series, zone);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].kind, 'first');
    assert.equal(hits[1].kind, 'retest');
  });

  it('returns no hits when price never returns to the zone', () => {
    const series = bars(SUPPORT_CONTINUATION.slice(0, 16)); // stops right before the retest bar
    const [zone] = detectZones(series, { swingLookback: 2, maxRangePercent: 3, trendLookback: 5 });
    assert.deepEqual(findZoneRetests(series, zone), []);
  });

  it('rejects a malformed zone object', () => {
    assert.throws(() => findZoneRetests(bars(SUPPORT_CONTINUATION), { type: 'support' }));
  });
});

describe('buildZoneTradePlan()', () => {
  it('builds a long plan from a support-zone retest, entering at the retest close, stop below the zone', () => {
    const series = bars(SUPPORT_CONTINUATION);
    const [zone] = detectZones(series, { swingLookback: 2, maxRangePercent: 3, trendLookback: 5 });
    const [hit] = findZoneRetests(series, zone);
    const plan = buildZoneTradePlan({ zone, hit, oppositeZoneLevel: 110, rangeLevel: 115 });
    assert.equal(plan.side, 'long');
    assert.equal(plan.entry, 101.5);
    assert.equal(plan.stop, 100); // far (lower) boundary of the support zone
    assert.equal(plan.target, 110); // nearer upside target for a long
    assert.equal(plan.alternate_target, 115);
    assert.match(plan.confidence, /fresh zone — first retest/);
  });

  it('builds a short plan from a resistance-zone retest, entering at the retest close, stop above the zone', () => {
    const series = bars(RESISTANCE_CONTINUATION);
    const [zone] = detectZones(series, { swingLookback: 2, maxRangePercent: 3, trendLookback: 5 });
    const [hit] = findZoneRetests(series, zone);
    const plan = buildZoneTradePlan({ zone, hit, oppositeZoneLevel: 90, rangeLevel: 85 });
    assert.equal(plan.side, 'short');
    assert.equal(plan.entry, 98.5);
    assert.equal(plan.stop, 100); // far (upper) boundary of the resistance zone
    assert.equal(plan.target, 90); // nearer downside target for a short
    assert.equal(plan.alternate_target, 85);
  });

  it('rates a repeat-touch retest as weaker than the first retest', () => {
    const series = bars([...SUPPORT_CONTINUATION.slice(0, 17), 106, 101.2, 109]);
    const [zone] = detectZones(series, { swingLookback: 2, maxRangePercent: 3, trendLookback: 5 });
    const hits = findZoneRetests(series, zone);
    const plans = hits.map(hit => buildZoneTradePlan({ zone, hit, rangeLevel: 115 }));
    assert.match(plans[0].confidence, /highest conviction/);
    assert.match(plans[1].confidence, /weakening/);
  });

  it('requires at least one of oppositeZoneLevel or rangeLevel', () => {
    const series = bars(SUPPORT_CONTINUATION);
    const [zone] = detectZones(series, { swingLookback: 2, maxRangePercent: 3, trendLookback: 5 });
    const [hit] = findZoneRetests(series, zone);
    assert.throws(() => buildZoneTradePlan({ zone, hit }));
  });

  it('rejects a zone with an invalid type', () => {
    assert.throws(() => buildZoneTradePlan({ zone: { type: 'sideways', high: 1, low: 0 }, hit: { bar: { close: 1 } }, rangeLevel: 1 }));
  });

  it('rejects a missing/unconfirmed hit', () => {
    const series = bars(SUPPORT_CONTINUATION);
    const [zone] = detectZones(series, { swingLookback: 2, maxRangePercent: 3, trendLookback: 5 });
    assert.throws(() => buildZoneTradePlan({ zone, rangeLevel: 90 }));
  });
});
