/**
 * Tests for Pinbar reversal-bias detection in core/pinbar.js.
 * Pure functions over OHLC bar arrays — bars need real wicks (the pattern is
 * defined entirely by wick/body shape), mirroring fibonacci.test.js.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPinbar,
  detectLevelRetest,
  scanForPinbarSetup,
  buildPinbarTradePlan,
} from '../src/core/pinbar.js';

function bar({ open, high, low, close }) {
  return { open, high, low, close };
}

// Bullish pinbar forms AT the swing low (index 1, price 90) — long lower
// wick, minimal upper wick. Reference level = the candle-before's low (100).
// Price runs up, then retraces back down through 100 and closes above it
// (idx 4) — the close-based "level to level" retest entry.
const BULLISH_BARS = [
  bar({ open: 105, high: 107, low: 100, close: 103 }),   // 0 — candle before the pinbar (reference level = low, 100)
  bar({ open: 98, high: 100, low: 90, close: 99.5 }),    // 1 — bullish pinbar at the swing low (90)
  bar({ open: 101.5, high: 103, low: 101, close: 102 }), // 2 — running up, no retest yet
  bar({ open: 102, high: 106, low: 101.5, close: 105 }), // 3
  bar({ open: 105, high: 107, low: 99.5, close: 106 }),  // 4 — retest: wicks to 99.5, closes at 106 > 100
];
const BULLISH_SWING_LOW = { index: 1, price: 90 };

// Bearish pinbar forms AT the swing high (index 1, price 110) — long upper
// wick, minimal lower wick. Reference level = the candle-before's high (100).
// Price runs down, then rallies back up through 100 and closes below it
// (idx 4) — the close-based retest entry.
const BEARISH_BARS = [
  bar({ open: 95, high: 100, low: 93, close: 97 }),      // 0 — candle before the pinbar (reference level = high, 100)
  bar({ open: 102, high: 110, low: 100, close: 100.5 }), // 1 — bearish pinbar at the swing high (110)
  bar({ open: 99, high: 99.5, low: 96, close: 97 }),     // 2 — running down, no retest yet
  bar({ open: 97, high: 98, low: 94, close: 95 }),       // 3
  bar({ open: 95, high: 101, low: 94.5, close: 99 }),    // 4 — retest: wicks to 101, closes at 99 < 100
];
const BEARISH_SWING_HIGH = { index: 1, price: 110 };

describe('detectPinbar()', () => {
  it('detects a bullish pinbar: long lower wick, minimal upper wick', () => {
    const result = detectPinbar(BULLISH_BARS[1], { direction: 'bullish' });
    assert.equal(result.detected, true);
    assert.equal(result.dominantWick, 8);
    assert.equal(result.oppositeWick, 0.5);
  });

  it('detects a bearish pinbar: long upper wick, minimal lower wick', () => {
    const result = detectPinbar(BEARISH_BARS[1], { direction: 'bearish' });
    assert.equal(result.detected, true);
    assert.equal(result.dominantWick, 8);
    assert.equal(result.oppositeWick, 0.5);
  });

  it('does not detect a pinbar when the dominant wick fails to clearly dominate the body/range', () => {
    assert.equal(detectPinbar(bar({ open: 100, high: 102, low: 99, close: 101 }), { direction: 'bullish' }).detected, false);
  });

  it('does not detect a pinbar when the opposite wick is too large ("minimal or no" wick on the other side)', () => {
    // long lower wick, but also a sizeable upper wick — fails the "minimal opposite wick" criterion
    assert.equal(detectPinbar(bar({ open: 98, high: 105, low: 90, close: 99 }), { direction: 'bullish' }).detected, false);
  });

  it('rejects an unknown direction or malformed bar', () => {
    assert.throws(() => detectPinbar(BULLISH_BARS[1], { direction: 'sideways' }));
    assert.throws(() => detectPinbar({}, { direction: 'bullish' }));
  });
});

describe('detectLevelRetest()', () => {
  it('detects a bullish retest: wicks to/through the level but closes back above it', () => {
    const result = detectLevelRetest(BULLISH_BARS[4], { level: 100, direction: 'bullish' });
    assert.equal(result.detected, true);
    assert.equal(result.entry, 106);
  });

  it('detects a bearish retest: wicks to/through the level but closes back below it', () => {
    const result = detectLevelRetest(BEARISH_BARS[4], { level: 100, direction: 'bearish' });
    assert.equal(result.detected, true);
    assert.equal(result.entry, 99);
  });

  it('does not detect a retest when price never reaches the level', () => {
    assert.equal(detectLevelRetest(BULLISH_BARS[2], { level: 100, direction: 'bullish' }).detected, false);
  });

  it('rejects an unknown direction or non-finite level', () => {
    assert.throws(() => detectLevelRetest(BULLISH_BARS[4], { level: 100, direction: 'sideways' }));
    assert.throws(() => detectLevelRetest(BULLISH_BARS[4], { level: NaN, direction: 'bullish' }));
  });
});

describe('scanForPinbarSetup()', () => {
  it('finds a bullish pinbar at the swing low and confirms the close-based retest of the prior candle\'s low', () => {
    const { hits } = scanForPinbarSetup(BULLISH_BARS, { swingHighs: [], swingLows: [BULLISH_SWING_LOW] });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].direction, 'bullish');
    assert.equal(hits[0].index, 4);
    assert.equal(hits[0].entry, 106);
    assert.equal(hits[0].level, 100);
    assert.equal(hits[0].stop, 90);
    assert.equal(hits[0].biasIndex, 1);
  });

  it('finds a bearish pinbar at the swing high and confirms the close-based retest of the prior candle\'s high', () => {
    const { hits } = scanForPinbarSetup(BEARISH_BARS, { swingHighs: [BEARISH_SWING_HIGH], swingLows: [] });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].direction, 'bearish');
    assert.equal(hits[0].index, 4);
    assert.equal(hits[0].entry, 99);
    assert.equal(hits[0].level, 100);
    assert.equal(hits[0].stop, 110);
    assert.equal(hits[0].biasIndex, 1);
  });

  it('finds nothing when the swing-extreme candle is not a qualifying pinbar', () => {
    const { hits } = scanForPinbarSetup(BULLISH_BARS, { swingHighs: [], swingLows: [{ index: 2, price: 101 }] });
    assert.equal(hits.length, 0);
  });

  it('rejects an empty bar array or malformed swing point arrays', () => {
    assert.throws(() => scanForPinbarSetup([], { swingHighs: [], swingLows: [BULLISH_SWING_LOW] }));
    assert.throws(() => scanForPinbarSetup(BULLISH_BARS, { swingHighs: [{ price: 100 }], swingLows: [] }));
  });
});

describe('buildPinbarTradePlan()', () => {
  it('builds a long plan from a confirmed bullish pinbar setup, stop below the pinbar low', () => {
    const { hits } = scanForPinbarSetup(BULLISH_BARS, { swingHighs: [], swingLows: [BULLISH_SWING_LOW] });
    const plan = buildPinbarTradePlan({ hit: hits[0], lastSwingLevel: 120, rangeLevel: 130 });
    assert.equal(plan.side, 'long');
    assert.equal(plan.entry, 106);
    assert.equal(plan.stop, 90);
    assert.equal(plan.target, 120);
    assert.equal(plan.alternate_target, 130);
    assert.match(plan.confidence, /confluence/);
  });

  it('builds a short plan from a confirmed bearish pinbar setup, stop above the pinbar high', () => {
    const { hits } = scanForPinbarSetup(BEARISH_BARS, { swingHighs: [BEARISH_SWING_HIGH], swingLows: [] });
    const plan = buildPinbarTradePlan({ hit: hits[0], lastSwingLevel: 85, rangeLevel: 80 });
    assert.equal(plan.side, 'short');
    assert.equal(plan.entry, 99);
    assert.equal(plan.stop, 110);
    assert.equal(plan.target, 85);
    assert.equal(plan.alternate_target, 80);
  });

  it('requires at least one target', () => {
    const { hits } = scanForPinbarSetup(BULLISH_BARS, { swingHighs: [], swingLows: [BULLISH_SWING_LOW] });
    assert.throws(() => buildPinbarTradePlan({ hit: hits[0] }));
  });

  it('rejects an unconfirmed or malformed hit', () => {
    assert.throws(() => buildPinbarTradePlan({ hit: { detected: false }, lastSwingLevel: 120 }));
    assert.throws(() => buildPinbarTradePlan({ hit: { bar: {}, entry: 100, direction: 'sideways', stop: 90 }, lastSwingLevel: 120 }));
  });
});
