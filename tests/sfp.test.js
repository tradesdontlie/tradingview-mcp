/**
 * Tests for Swing Failure Pattern detection in core/sfp.js.
 * Pure functions over OHLC bar arrays — no live chart/exchange connection needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findSwingHighs,
  findSwingLows,
  isDoji,
  detectSFP,
  scanForSFP,
  buildSFPTradePlan,
} from '../src/core/sfp.js';

function bar({ open, high, low, close }) {
  return { open, high, low, close };
}

describe('findSwingHighs() / findSwingLows()', () => {
  it('finds a single local-maximum swing high within the lookback window', () => {
    const bars = [
      bar({ open: 10, high: 11, low: 9, close: 10 }),
      bar({ open: 10, high: 12, low: 10, close: 11 }),
      bar({ open: 11, high: 15, low: 11, close: 14 }), // swing high here
      bar({ open: 14, high: 13, low: 12, close: 12 }),
      bar({ open: 12, high: 12, low: 11, close: 11 }),
    ];
    const swings = findSwingHighs(bars, { lookback: 2 });
    assert.equal(swings.length, 1);
    assert.equal(swings[0].index, 2);
    assert.equal(swings[0].price, 15);
  });

  it('finds a single local-minimum swing low within the lookback window', () => {
    const bars = [
      bar({ open: 10, high: 11, low: 9, close: 10 }),
      bar({ open: 10, high: 10, low: 8, close: 9 }),
      bar({ open: 9, high: 9, low: 5, close: 6 }), // swing low here
      bar({ open: 6, high: 8, low: 6, close: 7 }),
      bar({ open: 7, high: 9, low: 7, close: 8 }),
    ];
    const swings = findSwingLows(bars, { lookback: 2 });
    assert.equal(swings.length, 1);
    assert.equal(swings[0].index, 2);
    assert.equal(swings[0].price, 5);
  });

  it('rejects a non-positive-integer lookback', () => {
    assert.throws(() => findSwingHighs([bar({ open: 1, high: 1, low: 1, close: 1 })], { lookback: 0 }));
  });
});

describe('isDoji()', () => {
  it('flags a candle whose body is small relative to its range', () => {
    assert.equal(isDoji(bar({ open: 100, high: 105, low: 95, close: 100.2 })), true);
  });

  it('does not flag a candle with a substantial body', () => {
    assert.equal(isDoji(bar({ open: 100, high: 106, low: 99, close: 105 })), false);
  });

  it('treats a zero-range candle as a doji', () => {
    assert.equal(isDoji(bar({ open: 100, high: 100, low: 100, close: 100 })), true);
  });
});

describe('detectSFP()', () => {
  it('detects a bearish SFP: wicks above the level but closes back below it', () => {
    const result = detectSFP({ bar: bar({ open: 99, high: 102, low: 98, close: 99.5 }), level: 100, type: 'bearish' });
    assert.equal(result.detected, true);
    assert.equal(result.entry, 99.5);
    assert.equal(result.stop, 102);
  });

  it('does not detect a bearish SFP when the candle closes above the level (genuine breakout)', () => {
    const result = detectSFP({ bar: bar({ open: 99, high: 103, low: 98, close: 102 }), level: 100, type: 'bearish' });
    assert.equal(result.detected, false);
  });

  it('does not detect a bearish SFP when the high never exceeds the level', () => {
    const result = detectSFP({ bar: bar({ open: 98, high: 99.5, low: 97, close: 99 }), level: 100, type: 'bearish' });
    assert.equal(result.detected, false);
  });

  it('detects a bullish SFP: wicks below the level but closes back above it', () => {
    const result = detectSFP({ bar: bar({ open: 101, high: 102, low: 98, close: 100.5 }), level: 100, type: 'bullish' });
    assert.equal(result.detected, true);
    assert.equal(result.entry, 100.5);
    assert.equal(result.stop, 98);
  });

  it('does not detect a bullish SFP when the candle closes below the level (genuine breakdown)', () => {
    const result = detectSFP({ bar: bar({ open: 101, high: 102, low: 97, close: 98 }), level: 100, type: 'bullish' });
    assert.equal(result.detected, false);
  });

  it('rejects an unknown type', () => {
    assert.throws(() => detectSFP({ bar: bar({ open: 1, high: 2, low: 1, close: 1 }), level: 1, type: 'sideways' }));
  });
});

describe('scanForSFP()', () => {
  it('finds a first SFP and tags a later sweep of the same level as a higher-conviction retest', () => {
    const bars = [
      bar({ open: 99, high: 99.5, low: 98, close: 99 }),       // no sweep
      bar({ open: 99, high: 102, low: 98.5, close: 99.5 }),    // first SFP (bearish, level 100)
      bar({ open: 99.5, high: 99.8, low: 99, close: 99.6 }),   // no sweep
      bar({ open: 99.5, high: 101.5, low: 99.2, close: 99.8 }),// retest SFP
    ];
    const hits = scanForSFP(bars, { level: 100, type: 'bearish' });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].kind, 'first');
    assert.equal(hits[0].index, 1);
    assert.equal(hits[1].kind, 'retest');
    assert.equal(hits[1].index, 3);
  });

  it('skips doji sweep candles by default', () => {
    const bars = [
      bar({ open: 99.95, high: 102, low: 98, close: 99.9 }), // genuine SFP shape, but a doji (tiny body vs range)
    ];
    assert.equal(scanForSFP(bars, { level: 100, type: 'bearish' }).length, 0);
    assert.equal(scanForSFP(bars, { level: 100, type: 'bearish', skipDojis: false }).length, 1);
  });
});

describe('buildSFPTradePlan()', () => {
  it('builds a short trade plan from a confirmed bearish SFP, picking the nearer favorable target as primary', () => {
    const hit = { entry: 99.5, stop: 102, kind: 'first' };
    const plan = buildSFPTradePlan({ hit, type: 'bearish', lastSwingLevel: 95, rangeLevel: 90 });
    assert.equal(plan.side, 'short');
    assert.equal(plan.entry, 99.5);
    assert.equal(plan.stop, 102);
    assert.equal(plan.target, 95);          // nearer target for a short = the higher of the two downside levels
    assert.equal(plan.alternate_target, 90);
    assert.equal(plan.confidence, 'standard (first entry)');
  });

  it('builds a long trade plan from a confirmed bullish SFP and flags retest hits as higher conviction', () => {
    const hit = { entry: 100.5, stop: 98, kind: 'retest' };
    const plan = buildSFPTradePlan({ hit, type: 'bullish', lastSwingLevel: 105, rangeLevel: 110 });
    assert.equal(plan.side, 'long');
    assert.equal(plan.target, 105);          // nearer target for a long = the lower of the two upside levels
    assert.equal(plan.alternate_target, 110);
    assert.equal(plan.confidence, 'higher (retest/second entry)');
  });

  it('requires at least one target', () => {
    assert.throws(() => buildSFPTradePlan({ hit: { entry: 100, stop: 99, kind: 'first' }, type: 'bullish' }));
  });

  it('produces output directly consumable by risk.evaluateTradeSetup()', async () => {
    const { evaluateTradeSetup } = await import('../src/core/risk.js');
    const hit = { entry: 99.5, stop: 102, kind: 'first' };
    const plan = buildSFPTradePlan({ hit, type: 'bearish', lastSwingLevel: 95 });
    const result = evaluateTradeSetup({
      capital: 10000,
      riskPercent: 2,
      entry: plan.entry,
      stop: plan.stop,
      target: plan.target,
      side: plan.side,
    });
    assert.ok(typeof result.passes === 'boolean');
    assert.ok(result.position_size > 0);
  });
});
