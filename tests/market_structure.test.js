/**
 * Tests for Market Structure (BOS/CHoCH) detection in core/market_structure.js.
 * Pure functions over OHLC bar arrays — swing points are supplied directly as
 * {index, price} fixtures (mirrors fibonacci.test.js) so the tests focus on
 * the structure-labeling/break-confirmation logic, not swing-point-finding
 * (already covered by sfp.test.js's findSwingHighs/findSwingLows suite).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSwingSequence,
  scanForCloseBreak,
  detectMarketStructure,
  buildStructureTradePlan,
} from '../src/core/market_structure.js';

function bar({ open, high, low, close }) {
  return { open, high, low, close };
}

// Uptrend: HL(104) -> HH(120) confirms a bullish BOS (close > 110 at idx8),
// then a clean single pullback cycle: bearish CHoCH (close < 108 at idx13)
// followed by a realigning bullish CHoCH (close > 113 at idx16) — the
// curriculum's textbook long-entry trigger (Ch.5 fig.8).
const BULLISH_BARS = [
  bar({ open: 100, high: 102, low: 99, close: 100 }),   // 0 — swing low (100)
  bar({ open: 101, high: 104, low: 100, close: 103 }),  // 1
  bar({ open: 104, high: 107, low: 103, close: 106 }),  // 2
  bar({ open: 107, high: 110, low: 106, close: 109 }),  // 3 — swing high (110)
  bar({ open: 109, high: 110, low: 105, close: 107 }),  // 4
  bar({ open: 107, high: 109, low: 103, close: 105 }),  // 5
  bar({ open: 105, high: 107, low: 103, close: 104 }),  // 6 — swing low (104, HL)
  bar({ open: 104, high: 109, low: 103, close: 108 }),  // 7
  bar({ open: 108, high: 116, low: 107, close: 115 }),  // 8 — BOS: closes above 110
  bar({ open: 115, high: 120, low: 114, close: 118 }),  // 9 — swing high (120, HH)
  bar({ open: 118, high: 119, low: 112, close: 114 }),  // 10
  bar({ open: 114, high: 115, low: 109, close: 110 }),  // 11
  bar({ open: 110, high: 111, low: 108, close: 109 }),  // 12 — swing low (108, pullback)
  bar({ open: 109, high: 110, low: 106, close: 107 }),  // 13 — CHoCH#1 (bearish): closes below 108
  bar({ open: 107, high: 112, low: 106, close: 111 }),  // 14
  bar({ open: 111, high: 113, low: 110, close: 112 }),  // 15 — swing high (113, pullback)
  bar({ open: 112, high: 115, low: 111, close: 114 }),  // 16 — CHoCH#2 (bullish): closes above 113
  bar({ open: 114, high: 116, low: 112, close: 115 }),  // 17
  bar({ open: 115, high: 116, low: 109, close: 110 }),  // 18 — swing low (109, HL — no further CHoCH)
  bar({ open: 110, high: 112, low: 108, close: 111 }),  // 19
];
const BULLISH_SWING_HIGHS = [{ index: 3, price: 110 }, { index: 9, price: 120 }, { index: 15, price: 113 }];
const BULLISH_SWING_LOWS = [{ index: 0, price: 100 }, { index: 6, price: 104 }, { index: 12, price: 108 }, { index: 18, price: 109 }];

// Downtrend: LH(116) -> LL(95) confirms a bearish BOS (close < 110 at idx8),
// then a clean single pullback cycle: bullish CHoCH (close > 104 at idx13)
// followed by a realigning bearish CHoCH (close < 98 at idx16) — the
// curriculum's textbook short-entry trigger (Ch.4 example 2's "double CHoCH").
const BEARISH_BARS = [
  bar({ open: 118, high: 120, low: 117, close: 119 }), // 0 — swing high (120)
  bar({ open: 117, high: 118, low: 113, close: 114 }), // 1
  bar({ open: 114, high: 116, low: 111, close: 112 }), // 2
  bar({ open: 112, high: 113, low: 110, close: 111 }), // 3 — swing low (110)
  bar({ open: 111, high: 115, low: 110, close: 113 }), // 4
  bar({ open: 113, high: 116, low: 112, close: 115 }), // 5
  bar({ open: 115, high: 116, low: 113, close: 115 }), // 6 — swing high (116, LH)
  bar({ open: 115, high: 116, low: 109, close: 110 }), // 7
  bar({ open: 110, high: 111, low: 95, close: 96 }),   // 8 — BOS: closes below 110
  bar({ open: 96, high: 98, low: 94, close: 95 }),     // 9 — swing low (95, LL)
  bar({ open: 95, high: 99, low: 94, close: 98 }),     // 10
  bar({ open: 98, high: 103, low: 97, close: 101 }),   // 11
  bar({ open: 101, high: 104, low: 100, close: 102 }), // 12 — swing high (104, pullback)
  bar({ open: 102, high: 106, low: 101, close: 105 }), // 13 — CHoCH#1 (bullish): closes above 104
  bar({ open: 105, high: 106, low: 99, close: 100 }),  // 14
  bar({ open: 100, high: 101, low: 98, close: 99 }),   // 15 — swing low (98, pullback)
  bar({ open: 99, high: 100, low: 96, close: 97 }),    // 16 — CHoCH#2 (bearish): closes below 98
  bar({ open: 97, high: 99, low: 96, close: 98 }),     // 17
  bar({ open: 98, high: 103, low: 97, close: 102 }),   // 18 — swing high (103, LH — no further CHoCH)
  bar({ open: 102, high: 103, low: 100, close: 101 }), // 19
];
const BEARISH_SWING_HIGHS = [{ index: 0, price: 120 }, { index: 6, price: 116 }, { index: 12, price: 104 }, { index: 18, price: 103 }];
const BEARISH_SWING_LOWS = [{ index: 3, price: 110 }, { index: 9, price: 95 }, { index: 15, price: 98 }];

describe('buildSwingSequence()', () => {
  it('merges and labels HH/HL/LH/LL relative to the prior point of the same type', () => {
    const seq = buildSwingSequence(BULLISH_SWING_HIGHS, BULLISH_SWING_LOWS);
    const labels = seq.map(p => `${p.type}:${p.price}:${p.label}`);
    assert.deepEqual(labels, [
      'low:100:null', 'high:110:null', 'low:104:HL', 'high:120:HH', 'low:108:HL', 'high:113:LH', 'low:109:HL',
    ]);
  });

  it('collapses consecutive same-type points to the more extreme one', () => {
    const seq = buildSwingSequence([{ index: 1, price: 100 }, { index: 3, price: 105 }], [{ index: 5, price: 90 }]);
    assert.equal(seq.length, 2);
    assert.deepEqual(seq[0], { type: 'high', index: 3, price: 105, bar: undefined, label: null, prior: null });
  });

  it('rejects malformed swing point arrays', () => {
    assert.throws(() => buildSwingSequence([{ price: 100 }], []));
    assert.throws(() => buildSwingSequence('not-an-array', []));
  });
});

describe('scanForCloseBreak()', () => {
  it('finds the first close-based break above a level within bounds', () => {
    const result = scanForCloseBreak(BULLISH_BARS, { level: 110, direction: 'above', fromIndex: 4, toIndex: 9 });
    assert.equal(result.index, 8);
  });

  it('finds the first close-based break below a level', () => {
    const result = scanForCloseBreak(BULLISH_BARS, { level: 108, direction: 'below', fromIndex: 13 });
    assert.equal(result.index, 13);
  });

  it('returns null when no close crosses the level within bounds', () => {
    assert.equal(scanForCloseBreak(BULLISH_BARS, { level: 200, direction: 'above', fromIndex: 0 }), null);
  });

  it('rejects an unknown direction', () => {
    assert.throws(() => scanForCloseBreak(BULLISH_BARS, { level: 110, direction: 'sideways' }));
  });
});

describe('detectMarketStructure() — bullish leg', () => {
  const result = detectMarketStructure(BULLISH_BARS, { swingHighs: BULLISH_SWING_HIGHS, swingLows: BULLISH_SWING_LOWS });

  it('confirms a bullish BOS at the HH formation, with the prior HL as the deep counter-point', () => {
    assert.equal(result.trend, 'bullish');
    assert.equal(result.bos.length, 1);
    assert.equal(result.bos[0].direction, 'bullish');
    assert.equal(result.bos[0].index, 8);
    assert.equal(result.bos[0].level, 110);
    assert.equal(result.bos[0].deepCounterPoint.price, 104);
  });

  it('finds a bearish CHoCH (first sign of weakness) followed by a realigning bullish CHoCH (entry trigger)', () => {
    assert.equal(result.choch.length, 2);
    assert.equal(result.choch[0].direction, 'bearish');
    assert.equal(result.choch[0].sequenceNumber, 1);
    assert.equal(result.choch[0].index, 13);
    assert.equal(result.choch[0].entry, 107);

    assert.equal(result.choch[1].direction, 'bullish');
    assert.equal(result.choch[1].sequenceNumber, 2);
    assert.equal(result.choch[1].index, 16);
    assert.equal(result.choch[1].entry, 114);
    assert.equal(result.choch[1].pullbackExtreme, 108);
  });
});

describe('detectMarketStructure() — bearish leg', () => {
  const result = detectMarketStructure(BEARISH_BARS, { swingHighs: BEARISH_SWING_HIGHS, swingLows: BEARISH_SWING_LOWS });

  it('confirms a bearish BOS at the LL formation, with the prior LH as the deep counter-point', () => {
    assert.equal(result.trend, 'bearish');
    assert.equal(result.bos.length, 1);
    assert.equal(result.bos[0].direction, 'bearish');
    assert.equal(result.bos[0].index, 8);
    assert.equal(result.bos[0].level, 110);
    assert.equal(result.bos[0].deepCounterPoint.price, 116);
  });

  it('finds a bullish CHoCH followed by a realigning bearish CHoCH (short entry trigger)', () => {
    assert.equal(result.choch.length, 2);
    assert.equal(result.choch[0].direction, 'bullish');
    assert.equal(result.choch[1].direction, 'bearish');
    assert.equal(result.choch[1].sequenceNumber, 2);
    assert.equal(result.choch[1].index, 16);
    assert.equal(result.choch[1].entry, 97);
    assert.equal(result.choch[1].pullbackExtreme, 104);
  });
});

describe('detectMarketStructure() — validation', () => {
  it('rejects an empty bar array', () => {
    assert.throws(() => detectMarketStructure([], { swingHighs: BULLISH_SWING_HIGHS, swingLows: BULLISH_SWING_LOWS }));
  });

  it('returns no structure when too few swing points exist to compare', () => {
    const result = detectMarketStructure(BULLISH_BARS, { swingHighs: [{ index: 3, price: 110 }], swingLows: [{ index: 0, price: 100 }] });
    assert.equal(result.trend, null);
    assert.deepEqual(result.bos, []);
    assert.deepEqual(result.choch, []);
  });
});

describe('buildStructureTradePlan()', () => {
  it('builds a long plan from a realigning bullish CHoCH, stop beyond the pullback extreme', () => {
    const { choch, trend } = detectMarketStructure(BULLISH_BARS, { swingHighs: BULLISH_SWING_HIGHS, swingLows: BULLISH_SWING_LOWS });
    const plan = buildStructureTradePlan({ choch: choch[1], trend, lastSwingLevel: 120, rangeLevel: 125 });
    assert.equal(plan.side, 'long');
    assert.equal(plan.entry, 114);
    assert.equal(plan.stop, 108);
    assert.equal(plan.target, 120);
    assert.equal(plan.alternate_target, 125);
    assert.match(plan.confidence, /clean single pullback/);
  });

  it('builds a short plan from a realigning bearish CHoCH, stop beyond the pullback extreme', () => {
    const { choch, trend } = detectMarketStructure(BEARISH_BARS, { swingHighs: BEARISH_SWING_HIGHS, swingLows: BEARISH_SWING_LOWS });
    const plan = buildStructureTradePlan({ choch: choch[1], trend, lastSwingLevel: 95, rangeLevel: 90 });
    assert.equal(plan.side, 'short');
    assert.equal(plan.entry, 97);
    assert.equal(plan.stop, 104);
    assert.equal(plan.target, 95);
    assert.equal(plan.alternate_target, 90);
  });

  it('rejects a CHoCH that opposes the established trend (the "first sign of weakness" is not a trigger)', () => {
    const { choch, trend } = detectMarketStructure(BULLISH_BARS, { swingHighs: BULLISH_SWING_HIGHS, swingLows: BULLISH_SWING_LOWS });
    assert.throws(() => buildStructureTradePlan({ choch: choch[0], trend, lastSwingLevel: 120 }));
  });

  it('requires at least one target', () => {
    const { choch, trend } = detectMarketStructure(BULLISH_BARS, { swingHighs: BULLISH_SWING_HIGHS, swingLows: BULLISH_SWING_LOWS });
    assert.throws(() => buildStructureTradePlan({ choch: choch[1], trend }));
  });

  it('rejects a missing/unconfirmed CHoCH or an invalid trend', () => {
    assert.throws(() => buildStructureTradePlan({ choch: {}, trend: 'bullish', lastSwingLevel: 120 }));
    const { choch } = detectMarketStructure(BULLISH_BARS, { swingHighs: BULLISH_SWING_HIGHS, swingLows: BULLISH_SWING_LOWS });
    assert.throws(() => buildStructureTradePlan({ choch: choch[1], trend: 'sideways', lastSwingLevel: 120 }));
  });
});
