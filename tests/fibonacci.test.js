/**
 * Tests for Fibonacci confluence detection in core/fibonacci.js.
 * Pure functions over OHLC bar arrays — no live chart/exchange connection needed.
 * Bars need real wicks (unlike the flat candles in levels.test.js) since the
 * reaction mechanic is wick-into-zone-but-close-back-out, exactly like an SFP.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRetracementLevel,
  findGoldenPocket,
  detectFibReaction,
  scanForFibReaction,
  buildFibTradePlan,
} from '../src/core/fibonacci.js';

function bar({ open, high, low, close }) {
  return { open, high, low, close };
}

// Uptrend swing: prior low (point A) = 100 -> recent high (point B) = 200.
// Golden pocket = [134, 138.2]. Retraces down through it, rejects (bullish).
const UPTREND_SWING = { start: 100, end: 200 };
const BULLISH_BARS = [
  bar({ open: 100, high: 101, low: 99, close: 100 }),   // 0 — swing low (point A)
  bar({ open: 120, high: 122, low: 118, close: 121 }),  // 1
  bar({ open: 140, high: 142, low: 138, close: 141 }),  // 2
  bar({ open: 160, high: 162, low: 158, close: 161 }),  // 3
  bar({ open: 180, high: 182, low: 178, close: 181 }),  // 4
  bar({ open: 199, high: 200, low: 198, close: 199 }),  // 5 — swing high (point B)
  bar({ open: 180, high: 181, low: 175, close: 178 }),  // 6 — retracing, not yet in the zone
  bar({ open: 139, high: 141, low: 133, close: 139.05 }), // 7 — doji in the zone (small body)
  bar({ open: 140, high: 141, low: 133, close: 139 }),  // 8 — reaction: wicks to 133, closes at 139 > 138.2
  bar({ open: 137, high: 139, low: 133.5, close: 138.5 }), // 9 — retest: same mechanic again
];
const BULLISH_SWING_HIGH = { index: 5, price: 200 };
const BULLISH_SWING_LOW = { index: 0, price: 100 };

// Downtrend swing: prior high (point A) = 200 -> recent low (point B) = 100.
// Golden pocket = [161.8, 166]. Retraces up through it, rejects (bearish).
const DOWNTREND_SWING = { start: 200, end: 100 };
const BEARISH_BARS = [
  bar({ open: 199, high: 200, low: 198, close: 199 }),  // 0 — swing high (point A)
  bar({ open: 180, high: 182, low: 178, close: 179 }),  // 1
  bar({ open: 160, high: 162, low: 158, close: 159 }),  // 2
  bar({ open: 140, high: 142, low: 138, close: 139 }),  // 3
  bar({ open: 120, high: 122, low: 118, close: 119 }),  // 4
  bar({ open: 101, high: 102, low: 100, close: 101 }),  // 5 — swing low (point B)
  bar({ open: 130, high: 135, low: 128, close: 132 }),  // 6 — retracing, not yet in the zone
  bar({ open: 160, high: 163, low: 159, close: 160.5 }), // 7 — reaction: wicks to 163, closes at 160.5 < 161.8
  bar({ open: 162, high: 164, low: 160, close: 161 }),  // 8 — retest: same mechanic again
];
const BEARISH_SWING_HIGH = { index: 0, price: 200 };
const BEARISH_SWING_LOW = { index: 5, price: 100 };

describe('calculateRetracementLevel()', () => {
  it('measures how far price has retraced back from the most recent extreme toward the prior one', () => {
    assert.equal(calculateRetracementLevel({ ...UPTREND_SWING, ratio: 0 }), 200);   // 0% retraced -> at the recent high
    assert.equal(calculateRetracementLevel({ ...UPTREND_SWING, ratio: 1 }), 100);   // 100% retraced -> back at the prior low
    assert.equal(calculateRetracementLevel({ ...UPTREND_SWING, ratio: 0.618 }), 138.2);
  });

  it('rejects non-positive swing prices and non-finite ratios', () => {
    assert.throws(() => calculateRetracementLevel({ start: 0, end: 200, ratio: 0.618 }));
    assert.throws(() => calculateRetracementLevel({ start: 100, end: 200, ratio: NaN }));
  });
});

describe('findGoldenPocket()', () => {
  it('bounds the 0.618-0.66 zone below the recent high in an uptrend (support candidate)', () => {
    assert.deepEqual(findGoldenPocket(UPTREND_SWING), { high: 138.2, low: 134 });
  });

  it('bounds the 0.618-0.66 zone above the recent low in a downtrend (resistance candidate)', () => {
    assert.deepEqual(findGoldenPocket(DOWNTREND_SWING), { high: 166, low: 161.8 });
  });

  it('rejects a malformed ratios array', () => {
    assert.throws(() => findGoldenPocket({ ...UPTREND_SWING, ratios: [0.618] }));
  });
});

describe('detectFibReaction()', () => {
  const zone = findGoldenPocket(UPTREND_SWING);

  it('detects a bullish reaction: wicks into the zone but closes back above it', () => {
    const result = detectFibReaction({ bar: BULLISH_BARS[8], zone, direction: 'bullish' });
    assert.equal(result.detected, true);
    assert.equal(result.entry, 139);
    assert.equal(result.stop, 133);
  });

  it('does not detect a bullish reaction when the candle closes inside the zone (no rejection)', () => {
    const result = detectFibReaction({ bar: bar({ open: 136, high: 137, low: 135, close: 136 }), zone, direction: 'bullish' });
    assert.equal(result.detected, false);
  });

  it('does not detect a bullish reaction when price never reaches the zone', () => {
    const result = detectFibReaction({ bar: BULLISH_BARS[6], zone, direction: 'bullish' });
    assert.equal(result.detected, false);
  });

  it('detects a bearish reaction: wicks into the zone but closes back below it', () => {
    const bearishZone = findGoldenPocket(DOWNTREND_SWING);
    const result = detectFibReaction({ bar: BEARISH_BARS[7], zone: bearishZone, direction: 'bearish' });
    assert.equal(result.detected, true);
    assert.equal(result.entry, 160.5);
    assert.equal(result.stop, 163);
  });

  it('rejects an unknown direction', () => {
    assert.throws(() => detectFibReaction({ bar: BULLISH_BARS[8], zone, direction: 'sideways' }));
  });
});

describe('scanForFibReaction()', () => {
  it('reads the more-recent swing point as the trend anchor and finds first/retest bullish reactions', () => {
    const result = scanForFibReaction(BULLISH_BARS, { swingHigh: BULLISH_SWING_HIGH, swingLow: BULLISH_SWING_LOW });
    assert.equal(result.direction, 'bullish');
    assert.deepEqual(result.zone, { high: 138.2, low: 134 });
    assert.equal(result.hits.length, 2);
    assert.equal(result.hits[0].index, 8);
    assert.equal(result.hits[0].kind, 'first');
    assert.equal(result.hits[1].index, 9);
    assert.equal(result.hits[1].kind, 'retest');
  });

  it('skips doji reaction candles by default but counts them when skipDojis is false', () => {
    const withSkip = scanForFibReaction(BULLISH_BARS, { swingHigh: BULLISH_SWING_HIGH, swingLow: BULLISH_SWING_LOW });
    assert.equal(withSkip.hits.length, 2); // the doji at index 7 is excluded

    const withoutSkip = scanForFibReaction(BULLISH_BARS, { swingHigh: BULLISH_SWING_HIGH, swingLow: BULLISH_SWING_LOW, skipDojis: false });
    assert.equal(withoutSkip.hits.length, 3);
    assert.equal(withoutSkip.hits[0].index, 7);
    assert.equal(withoutSkip.hits[0].kind, 'first');
  });

  it('reads a downtrend (more-recent swing low) and finds a bearish reaction', () => {
    const result = scanForFibReaction(BEARISH_BARS, { swingHigh: BEARISH_SWING_HIGH, swingLow: BEARISH_SWING_LOW });
    assert.equal(result.direction, 'bearish');
    assert.deepEqual(result.zone, { high: 166, low: 161.8 });
    assert.equal(result.hits.length, 2);
    assert.equal(result.hits[0].kind, 'first');
    assert.equal(result.hits[1].kind, 'retest');
  });

  it('rejects swing points that are missing, malformed, or identical', () => {
    assert.throws(() => scanForFibReaction(BULLISH_BARS, { swingHigh: BULLISH_SWING_HIGH }));
    assert.throws(() => scanForFibReaction(BULLISH_BARS, { swingHigh: { price: 200 }, swingLow: BULLISH_SWING_LOW }));
    assert.throws(() => scanForFibReaction(BULLISH_BARS, { swingHigh: { index: 0, price: 200 }, swingLow: BULLISH_SWING_LOW }));
  });

  it('rejects an empty bar array', () => {
    assert.throws(() => scanForFibReaction([], { swingHigh: BULLISH_SWING_HIGH, swingLow: BULLISH_SWING_LOW }));
  });
});

describe('buildFibTradePlan()', () => {
  it('builds a long plan from a bullish golden-pocket reaction, entering at the close, stop beyond the wick', () => {
    const { hits, direction } = scanForFibReaction(BULLISH_BARS, { swingHigh: BULLISH_SWING_HIGH, swingLow: BULLISH_SWING_LOW });
    const plan = buildFibTradePlan({ hit: hits[0], direction, lastSwingLevel: 200, rangeLevel: 210 });
    assert.equal(plan.side, 'long');
    assert.equal(plan.entry, 139);
    assert.equal(plan.stop, 133);
    assert.equal(plan.target, 200);          // nearer upside target for a long
    assert.equal(plan.alternate_target, 210);
    assert.match(plan.confidence, /standard \(first/);
  });

  it('builds a short plan from a bearish golden-pocket reaction, entering at the close, stop beyond the wick', () => {
    const { hits, direction } = scanForFibReaction(BEARISH_BARS, { swingHigh: BEARISH_SWING_HIGH, swingLow: BEARISH_SWING_LOW });
    const plan = buildFibTradePlan({ hit: hits[0], direction, lastSwingLevel: 100, rangeLevel: 90 });
    assert.equal(plan.side, 'short');
    assert.equal(plan.entry, 160.5);
    assert.equal(plan.stop, 163);
    assert.equal(plan.target, 100);           // nearer downside target for a short
    assert.equal(plan.alternate_target, 90);
  });

  it('rates a retest reaction as higher confidence than a first reaction', () => {
    const { hits, direction } = scanForFibReaction(BULLISH_BARS, { swingHigh: BULLISH_SWING_HIGH, swingLow: BULLISH_SWING_LOW });
    const plans = hits.map(hit => buildFibTradePlan({ hit, direction, lastSwingLevel: 200 }));
    assert.match(plans[0].confidence, /standard \(first/);
    assert.match(plans[1].confidence, /higher \(retest/);
  });

  it('requires at least one target', () => {
    const { hits, direction } = scanForFibReaction(BULLISH_BARS, { swingHigh: BULLISH_SWING_HIGH, swingLow: BULLISH_SWING_LOW });
    assert.throws(() => buildFibTradePlan({ hit: hits[0], direction }));
  });

  it('rejects an unconfirmed hit or an invalid direction', () => {
    assert.throws(() => buildFibTradePlan({ hit: { detected: false }, direction: 'bullish', lastSwingLevel: 200 }));
    const { hits } = scanForFibReaction(BULLISH_BARS, { swingHigh: BULLISH_SWING_HIGH, swingLow: BULLISH_SWING_LOW });
    assert.throws(() => buildFibTradePlan({ hit: hits[0], direction: 'sideways', lastSwingLevel: 200 }));
  });
});
