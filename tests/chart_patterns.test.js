/**
 * Tests for classic chart pattern detection in core/chart_patterns.js.
 * Pure functions over OHLC bar arrays + swing points — no live chart/exchange
 * connection needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findDoubleTopBottom,
  scanForNecklineBreak,
  buildDoubleTopBottomTradePlan,
  findHeadAndShoulders,
  buildHeadAndShouldersTradePlan,
  findTriangle,
  scanForTriangleBreakout,
  buildTriangleTradePlan,
  findFlagPennant,
  scanForFlagBreakout,
  buildFlagTradePlan,
} from '../src/core/chart_patterns.js';

function bar({ open, high, low, close }) {
  return { open, high, low, close };
}
function flatBars(n, price = 100) {
  return Array.from({ length: n }, () => bar({ open: price, high: price, low: price, close: price }));
}

describe('findDoubleTopBottom()', () => {
  it('detects a double top with neckline = deepest swing low between the two peaks', () => {
    const swingHighs = [{ index: 2, price: 110 }, { index: 6, price: 110.5 }];
    const swingLows = [{ index: 4, price: 100 }];
    const patterns = findDoubleTopBottom(flatBars(8), { swingHighs, swingLows });
    assert.equal(patterns.length, 1);
    const p = patterns[0];
    assert.equal(p.type, 'double_top');
    assert.equal(p.necklineLevel, 100);
    assert.equal(p.breakoutDirection, 'below');
    assert.equal(p.side, 'short');
    assert.equal(p.height, 10.5);
    assert.equal(p.stopLevel, 110.5);
    assert.equal(p.fromIndex, 7);
  });

  it('rejects peaks beyond tolerance', () => {
    const swingHighs = [{ index: 2, price: 100 }, { index: 6, price: 110 }];
    const swingLows = [{ index: 4, price: 95 }];
    assert.equal(findDoubleTopBottom(flatBars(8), { swingHighs, swingLows }).length, 0);
  });

  it('detects a double bottom with neckline = highest swing high between the two troughs', () => {
    const swingLows = [{ index: 2, price: 90 }, { index: 6, price: 90.3 }];
    const swingHighs = [{ index: 4, price: 100 }];
    const patterns = findDoubleTopBottom(flatBars(8), { swingHighs, swingLows });
    assert.equal(patterns.length, 1);
    const p = patterns[0];
    assert.equal(p.type, 'double_bottom');
    assert.equal(p.necklineLevel, 100);
    assert.equal(p.breakoutDirection, 'above');
    assert.equal(p.side, 'long');
    assert.equal(p.height, 10);
    assert.equal(p.stopLevel, 90);
  });
});

describe('scanForNecklineBreak() + buildDoubleTopBottomTradePlan()', () => {
  const swingHighs = [{ index: 2, price: 110 }, { index: 6, price: 110.5 }];
  const swingLows = [{ index: 4, price: 100 }];

  it('builds a short plan from a confirmed double-top neckline break', () => {
    const bars = [
      ...flatBars(7),
      bar({ open: 100, high: 100, low: 94, close: 95 }), // bar 7: closes below neckline (100)
    ];
    const pattern = findDoubleTopBottom(bars, { swingHighs, swingLows })[0];
    const breakout = scanForNecklineBreak(bars, pattern);
    assert.ok(breakout);
    assert.equal(breakout.index, 7);

    const plan = buildDoubleTopBottomTradePlan({ pattern, breakout, rangeLevel: 80 });
    assert.equal(plan.side, 'short');
    assert.equal(plan.entry, 95);
    assert.equal(plan.stop, 110.5);
    assert.equal(plan.target, 100 - 10.5); // measured move from the neckline (100), not entry (95)
    assert.equal(plan.alternate_target, 80);
  });

  it('returns null when no neckline break has occurred yet', () => {
    const bars = flatBars(8, 105); // never closes below 100
    const pattern = findDoubleTopBottom(bars, { swingHighs, swingLows })[0];
    assert.equal(scanForNecklineBreak(bars, pattern), null);
  });
});

describe('findHeadAndShoulders()', () => {
  it('detects a head & shoulders with neckline = higher flanking swing low', () => {
    const swingHighs = [{ index: 1, price: 105 }, { index: 3, price: 115 }, { index: 5, price: 106 }];
    const swingLows = [{ index: 2, price: 98 }, { index: 4, price: 100 }];
    const patterns = findHeadAndShoulders(flatBars(7), { swingHighs, swingLows });
    assert.equal(patterns.length, 1);
    const p = patterns[0];
    assert.equal(p.type, 'head_and_shoulders');
    assert.equal(p.necklineLevel, 100);
    assert.equal(p.breakoutDirection, 'below');
    assert.equal(p.side, 'short');
    assert.equal(p.height, 15);
    assert.equal(p.stopLevel, 115);
    assert.equal(p.fromIndex, 6);
  });

  it('rejects when the head is not the most extreme point', () => {
    const swingHighs = [{ index: 1, price: 110 }, { index: 3, price: 105 }, { index: 5, price: 108 }];
    const swingLows = [{ index: 2, price: 98 }, { index: 4, price: 100 }];
    assert.equal(findHeadAndShoulders(flatBars(7), { swingHighs, swingLows }).length, 0);
  });

  it('detects an inverse head & shoulders with neckline = lower flanking swing high', () => {
    const swingLows = [{ index: 1, price: 95 }, { index: 3, price: 85 }, { index: 5, price: 94 }];
    const swingHighs = [{ index: 2, price: 102 }, { index: 4, price: 100 }];
    const patterns = findHeadAndShoulders(flatBars(7), { swingHighs, swingLows });
    assert.equal(patterns.length, 1);
    const p = patterns[0];
    assert.equal(p.type, 'inverse_head_and_shoulders');
    assert.equal(p.necklineLevel, 100);
    assert.equal(p.breakoutDirection, 'above');
    assert.equal(p.side, 'long');
    assert.equal(p.height, 15);
    assert.equal(p.stopLevel, 85);
  });
});

describe('buildHeadAndShouldersTradePlan()', () => {
  it('builds a long plan from a confirmed inverse H&S neckline break', () => {
    const swingLows = [{ index: 1, price: 95 }, { index: 3, price: 85 }, { index: 5, price: 94 }];
    const swingHighs = [{ index: 2, price: 102 }, { index: 4, price: 100 }];
    const bars = [
      ...flatBars(6),
      bar({ open: 100, high: 106, low: 100, close: 105 }), // bar 6: closes above neckline (100)
    ];
    const pattern = findHeadAndShoulders(bars, { swingHighs, swingLows })[0];
    const breakout = scanForNecklineBreak(bars, pattern);
    assert.ok(breakout);

    const plan = buildHeadAndShouldersTradePlan({ pattern, breakout });
    assert.equal(plan.side, 'long');
    assert.equal(plan.entry, 105);
    assert.equal(plan.stop, 85);
    assert.equal(plan.target, 100 + 15); // measured move from the neckline (100), not entry (105)
  });
});

describe('findTriangle() / scanForTriangleBreakout() / buildTriangleTradePlan()', () => {
  it('classifies an ascending triangle (flat resistance, rising support) and confirms a breakout above', () => {
    const swingHighs = [{ index: 0, price: 100 }, { index: 10, price: 100.05 }];
    const swingLows = [{ index: 0, price: 90 }, { index: 10, price: 95 }];
    const bars = [
      ...flatBars(11, 100),
      bar({ open: 100, high: 102, low: 100, close: 101 }), // bar 11: breaks above projected upper line
    ];
    const triangle = findTriangle(bars, { swingHighs, swingLows });
    assert.ok(triangle);
    assert.equal(triangle.type, 'ascending_triangle');
    assert.equal(triangle.fromIndex, 11);

    const breakout = scanForTriangleBreakout(bars, triangle);
    assert.ok(breakout);
    assert.equal(breakout.side, 'long');
    assert.equal(breakout.index, 11);

    const plan = buildTriangleTradePlan({ triangle, breakout });
    assert.equal(plan.side, 'long');
    assert.equal(plan.entry, 101);
    assert.equal(plan.stop, 95);
    assert.equal(plan.target, breakout.level + triangle.height); // measured move from the broken trendline's level, not entry (101)
  });

  it('classifies a descending triangle (flat support, falling resistance) and confirms a breakout below', () => {
    const swingHighs = [{ index: 0, price: 110 }, { index: 10, price: 105 }];
    const swingLows = [{ index: 0, price: 95 }, { index: 10, price: 95.02 }];
    const bars = [
      ...flatBars(11, 100),
      bar({ open: 95, high: 95, low: 90, close: 91 }), // bar 11: breaks below projected lower line
    ];
    const triangle = findTriangle(bars, { swingHighs, swingLows });
    assert.ok(triangle);
    assert.equal(triangle.type, 'descending_triangle');

    const breakout = scanForTriangleBreakout(bars, triangle);
    assert.ok(breakout);
    assert.equal(breakout.side, 'short');

    const plan = buildTriangleTradePlan({ triangle, breakout });
    assert.equal(plan.side, 'short');
    assert.equal(plan.stop, 105);
  });

  it('returns null when fewer than 2 swing highs/lows are available', () => {
    const swingHighs = [{ index: 0, price: 100 }];
    const swingLows = [{ index: 0, price: 90 }, { index: 4, price: 91 }];
    assert.equal(findTriangle(flatBars(5), { swingHighs, swingLows }), null);
  });
});

describe('findFlagPennant() / scanForFlagBreakout() / buildFlagTradePlan()', () => {
  const poleBars = Array.from({ length: 10 }, (_, i) =>
    bar({ open: i === 0 ? 100 : 105, high: 120, low: 100, close: i === 9 ? 120 : 110 })
  );
  const flagBars = Array.from({ length: 8 }, () => bar({ open: 115, high: 118, low: 113, close: 115 }));
  const bars18 = [...poleBars, ...flagBars];

  it('detects a bullish flag after a directional flagpole with a tight consolidation', () => {
    const pattern = findFlagPennant(bars18, { poleLookback: 10, flagLookback: 8 });
    assert.ok(pattern);
    assert.equal(pattern.type, 'flag_pennant');
    assert.equal(pattern.side, 'long');
    assert.equal(pattern.breakoutLevel, 118);
    assert.equal(pattern.stopLevel, 113);
    assert.equal(pattern.height, 20);
    assert.equal(pattern.fromIndex, 18);
  });

  it('confirms a breakout and builds a long plan with a measured-move target', () => {
    const pattern = findFlagPennant(bars18, { poleLookback: 10, flagLookback: 8 });
    const bars19 = [...bars18, bar({ open: 118, high: 125, low: 118, close: 120 })];
    const breakout = scanForFlagBreakout(bars19, pattern);
    assert.ok(breakout);
    assert.equal(breakout.index, 18);

    const plan = buildFlagTradePlan({ pattern, breakout });
    assert.equal(plan.side, 'long');
    assert.equal(plan.entry, 120);
    assert.equal(plan.stop, 113);
    assert.equal(plan.target, 138); // measured move from the consolidation's breakout edge (118), not entry (120)
  });

  it('returns null when the pole is not directional enough (choppy range)', () => {
    const choppyPole = Array.from({ length: 10 }, () => bar({ open: 110, high: 120, low: 100, close: 110 }));
    assert.equal(findFlagPennant([...choppyPole, ...flagBars], { poleLookback: 10, flagLookback: 8 }), null);
  });

  it('returns null when the consolidation is not tight enough', () => {
    const wideFlag = Array.from({ length: 8 }, () => bar({ open: 100, high: 130, low: 90, close: 110 }));
    assert.equal(findFlagPennant([...poleBars, ...wideFlag], { poleLookback: 10, flagLookback: 8 }), null);
  });
});
