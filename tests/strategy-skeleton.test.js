/**
 * Phase 2A engine skeleton tests.
 * Runs offline — no TradingView connection required.
 *
 * Run: node --test tests/strategy-skeleton.test.js
 *
 * Covers:
 *   - biasEngine:       classifyBias, buildMtfBias
 *   - sessionEngine:    extractSessionLevels
 *   - liquidityEngine:  detectSweep, detectReclaim
 *   - structureEngine:  detectMss, findDisplacementCandle
 *   - volumeEngine:     detectVolumeSurge
 *   - Full flow (5 required): LONG, SHORT, WAIT, wide-stop reject, expiry
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { classifyBias, buildMtfBias }           from '../engines/biasEngine.js';
import { extractSessionLevels }                 from '../engines/sessionEngine.js';
import { detectSweep, detectReclaim }           from '../engines/liquidityEngine.js';
import { detectMss, findDisplacementCandle,
         findSwingPoints }                       from '../engines/structureEngine.js';
import { detectVolumeSurge }                    from '../engines/volumeEngine.js';
import { buildSignal, checkExpiry }             from '../strategies/mtfSessionLiquidityTrap.js';
import { validate }                             from '../risk/riskManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(__dirname, '..', 'rules.json'), 'utf8'));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Creates bars trending upward. step > 0 → bullish, step < 0 → bearish. */
function makeBars(count, startPrice, step = 2, startTs = 1748000000000) {
  return Array.from({ length: count }, (_, i) => {
    const close = startPrice + i * step;
    const body  = Math.abs(step) * 0.7;
    return {
      ts:    startTs + i * 300_000,
      open:  close - (step >= 0 ? body : -body),
      high:  close + Math.abs(step) * 0.3,
      low:   close - Math.abs(step) * 0.3 - Math.abs(step) * 0.1,
      close,
      vol:   1000,
    };
  });
}

/** Flat bars at a single price. */
function makeFlatBars(count, price, startTs = 1748000000000) {
  return Array.from({ length: count }, (_, i) => ({
    ts: startTs + i * 300_000, open: price, high: price + 0.5, low: price - 0.5, close: price, vol: 1000,
  }));
}

/**
 * 20-bar zigzag with HH+HL structure (lookback=2).
 * Confirmed swing highs: index 2 (price 110), index 12 (price 116).
 * Confirmed swing lows:  index 7 (price  94), index 17 (price 100).
 */
function makeBullishZigzag() {
  return [
    // Phase 1 — rising to SH1=110
    { high: 104, low: 100, close: 102, vol: 1000 }, // 0
    { high: 107, low: 103, close: 105, vol: 1000 }, // 1
    { high: 110, low: 106, close: 108, vol: 1000 }, // 2  SH1=110
    { high: 107, low: 103, close: 105, vol: 1000 }, // 3
    { high: 104, low: 100, close: 102, vol: 1000 }, // 4
    // Phase 2 — falling to SL1=94
    { high: 107, low: 100, close: 103, vol: 1000 }, // 5
    { high: 104, low:  97, close: 100, vol: 1000 }, // 6
    { high: 101, low:  94, close:  97, vol: 1000 }, // 7  SL1=94
    { high: 104, low:  97, close: 100, vol: 1000 }, // 8
    { high: 107, low: 100, close: 103, vol: 1000 }, // 9
    // Phase 3 — rising to SH2=116  (HH: 116 > 110)
    { high: 110, low: 106, close: 108, vol: 1000 }, // 10
    { high: 113, low: 109, close: 111, vol: 1000 }, // 11
    { high: 116, low: 112, close: 114, vol: 1000 }, // 12  SH2=116
    { high: 113, low: 109, close: 111, vol: 1000 }, // 13
    { high: 110, low: 106, close: 108, vol: 1000 }, // 14
    // Phase 4 — falling to SL2=100  (HL: 100 > 94)
    { high: 113, low: 106, close: 109, vol: 1000 }, // 15
    { high: 110, low: 103, close: 106, vol: 1000 }, // 16
    { high: 107, low: 100, close: 103, vol: 1000 }, // 17  SL2=100
    { high: 110, low: 103, close: 106, vol: 1000 }, // 18
    { high: 113, low: 106, close: 109, vol: 1000 }, // 19
  ];
}

/**
 * 20-bar zigzag with LH+LL structure (lookback=2).
 * Confirmed swing highs: index 2 (price 116), index 12 (price 107).
 * Confirmed swing lows:  index 7 (price  94), index 17 (price  85).
 */
function makeBearishZigzag() {
  return [
    // Phase 1 — rising to SH1=116
    { high: 110, low: 106, close: 108, vol: 1000 }, // 0
    { high: 113, low: 109, close: 111, vol: 1000 }, // 1
    { high: 116, low: 112, close: 114, vol: 1000 }, // 2  SH1=116
    { high: 113, low: 109, close: 111, vol: 1000 }, // 3
    { high: 110, low: 106, close: 108, vol: 1000 }, // 4
    // Phase 2 — falling to SL1=94 (steeper right side to avoid phantom SH at bar 9)
    { high: 107, low: 100, close: 103, vol: 1000 }, // 5
    { high: 101, low:  97, close:  99, vol: 1000 }, // 6
    { high:  98, low:  94, close:  96, vol: 1000 }, // 7  SL1=94
    { high: 101, low:  97, close:  99, vol: 1000 }, // 8
    { high: 104, low: 100, close: 102, vol: 1000 }, // 9
    // Phase 3 — rallying to SH2=107  (LH: 107 < 116)
    { high: 101, low:  97, close:  99, vol: 1000 }, // 10
    { high: 104, low: 100, close: 102, vol: 1000 }, // 11
    { high: 107, low: 103, close: 105, vol: 1000 }, // 12  SH2=107
    { high: 104, low: 100, close: 102, vol: 1000 }, // 13
    { high: 101, low:  97, close:  99, vol: 1000 }, // 14
    // Phase 4 — falling to SL2=85  (LL: 85 < 94)
    { high:  98, low:  91, close:  94, vol: 1000 }, // 15
    { high:  95, low:  88, close:  91, vol: 1000 }, // 16
    { high:  92, low:  85, close:  88, vol: 1000 }, // 17  SL2=85
    { high:  95, low:  88, close:  91, vol: 1000 }, // 18
    { high:  98, low:  91, close:  94, vol: 1000 }, // 19
  ];
}

/**
 * 20-bar zigzag with HH+LL (conflicting signals → neutral).
 * Same phases 1-3 as bullish, but phase 4 falls to SL2=88 (< SL1=94).
 */
function makeMixedZigzag() {
  return [
    // Phases 1-3 identical to bullish (SH1=110, SL1=94, SH2=116)
    { high: 104, low: 100, close: 102, vol: 1000 }, // 0
    { high: 107, low: 103, close: 105, vol: 1000 }, // 1
    { high: 110, low: 106, close: 108, vol: 1000 }, // 2  SH1=110
    { high: 107, low: 103, close: 105, vol: 1000 }, // 3
    { high: 104, low: 100, close: 102, vol: 1000 }, // 4
    { high: 107, low: 100, close: 103, vol: 1000 }, // 5
    { high: 104, low:  97, close: 100, vol: 1000 }, // 6
    { high: 101, low:  94, close:  97, vol: 1000 }, // 7  SL1=94
    { high: 104, low:  97, close: 100, vol: 1000 }, // 8
    { high: 107, low: 100, close: 103, vol: 1000 }, // 9
    { high: 110, low: 106, close: 108, vol: 1000 }, // 10
    { high: 113, low: 109, close: 111, vol: 1000 }, // 11
    { high: 116, low: 112, close: 114, vol: 1000 }, // 12  SH2=116
    { high: 113, low: 109, close: 111, vol: 1000 }, // 13
    { high: 110, low: 106, close: 108, vol: 1000 }, // 14
    // Phase 4 — falls to SL2=88, below SL1=94 → LL (conflicts with HH → neutral)
    { high: 109, low: 103, close: 106, vol: 1000 }, // 15
    { high: 103, low:  97, close: 100, vol: 1000 }, // 16
    { high:  97, low:  88, close:  92, vol: 1000 }, // 17  SL2=88
    { high: 100, low:  91, close:  95, vol: 1000 }, // 18
    { high: 103, low:  94, close:  98, vol: 1000 }, // 19
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// biasEngine
// ─────────────────────────────────────────────────────────────────────────────

describe('biasEngine', () => {
  it('classifyBias returns bullish on HH/HL structure', () => {
    // 20-bar zigzag: SH1=110 → SH2=116 (HH), SL1=94 → SL2=100 (HL)
    assert.equal(classifyBias(makeBullishZigzag()), 'bullish');
  });

  it('classifyBias returns bearish on LH/LL structure', () => {
    // 20-bar zigzag: SH1=116 → SH2=107 (LH), SL1=94 → SL2=85 (LL)
    assert.equal(classifyBias(makeBearishZigzag()), 'bearish');
  });

  it('classifyBias returns neutral on mixed structure (HH + LL)', () => {
    // 20-bar zigzag: SH1=110 → SH2=116 (HH) but SL1=94 → SL2=88 (LL) → conflicting → neutral
    assert.equal(classifyBias(makeMixedZigzag()), 'neutral');
  });

  it('classifyBias returns neutral when fewer than 2 confirmed swing highs or lows', () => {
    // Flat bars produce no swing points (all highs/lows identical → no strict pivot)
    assert.equal(classifyBias(makeFlatBars(10, 100)), 'neutral');
  });

  it('buildMtfBias sets permission=none on 4H/1H conflict', () => {
    const result = buildMtfBias({
      '4H':  makeBullishZigzag(),    // bullish  (HH/HL)
      '1H':  makeBearishZigzag(),    // bearish  (LH/LL)
      '15m': makeFlatBars(10, 105), // neutral
      '5m':  makeFlatBars(10, 105), // neutral
    });
    assert.equal(result['4H'],  'bullish');
    assert.equal(result['1H'],  'bearish');
    assert.equal(result.permission, 'none');
  });

  it('buildMtfBias sets permission=long when both 4H and 1H are bullish', () => {
    const result = buildMtfBias({
      '4H':  makeBullishZigzag(),
      '1H':  makeBullishZigzag(),
      '15m': makeBullishZigzag(),
      '5m':  makeBullishZigzag(),
    });
    assert.equal(result.permission, 'long');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sessionEngine
// ─────────────────────────────────────────────────────────────────────────────

describe('sessionEngine', () => {
  it('extracts Asia session high/low from timestamped bars', () => {
    // Asia window: UTC hour 23 or hour 0–4 (crossesMidnight)
    const asiaTs   = new Date('2026-05-02T01:00:00Z').getTime(); // UTC 01:00 → in Asia
    const londonTs = new Date('2026-05-02T09:00:00Z').getTime(); // UTC 09:00 → in London
    const priorTs  = new Date('2026-05-01T12:00:00Z').getTime(); // previous day

    const bars = [
      { ts: priorTs,  open: 21000, high: 21100, low: 20900, close: 21050, vol: 1000 },
      { ts: asiaTs,   open: 21200, high: 21300, low: 21150, close: 21250, vol: 2000 },
      { ts: londonTs, open: 21280, high: 21400, low: 21240, close: 21380, vol: 1500 },
    ];

    const levels = extractSessionLevels(bars);

    assert.equal(levels.asia.found,   true,  'Asia session should be found');
    assert.equal(levels.asia.high,    21300, 'Asia high should be 21300');
    assert.equal(levels.asia.low,     21150, 'Asia low should be 21150');
    assert.equal(levels.london.found, true,  'London session should be found');
    assert.equal(levels.priorDay.found, true, 'Prior day should be found');
    assert.equal(levels.priorDay.high, 21100, 'Prior day high should be 21100');
    assert.equal(levels.priorDay.low,  20900, 'Prior day low should be 20900');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// liquidityEngine
// ─────────────────────────────────────────────────────────────────────────────

describe('liquidityEngine', () => {
  const level = 21000;

  // bars: two normal bars then a sweep bar (low < 21000)
  const bars = [
    { low: 21050, high: 21100, close: 21080 }, // 0
    { low: 21010, high: 21080, close: 21050 }, // 1
    { low: 20990, high: 21020, close: 20995 }, // 2 — SWEEP (low < 21000)
    { low: 21005, high: 21070, close: 21060 }, // 3 — reclaim (close > 21000)
    { low: 21010, high: 21080, close: 21070 }, // 4
    { low: 21015, high: 21090, close: 21080 }, // 5
  ];

  it('detects sweep of a low level', () => {
    const result = detectSweep(bars, level, 'low');
    assert.equal(result.swept,         true, 'sweep should be detected');
    assert.equal(result.sweepBarIndex, 2,    'sweep bar index should be 2');
  });

  it('does not detect sweep when price stays above level', () => {
    const noBreach = [
      { low: 21010, high: 21100 },
      { low: 21005, high: 21080 },
      { low: 21002, high: 21060 },
    ];
    const result = detectSweep(noBreach, level, 'low');
    assert.equal(result.swept, false);
  });

  it('detects reclaim within window after sweep', () => {
    const result = detectReclaim(bars, 2, level, 'low', 5);
    assert.equal(result.reclaimed,         true, 'reclaim should be detected');
    assert.equal(result.reclaimBarIndex,   3,    'reclaim bar index should be 3');
    assert.equal(result.candlesToReclaim,  1,    'should take 1 candle to reclaim');
  });

  it('does not detect reclaim if window is exceeded', () => {
    // All bars after sweep stay below the level throughout the window
    const noReclaim = [
      { low: 21050, high: 21100, close: 21080 }, // 0
      { low: 21010, high: 21080, close: 21050 }, // 1
      { low: 20990, high: 21020, close: 20995 }, // 2 sweep
      { low: 20980, high: 21000, close: 20985 }, // 3
      { low: 20970, high: 20995, close: 20975 }, // 4
      { low: 20965, high: 20990, close: 20970 }, // 5
      { low: 20960, high: 20985, close: 20965 }, // 6
      { low: 20955, high: 20980, close: 20960 }, // 7 — still below
      { low: 21005, high: 21050, close: 21020 }, // 8 — reclaim, but OUTSIDE window of 5
    ];
    const result = detectReclaim(noReclaim, 2, level, 'low', 5);
    // window: bars 3,4,5,6,7 — all close below 21000 → no reclaim
    assert.equal(result.reclaimed, false, 'reclaim outside window should not be counted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// structureEngine
// ─────────────────────────────────────────────────────────────────────────────

describe('structureEngine', () => {
  it('detects bullish MSS after a sweep low', () => {
    // Bars 0–9: rising, max high = bars[9].high
    // Bar 10: sweep (low below prior lows)
    // Bar 11: MSS — high exceeds max high of bars 0–10
    const bars = Array.from({ length: 12 }, (_, i) => ({
      high:  i <= 9 ? 21000 + i : (i === 10 ? 21005 : 21015),
      low:   i <= 9 ? 20990 + i : (i === 10 ? 20980 : 21000),
      close: i <= 9 ? 21000 + i : (i === 10 ? 20990 : 21012),
    }));
    // bars[0..9].high → max = 21009 (bar 9). bar[10].high = 21005 < 21009.
    // refHigh = max(bars[0..10].high) = 21009.
    // bar[11].high = 21015 > 21009 → MSS!
    const result = detectMss(bars, 10, 'bullish');
    assert.equal(result.detected,   true, 'MSS should be detected');
    assert.equal(result.mssBarIndex, 11,  'MSS bar index should be 11');
  });

  it('returns no MSS when price never breaks the reference high', () => {
    const bars = Array.from({ length: 5 }, (_, i) => ({
      high: 21000 + i, low: 20990 + i, close: 21000 + i,
    }));
    // afterIndex = 3, refHigh = max(bars[0..3].high) = 21003
    // bar[4].high = 21004 > 21003 → MSS detected (this actually DOES detect)
    // Let me adjust: all post bars have high <= refHigh
    const noBars = [
      { high: 21010, low: 21000, close: 21005 },
      { high: 21008, low: 20998, close: 21003 },
      { high: 21006, low: 20996, close: 21001 }, // afterIndex
      { high: 21007, low: 20997, close: 21002 }, // < refHigh=21010
    ];
    const result = detectMss(noBars, 2, 'bullish');
    assert.equal(result.detected, false, 'MSS should not be detected when no higher high');
  });

  it('detects displacement candle by body and volume multipliers', () => {
    // 10 small-body, low-volume bars, then 1 large-body, high-volume bar
    const bars = Array.from({ length: 11 }, (_, i) => {
      if (i < 10) return { open: 100, high: 102, low: 99, close: 101, vol: 100 };
      return { open: 100, high: 120, low: 99, close: 115, vol: 400 }; // big body + surge
    });
    // avgBody = mean(1, 1, ..., 1) = 1. avgVol = 100.
    // bar[10]: body = 15 > 1*1.5=1.5 ✓. volRatio = 400/100 = 4 > 1.5 ✓
    const result = findDisplacementCandle(bars, 10);
    assert.ok(result !== null, 'displacement candle should be found');
    assert.equal(result.index,     10,       'displacement at index 10');
    assert.equal(result.direction, 'bullish', 'close > open → bullish');
    assert.ok(result.volumeRatio >= 1.5, 'volume ratio should meet threshold');
  });

  it('returns null when no displacement candle exists', () => {
    // All bars have same body and volume — none exceeds multiplier
    const bars = Array.from({ length: 12 }, () => ({
      open: 100, high: 101.5, low: 99.5, close: 101, vol: 100,
    }));
    const result = findDisplacementCandle(bars, 5);
    assert.equal(result, null, 'no displacement candle should be found');
  });

  it('findSwingPoints detects confirmed swing high and low in a zigzag', () => {
    // 7-bar up-down-up: peak at index 2 (high=106), trough at index 4 (low=96), lookback=2
    const bars = [
      { high: 100, low:  96, close:  98 }, // 0
      { high: 103, low:  99, close: 101 }, // 1
      { high: 106, low: 102, close: 104 }, // 2  SH=106
      { high: 103, low:  99, close: 101 }, // 3
      { high: 100, low:  96, close:  98 }, // 4  SL=96
      { high: 103, low:  99, close: 101 }, // 5
      { high: 106, low: 102, close: 104 }, // 6  (not checked — outside loop range)
    ];
    const { highs, lows } = findSwingPoints(bars, 2);
    assert.ok(highs.some(h => h.index === 2 && h.price === 106), 'swing high at index 2 price 106');
    assert.ok(lows.some(l => l.index === 4 && l.price === 96),  'swing low  at index 4 price 96');
  });

  it('findSwingPoints: swing high confirmed only after lookback right-side bars exist', () => {
    // Symmetric peak at index 3 with lookback=3 — needs bars 0,1,2 and 4,5,6 to be lower
    const peak = [
      { high: 100, low:  96, close:  98 }, // 0
      { high: 102, low:  98, close: 100 }, // 1
      { high: 104, low: 100, close: 102 }, // 2
      { high: 106, low: 102, close: 104 }, // 3  candidate SH
      { high: 104, low: 100, close: 102 }, // 4
      { high: 102, low:  98, close: 100 }, // 5
      { high: 100, low:  96, close:  98 }, // 6
    ];
    // All 7 bars present: bar 3 should be a confirmed swing high
    const { highs: withAll } = findSwingPoints(peak, 3);
    assert.ok(withAll.some(h => h.index === 3), 'peak at index 3 confirmed with 7 bars (lookback=3)');

    // Only 6 bars: loop range is [3, 3) — no iterations — bar 3 cannot be confirmed
    const { highs: partial } = findSwingPoints(peak.slice(0, 6), 3);
    assert.ok(!partial.some(h => h.index === 3), 'peak at index 3 NOT confirmed with only 6 bars (no lookahead)');
  });

  it('detectMss uses confirmed swing high as reference, not raw max spike', () => {
    // preSlice (bars 0-5): confirmed SH at index 2 price=205, plus a spike at index 5 (high=250, not a swing)
    // post-sweep bar 6: close=208 > confirmed SH 205 but 208 < spike 250
    // Old code (raw max=250): 210 high < 250 → no MSS
    // New code (confirmed SH=205): close 208 > 205 → MSS at index 6
    const bars = [
      { high: 195, low: 191, close: 193 }, // 0
      { high: 200, low: 196, close: 198 }, // 1
      { high: 205, low: 201, close: 203 }, // 2  confirmed SH=205
      { high: 202, low: 198, close: 200 }, // 3
      { high: 199, low: 195, close: 197 }, // 4  right-side confirmation complete
      { high: 250, low: 195, close: 200 }, // 5  afterIndex: spike (raw max=250, not a confirmed swing)
      { high: 210, low: 205, close: 208 }, // 6  close=208 > 205 → MSS
    ];
    const result = detectMss(bars, 5, 'bullish');
    assert.equal(result.detected,    true, 'MSS detected using confirmed swing reference (not spike)');
    assert.equal(result.mssBarIndex, 6,    'MSS bar index 6');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// volumeEngine
// ─────────────────────────────────────────────────────────────────────────────

describe('volumeEngine', () => {
  it('detects volume surge above threshold', () => {
    // bars 0–19: vol=100, bar 20: vol=500
    const bars = Array.from({ length: 21 }, (_, i) => ({ vol: i === 20 ? 500 : 100 }));
    const result = detectVolumeSurge(bars, 20, 20, 1.5);
    assert.equal(result.surge,  true,  'surge should be detected');
    assert.ok(result.ratio >= 1.5,    'ratio should be at least 1.5');
  });

  it('does not detect surge when volume is at average', () => {
    const bars = Array.from({ length: 21 }, () => ({ vol: 100 }));
    const result = detectVolumeSurge(bars, 20, 20, 1.5);
    assert.equal(result.surge, false, 'no surge when volume equals average');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REQUIRED 1 — Bullish sweep + reclaim + MSS → LONG candidate with confidence ≥ A
// ─────────────────────────────────────────────────────────────────────────────

describe('MTF Session Liquidity Trap — full flow', () => {
  const TS = '2026-05-21T09:30:00.000Z';

  // Shared session levels for LONG tests
  const longLevels = {
    asia:        { high: 21100, low: 21000, poc: 21050, found: true  },
    london:      { high: 21080, low: 21010, poc: 21045, found: true  },
    nyOpenRange: { high: 21090, low: 21020,              found: true  },
    priorDay:    { high: 21200, low: 20900,              found: true  },
  };

  // Shared session levels for SHORT tests
  const shortLevels = {
    asia:        { high: 21200, low: 21050, poc: 21125, found: true  },
    london:      { high: 21190, low: 21060, poc: 21125, found: true  },
    nyOpenRange: { high: 21180, low: 21070,              found: true  },
    priorDay:    { high: 21300, low: 21000,              found: true  },
  };

  it('REQUIRED 1: bullish sweep + reclaim + MSS → LONG, confidence ≥ A', () => {
    const engineOutputs = {
      biasResult:        { '4H': 'bullish', '1H': 'bullish', '15m': 'bullish', '5m': 'bullish', permission: 'long' },
      sessionLevels:     longLevels,
      sweepResult:       { swept: true,  sweepBarIndex: 10 },
      sweepLevel:        21000,
      sweepDirection:    'low',
      reclaimResult:     { reclaimed: true, reclaimBarIndex: 12, candlesToReclaim: 2 },
      mssResult:         { detected: true, mssBarIndex: 14 },
      displacementCandle:{ index: 13, direction: 'bullish', bodySize: 15, volumeRatio: 2.2 },
      volumeResult:      { surge: true, ratio: 2.2 },
    };

    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS });

    assert.equal(signal.decision,              'LONG', 'decision must be LONG');
    assert.ok(['A+', 'A'].includes(signal.confidence), `confidence should be A+ or A, got ${signal.confidence}`);
    assert.equal(signal.symbol,                'MNQ1!');
    assert.ok(signal.entry  != null,           'entry must be defined');
    assert.ok(signal.stop   != null,           'stop must be defined');
    assert.ok(signal.tp1    != null,           'tp1 must be defined');
    assert.ok(signal.r      > 0,               'R must be positive');
    assert.equal(signal.status,                'pending');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REQUIRED 2 — Bearish sweep + reclaim + MSS → SHORT candidate with confidence ≥ A
  // ─────────────────────────────────────────────────────────────────────────

  it('REQUIRED 2: bearish sweep + reclaim + MSS → SHORT, confidence ≥ A', () => {
    const engineOutputs = {
      biasResult:        { '4H': 'bearish', '1H': 'bearish', '15m': 'bearish', '5m': 'bearish', permission: 'short' },
      sessionLevels:     shortLevels,
      sweepResult:       { swept: true,  sweepBarIndex: 10 },
      sweepLevel:        21200,
      sweepDirection:    'high',
      reclaimResult:     { reclaimed: true, reclaimBarIndex: 12, candlesToReclaim: 2 },
      mssResult:         { detected: true, mssBarIndex: 14 },
      displacementCandle:{ index: 13, direction: 'bearish', bodySize: 15, volumeRatio: 2.2 },
      volumeResult:      { surge: true, ratio: 2.2 },
    };

    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS });

    assert.equal(signal.decision, 'SHORT', 'decision must be SHORT');
    assert.ok(['A+', 'A'].includes(signal.confidence), `confidence should be A+ or A, got ${signal.confidence}`);
    assert.ok(signal.entry  != null, 'entry must be defined');
    assert.ok(signal.stop   != null, 'stop must be defined');
    assert.ok(signal.tp1    != null, 'tp1 must be defined');
    assert.ok(signal.r      > 0,    'R must be positive');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REQUIRED 3 — Mixed MTF bias → WAIT (no permission granted)
  // ─────────────────────────────────────────────────────────────────────────

  it('REQUIRED 3: 4H/1H conflict → WAIT', () => {
    const engineOutputs = {
      biasResult:        { '4H': 'bullish', '1H': 'bearish', '15m': 'neutral', '5m': 'neutral', permission: 'none' },
      sessionLevels:     { asia: { found: false }, london: { found: false }, nyOpenRange: { found: false }, priorDay: { found: false } },
      sweepResult:       { swept: false, sweepBarIndex: null },
      sweepLevel:        null,
      sweepDirection:    null,
      reclaimResult:     { reclaimed: false, reclaimBarIndex: null, candlesToReclaim: null },
      mssResult:         { detected: false, mssBarIndex: null },
      displacementCandle: null,
      volumeResult:      { surge: false, ratio: 0 },
    };

    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS });

    assert.equal(signal.decision,    'WAIT',  'conflict should produce WAIT');
    assert.equal(signal.confidence,  'Reject', 'confidence should be Reject');
    assert.ok(signal.reasons.some(r => r.toLowerCase().includes('conflict') || r.toLowerCase().includes('permission')),
              'reason should mention conflict or permission');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REQUIRED 4 — Risk manager rejects a signal with a stop that is too wide
  // ─────────────────────────────────────────────────────────────────────────

  it('REQUIRED 4: risk manager rejects wide stop (>40 ticks)', () => {
    // entry=21000, stop=20750 → |21000−20750|/0.25 = 1000 ticks >> 40 max
    const wideStopSignal = {
      id: `${TS}-MNQ1!`,
      timestamp: TS,
      date: '2026-05-21',
      time: '09:30',
      symbol: 'MNQ1!',
      decision: 'LONG',
      bias: { '4H': 'bullish', '1H': 'bullish', '15m': 'bullish', '5m': 'bullish' },
      setup: 'MTF Session Liquidity Trap',
      entry: 21000,
      stop:  20750,   // 250 points = 1000 ticks — far above 40-tick limit
      tp1:   21500,
      tp2:   null,
      r:     2.0,
      confidence: 'A',
      reasons: [],
      invalidation: [],
      what_would_change: '',
      status: 'pending',
      outcome_r: null,
    };

    const result = validate(wideStopSignal, rules);

    assert.equal(result.approved,  false,         'wide stop should be rejected');
    assert.ok(result.rejection_reason.includes('stop_too_wide'),
              `rejection reason should mention stop_too_wide, got: ${result.rejection_reason}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REQUIRED 5 — Signal expires after the candle window is exceeded
  // ─────────────────────────────────────────────────────────────────────────

  it('REQUIRED 5: signal expires after 3 candles (status → expired)', () => {
    const pendingSignal = {
      id: `${TS}-MNQ1!`,
      timestamp: TS,
      date: '2026-05-21',
      time: '09:30',
      symbol: 'MNQ1!',
      decision: 'LONG',
      bias: { '4H': 'bullish', '1H': 'bullish', '15m': 'bullish', '5m': 'bullish' },
      setup: 'MTF Session Liquidity Trap',
      entry: 21000,
      stop: 20997.5,
      tp1: 21080,
      tp2: null,
      r: 32.0,
      confidence: 'A+',
      reasons: [],
      invalidation: [],
      what_would_change: '',
      status: 'pending',
      outcome_r: null,
    };

    // Within window: 3 bars elapsed, window = 3 → NOT expired (barsSinceTrigger must be > window)
    const stillPending = checkExpiry(pendingSignal, 3, 3);
    assert.equal(stillPending.status, 'pending', 'signal should still be pending at exactly window');

    // Exceeded window: 4 bars elapsed, window = 3 → EXPIRED
    const expired = checkExpiry(pendingSignal, 4, 3);
    assert.equal(expired.status, 'expired', 'signal should be expired when barsSinceTrigger > window');

    // Original signal is not mutated (immutable spread)
    assert.equal(pendingSignal.status, 'pending', 'original signal must not be mutated');
  });
});
