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
import { detectSweep, detectReclaim,
         detectLatestSweep }                   from '../engines/liquidityEngine.js';
import { detectMss, findDisplacementCandle,
         findSwingPoints }                       from '../engines/structureEngine.js';
import { detectVolumeSurge }                    from '../engines/volumeEngine.js';
import { buildSignal, checkExpiry,
         validateSetupSequence,
         runEngines }                           from '../strategies/mtfSessionLiquidityTrap.js';
import { validate, checkStaleness }             from '../risk/riskManager.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3B: setup selection quality
// ─────────────────────────────────────────────────────────────────────────────

const TS3B = '2026-05-23T10:00:00.000Z';

// Shared session levels (reuse long setup from REQUIRED 1)
const p3bLongLevels = {
  asia:        { high: 21100, low: 21000, poc: 21050, found: true },
  london:      { high: 21080, low: 21010, poc: 21045, found: true },
  nyOpenRange: { high: 21090, low: 21020,              found: true },
  priorDay:    { high: 21200, low: 20900,              found: true },
};

/** Minimal engine outputs for a valid LONG. Accepts _setupMeta override. */
function makeLongEngineOutputs(setupMetaOverride = {}) {
  return {
    biasResult:         { '4H': 'bullish', '1H': 'bullish', '15m': 'bullish', '5m': 'bullish', permission: 'long' },
    sessionLevels:      p3bLongLevels,
    sweepResult:        { swept: true,  sweepBarIndex: 10 },
    sweepLevel:         21000,
    sweepDirection:     'low',
    reclaimResult:      { reclaimed: true, reclaimBarIndex: 12, candlesToReclaim: 2 },
    mssResult:          { detected: true, mssBarIndex: 13 },
    displacementCandle: { index: 14, direction: 'bullish', bodySize: 15, volumeRatio: 2.2 },
    volumeResult:       { surge: true, ratio: 2.2 },
    _setupMeta: {
      sweep_bar_index:        10,
      reclaim_bar_index:      12,
      mss_bar_index:          13,
      displacement_bar_index: 14,
      latest_bar_index:       15,
      setup_age_bars:         5,
      setup_recency_valid:    true,
      setup_window_bars:      12,
      opposite_invalidated:   false,
      bar_freshness_reason:   null,
      ...setupMetaOverride,
    },
  };
}

describe('Phase 3B: detectLatestSweep', () => {
  it('returns the most recent sweep within the window, not the first historical one', () => {
    const level = 100;
    // Two sweep bars: index 3 (old, outside window) and index 15 (recent, inside window)
    const bars = Array.from({ length: 20 }, (_, i) => ({
      low:  (i === 3 || i === 15) ? 99 : 101,
      high: 102,
      close: 101,
    }));
    // window=12, bars.length=20 → windowStart=8; index 3 < 8 → excluded
    const result = detectLatestSweep(bars, level, 'low', 0, 12);
    assert.equal(result.swept,         true, 'sweep should be detected');
    assert.equal(result.sweepBarIndex, 15,   'should return latest sweep at index 15, not old index 3');

    // Confirm detectSweep (original) would have returned the old one
    const old = detectSweep(bars, level, 'low');
    assert.equal(old.sweepBarIndex, 3, 'detectSweep returns first (oldest) sweep');
    assert.notEqual(old.sweepBarIndex, result.sweepBarIndex, 'latest ≠ first');
  });

  it('returns swept=false when the only sweep is outside the window', () => {
    const level = 100;
    // Sweep only at index 5; window=12 on 20-bar array → windowStart=8 → index 5 excluded
    const bars = Array.from({ length: 20 }, (_, i) => ({
      low:  i === 5 ? 99 : 101,
      high: 102,
      close: 101,
    }));
    const result = detectLatestSweep(bars, level, 'low', 0, 12);
    assert.equal(result.swept, false, 'old sweep outside window should not be found');
    assert.equal(result.sweepBarIndex, null);
  });

  it('returns swept=true when the only sweep is exactly at the window boundary', () => {
    // bars.length=12, windowStart=0; sweep at index 0 → on boundary → included
    const level = 100;
    const bars = Array.from({ length: 12 }, (_, i) => ({
      low:  i === 0 ? 99 : 101,
      high: 102,
      close: 101,
    }));
    const result = detectLatestSweep(bars, level, 'low', 0, 12);
    assert.equal(result.swept, true);
    assert.equal(result.sweepBarIndex, 0);
  });

  it('detects sweep of high level (bearish direction)', () => {
    const level = 200;
    const bars = Array.from({ length: 15 }, (_, i) => ({
      low:  195,
      high: i === 12 ? 201 : 198,
      close: 197,
    }));
    const result = detectLatestSweep(bars, level, 'high', 0, 12);
    assert.equal(result.swept,         true);
    assert.equal(result.sweepBarIndex, 12);
  });
});

describe('Phase 3B: setup selection quality (buildSignal)', () => {
  it('3B-1: rejects setup when sweep is outside the valid setup window (_setupMeta.setup_recency_valid=false)', () => {
    const engineOutputs = makeLongEngineOutputs({
      sweep_bar_index:     3,
      setup_age_bars:      17,
      setup_recency_valid: false,   // sweep too old
    });
    // sweepResult.swept is still true — recency guard must fire before reclaim/MSS
    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS3B });
    assert.equal(signal.decision, 'WAIT', 'old sweep should produce WAIT');
    assert.ok(
      signal.reasons.some(r => r.toLowerCase().includes('window') || r.toLowerCase().includes('age')),
      `reason should mention window/age: ${signal.reasons}`,
    );
  });

  it('3B-2: selects latest valid sweep — valid recent _setupMeta produces LONG candidate', () => {
    const engineOutputs = makeLongEngineOutputs();  // setup_recency_valid=true, no opposite
    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS3B });
    assert.equal(signal.decision, 'LONG', 'valid recent setup should produce LONG');
    assert.ok(['A+', 'A'].includes(signal.confidence), `confidence: ${signal.confidence}`);
  });

  it('3B-3: setup expires when setup_age_bars exceeds window (via recency guard)', () => {
    // setup_age_bars=15 > setup_window_bars=12
    const engineOutputs = makeLongEngineOutputs({
      setup_age_bars:      15,
      setup_recency_valid: false,
    });
    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS3B });
    assert.equal(signal.decision, 'WAIT');
    assert.equal(signal.status,   'expired');
  });

  it('3B-4: newer opposite sweep invalidates older setup → WAIT', () => {
    const engineOutputs = makeLongEngineOutputs({
      opposite_invalidated: true,
    });
    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS3B });
    assert.equal(signal.decision, 'WAIT', 'opposite sweep invalidation should produce WAIT');
    assert.ok(
      signal.reasons.some(r => r.toLowerCase().includes('opposite') || r.toLowerCase().includes('invalidat')),
      `reason should mention opposite/invalidation: ${signal.reasons}`,
    );
  });

  it('3B-5: valid recent sweep/reclaim/MSS still produces directional candidate', () => {
    const engineOutputs = makeLongEngineOutputs();
    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS3B });
    assert.equal(signal.decision, 'LONG');
    assert.ok(signal.entry  != null, 'entry must be defined');
    assert.ok(signal.stop   != null, 'stop must be defined');
    assert.ok(signal.tp1    != null, 'tp1 must be defined');
    assert.ok(signal.r > 0,          'R must be positive');
  });

  it('3B-6: signal _meta contains all required setup index fields', () => {
    const engineOutputs = makeLongEngineOutputs();
    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS3B });
    assert.equal(signal.decision, 'LONG');
    assert.ok(signal._meta != null,                    '_meta must be present');
    assert.equal(signal._meta.sweep_bar_index,         10,   'sweep_bar_index');
    assert.equal(signal._meta.reclaim_bar_index,       12,   'reclaim_bar_index');
    assert.equal(signal._meta.mss_bar_index,           13,   'mss_bar_index');
    assert.equal(signal._meta.displacement_bar_index,  14,   'displacement_bar_index');
    assert.equal(signal._meta.latest_bar_index,        15,   'latest_bar_index');
    assert.equal(signal._meta.setup_age_bars,          5,    'setup_age_bars');
    assert.equal(signal._meta.setup_recency_valid,     true, 'setup_recency_valid');
  });

  it('3B-6b: WAIT signal also carries _meta indices when _setupMeta is present', () => {
    // opposite_invalidated → WAIT path; _meta should still be present
    const engineOutputs = makeLongEngineOutputs({ opposite_invalidated: true });
    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS3B });
    assert.equal(signal.decision, 'WAIT');
    assert.ok(signal._meta != null, '_meta must be present on WAIT from Phase 3B guard');
    assert.equal(signal._meta.sweep_bar_index,   10);
    assert.equal(signal._meta.latest_bar_index,  15);
    assert.equal(signal._meta.setup_recency_valid, true);
  });

  it('3B-7: bar freshness reason → WAIT (highest priority gate)', () => {
    const engineOutputs = makeLongEngineOutputs({
      bar_freshness_reason: '5m bar data stale: latest bar is 15m old',
    });
    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS3B });
    assert.equal(signal.decision, 'WAIT', 'stale bars should produce WAIT');
    assert.ok(
      signal.reasons.some(r => r.toLowerCase().includes('stale')),
      `reason should mention stale: ${signal.reasons}`,
    );
  });

  it('3B-8: _setupMeta absent (legacy injected outputs) — existing tests not broken', () => {
    // No _setupMeta → Phase 3B guards are all skipped; valid LONG still fires
    const engineOutputs = {
      biasResult:         { '4H': 'bullish', '1H': 'bullish', '15m': 'bullish', '5m': 'bullish', permission: 'long' },
      sessionLevels:      p3bLongLevels,
      sweepResult:        { swept: true,  sweepBarIndex: 10 },
      sweepLevel:         21000,
      sweepDirection:     'low',
      reclaimResult:      { reclaimed: true, reclaimBarIndex: 12, candlesToReclaim: 2 },
      mssResult:          { detected: true, mssBarIndex: 14 },
      displacementCandle: { index: 13, direction: 'bullish', bodySize: 15, volumeRatio: 2.2 },
      volumeResult:       { surge: true, ratio: 2.2 },
      // _setupMeta intentionally absent
    };
    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS3B });
    assert.equal(signal.decision,   'LONG',  'legacy outputs without _setupMeta should still work');
    assert.equal(signal._meta,       undefined, '_meta absent when _setupMeta was not in engineOutputs');
  });

  it('3B-9: Phase 3A stale/chase behavior is unchanged (checkStaleness still rejects chased entry)', () => {
    // Phase 3A post-signal guard: entry=21000, current=21002 (8 ticks above > 4-tick tolerance)
    const sig = { decision: 'LONG', entry: 21000, tp1: 21080, symbol: 'MNQ1!' };
    const reason = checkStaleness(sig, 21002);
    assert.ok(reason !== null,                       'should detect chased entry');
    assert.ok(reason.includes('too far from entry'), `reason: ${reason}`);
  });

  it('3B-10: no broker/order/live execution code in strategy file', () => {
    const src = readFileSync(join(__dirname, '..', 'strategies', 'mtfSessionLiquidityTrap.js'), 'utf8');
    for (const pattern of ['placeOrder', 'submitOrder', 'createOrder', 'executeOrder', 'live_execution']) {
      assert.ok(!src.includes(pattern), `strategy must not contain "${pattern}"`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3B-FIX: event-order enforcement
// ─────────────────────────────────────────────────────────────────────────────

// Asia session timestamp base (UTC 01:00 → within Asia window)
const ASIA_BASE   = new Date('2026-05-21T01:00:00Z').getTime();
// London session timestamp base (UTC 09:00 → within London window)
const LONDON_BASE = new Date('2026-05-21T09:00:00Z').getTime();

/**
 * Builds a 5m bar array used for runEngines integration tests.
 *
 * Layout (11 bars, indices 0–10):
 *   0–5  Asia session  — establishes asia.low=21006, asia.high=21012
 *   6    London sweep  — low=20999 < 21006
 *   7    No-reclaim    — close=21004 < 21006
 *   8    Reclaim+MSS*  — close=21015 > 21006 AND > refLevel(21012 OLD / 21016 NEW)
 *   9    Normal        — close=21014
 *   10   Normal        — close=21012
 *
 * * With OLD code MSS starts at sweep(6) → refLevel=21012 → MSS at bar 8.
 *   With NEW code MSS starts at reclaim(8) → refLevel=max(bars[0..8].high)=21016
 *   → no bar after 8 has close > 21016 → MSS not detected.
 */
function make5mSameBarReclaimMss() {
  const bars = [];
  for (let i = 0; i < 6; i++) {
    bars.push({ ts: ASIA_BASE + i * 300_000, open: 21005, high: 21012, low: 21006, close: 21008, vol: 500 });
  }
  // bar 6 — sweep
  bars.push({ ts: LONDON_BASE + 0 * 300_000, open: 21005, high: 21006, low: 20999, close: 21001, vol: 500 });
  // bar 7 — below swept level
  bars.push({ ts: LONDON_BASE + 1 * 300_000, open: 21001, high: 21008, low: 21006, close: 21004, vol: 500 });
  // bar 8 — reclaim + former MSS trigger (close=21015 > 21012 OLD refLevel); high=21016
  bars.push({ ts: LONDON_BASE + 2 * 300_000, open: 21005, high: 21016, low: 21006, close: 21015, vol: 500 });
  // bar 9 — close=21014 < 21016 (no MSS under NEW code)
  bars.push({ ts: LONDON_BASE + 3 * 300_000, open: 21015, high: 21016, low: 21010, close: 21014, vol: 500 });
  // bar 10 — close=21012 < 21016
  bars.push({ ts: LONDON_BASE + 4 * 300_000, open: 21014, high: 21015, low: 21010, close: 21012, vol: 500 });
  return bars;
}

/**
 * 5m bars where a displacement candidate exists between sweep and MSS:
 *
 *   0–5  Asia session  — asia.low=21006, asia.high=21012 (body≈3, vol=500)
 *   6    London sweep  — low=20999 < 21006
 *   7    Reclaim       — close=21009 > 21006, HIGH BODY+VOL (displacement candidate)
 *   8    MSS           — close=21014 > 21012 = refLevel (small body, vol=500)
 *   9    Normal        — no displacement
 *   10   Normal        — no displacement
 *
 * With OLD code: displacement found at bar 7 (before MSS bar 8) → sequence invalid.
 * With NEW code: displacement search starts at mss=8; bar 8 body=5 > avgBody*1.5≈4.5
 *                but bar 8 vol=500/avgVol(500)=1 < 1.5 → not displacement.
 *                Bars 9–10 also fail → WAIT "No displacement candle detected".
 */
function make5mDispBeforeMss() {
  const bars = [];
  for (let i = 0; i < 6; i++) {
    bars.push({ ts: ASIA_BASE + i * 300_000, open: 21005, high: 21012, low: 21006, close: 21008, vol: 500 });
  }
  // bar 6 — sweep
  bars.push({ ts: LONDON_BASE + 0 * 300_000, open: 21005, high: 21006, low: 20999, close: 21001, vol: 500 });
  // bar 7 — reclaim + displacement candidate (big body + surge vol)
  bars.push({ ts: LONDON_BASE + 1 * 300_000, open: 21001, high: 21018, low: 21006, close: 21009, vol: 4000 });
  // bar 8 — MSS (close=21014 > refLevel=21012), small vol
  bars.push({ ts: LONDON_BASE + 2 * 300_000, open: 21009, high: 21015, low: 21008, close: 21014, vol: 500 });
  // bar 9 — normal
  bars.push({ ts: LONDON_BASE + 3 * 300_000, open: 21014, high: 21016, low: 21010, close: 21012, vol: 500 });
  // bar 10 — normal
  bars.push({ ts: LONDON_BASE + 4 * 300_000, open: 21012, high: 21014, low: 21010, close: 21011, vol: 500 });
  return bars;
}

/**
 * 5m bars with a clean sweep → reclaim → MSS → displacement sequence.
 *
 *   0–5  Asia session  — asia.low=21006, asia.high=21012 (body≈3, vol=500)
 *   6    London sweep  — low=20999 < 21006
 *   7    No reclaim    — close=21004
 *   8    Reclaim       — close=21010 > 21006, small vol
 *   9    MSS           — close=21014 > refLevel=21012, small vol (body≈5)
 *   10   Displacement  — big body (14) + surge vol (2500)
 */
function make5mValidSequence() {
  const bars = [];
  for (let i = 0; i < 6; i++) {
    bars.push({ ts: ASIA_BASE + i * 300_000, open: 21005, high: 21012, low: 21006, close: 21008, vol: 500 });
  }
  bars.push({ ts: LONDON_BASE + 0 * 300_000, open: 21005, high: 21006, low: 20999, close: 21001, vol: 500 }); // 6 sweep
  bars.push({ ts: LONDON_BASE + 1 * 300_000, open: 21001, high: 21005, low: 21006, close: 21004, vol: 500 }); // 7 no reclaim
  bars.push({ ts: LONDON_BASE + 2 * 300_000, open: 21004, high: 21011, low: 21006, close: 21010, vol: 500 }); // 8 reclaim
  bars.push({ ts: LONDON_BASE + 3 * 300_000, open: 21010, high: 21015, low: 21008, close: 21014, vol: 500 }); // 9 MSS
  bars.push({ ts: LONDON_BASE + 4 * 300_000, open: 21014, high: 21028, low: 21013, close: 21028, vol: 2500 }); // 10 displacement
  return bars;
}

/**
 * 5m bars: sweep of Asia low exists, reclaim NEVER confirmed within the window,
 * but a high-high close appears later (looks like MSS if MSS was searched from
 * the sweep bar, as the old fallback code would do).
 *
 *   0–5  Asia session  — asia.low=21006, asia.high=21012 (body≈3, vol=500)
 *   6    London sweep  — low=20999 < 21006; sweepBarIndex=6
 *   7–11 At swept level — close=21006 exactly → NOT a reclaim (needs close > 21006)
 *                         low=21006 → NOT a new sweep (needs low < 21006)
 *   12   False MSS     — close=21015 > 21012; would trigger MSS if searched from bar 6
 *                         (old fallback); outside reclaim window → reclaim still null
 *   13   Disp. cand.   — big body + surge vol; only relevant if MSS were falsely detected
 *
 * With OLD code: mssAfterIdx falls back to sweepBarIndex=6 → mss_bar_index=12,
 *                displacement_bar_index=13 (both wrong — reclaim was never confirmed).
 * With NEW code: reclaim false → mssResult={detected:false} → both remain null ✓
 */
function make5mNoReclaimWithFalseMssMove() {
  const bars = [];
  for (let i = 0; i < 6; i++) {
    bars.push({ ts: ASIA_BASE + i * 300_000, open: 21005, high: 21012, low: 21006, close: 21008, vol: 500 });
  }
  // bar 6 — sweep (low=20999 < 21006)
  bars.push({ ts: LONDON_BASE + 0 * 300_000, open: 21005, high: 21006, low: 20999, close: 21001, vol: 500 });
  // bars 7–11 — close exactly at swept level: no reclaim (close > 21006 false),
  //             no new sweep (low = 21006, not < 21006), reclaim window exhausted
  for (let i = 1; i <= 5; i++) {
    bars.push({ ts: LONDON_BASE + i * 300_000, open: 21006, high: 21009, low: 21006, close: 21006, vol: 500 });
  }
  // bar 12 — high-high close (false MSS); low=21010 > 21006 → not a new sweep
  bars.push({ ts: LONDON_BASE + 6 * 300_000, open: 21010, high: 21018, low: 21010, close: 21015, vol: 500 });
  // bar 13 — displacement candidate (only matters if MSS were falsely detected)
  bars.push({ ts: LONDON_BASE + 7 * 300_000, open: 21015, high: 21030, low: 21014, close: 21030, vol: 3000 });
  return bars;
}

/** Wraps custom 5m bars into a full ohlcvByTimeframe for runEngines. */
function makeFullOhlcv(bars5m) {
  return {
    '4H':  makeBullishZigzag(),
    '1H':  makeBullishZigzag(),
    '15m': makeBullishZigzag(),
    '5m':  bars5m,
  };
}

const TS3BFIX = '2026-05-24T10:00:00.000Z';

describe('Phase 3B-FIX: event-order enforcement', () => {

  // ── validateSetupSequence unit tests ──────────────────────────────────────

  it('FIX-1a: validateSetupSequence returns null for a valid sequence', () => {
    assert.equal(validateSetupSequence({ sweep_bar_index: 6, reclaim_bar_index: 8, mss_bar_index: 9, displacement_bar_index: 10 }), null);
  });

  it('FIX-1b: validateSetupSequence detects MSS at same bar as reclaim (m <= r)', () => {
    const err = validateSetupSequence({ sweep_bar_index: 6, reclaim_bar_index: 8, mss_bar_index: 8, displacement_bar_index: 9 });
    assert.ok(err !== null,                  'should flag invalid sequence');
    assert.ok(err.includes('MSS before reclaim'), `reason: ${err}`);
  });

  it('FIX-1c: validateSetupSequence detects MSS strictly before reclaim (m < r)', () => {
    const err = validateSetupSequence({ sweep_bar_index: 6, reclaim_bar_index: 9, mss_bar_index: 7, displacement_bar_index: 10 });
    assert.ok(err !== null,                  'should flag invalid sequence');
    assert.ok(err.includes('MSS before reclaim'), `reason: ${err}`);
  });

  it('FIX-1d: validateSetupSequence detects displacement before MSS (d < m)', () => {
    const err = validateSetupSequence({ sweep_bar_index: 6, reclaim_bar_index: 8, mss_bar_index: 10, displacement_bar_index: 9 });
    assert.ok(err !== null,                   'should flag invalid sequence');
    assert.ok(err.includes('displacement before MSS'), `reason: ${err}`);
  });

  it('FIX-1e: validateSetupSequence: displacement == MSS bar is valid (d >= m)', () => {
    assert.equal(
      validateSetupSequence({ sweep_bar_index: 6, reclaim_bar_index: 8, mss_bar_index: 9, displacement_bar_index: 9 }),
      null,
      'displacement at the same bar as MSS is valid',
    );
  });

  it('FIX-1f: validateSetupSequence returns null when any index is null (defers to boolean checks)', () => {
    assert.equal(validateSetupSequence({ sweep_bar_index: 6, reclaim_bar_index: null, mss_bar_index: 9, displacement_bar_index: 10 }), null);
  });

  // ── buildSignal: injected _setupMeta ordering ─────────────────────────────

  it('FIX-2a: buildSignal rejects injected _setupMeta with MSS before reclaim', () => {
    const engineOutputs = makeLongEngineOutputs({
      sweep_bar_index:        6,
      reclaim_bar_index:      8,
      mss_bar_index:          8,  // same as reclaim → invalid
      displacement_bar_index: 9,
    });
    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS3BFIX });
    assert.equal(signal.decision, 'WAIT', 'MSS=reclaim should be rejected');
    assert.ok(
      signal.reasons.some(r => r.toLowerCase().includes('mss') && r.toLowerCase().includes('reclaim')),
      `reason: ${signal.reasons}`,
    );
  });

  it('FIX-2b: buildSignal rejects injected _setupMeta with displacement before MSS', () => {
    const engineOutputs = makeLongEngineOutputs({
      sweep_bar_index:        6,
      reclaim_bar_index:      8,
      mss_bar_index:          10,
      displacement_bar_index: 9,  // before MSS → invalid
    });
    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS3BFIX });
    assert.equal(signal.decision, 'WAIT', 'displacement before MSS should be rejected');
    assert.ok(
      signal.reasons.some(r => r.toLowerCase().includes('displacement') && r.toLowerCase().includes('mss')),
      `reason: ${signal.reasons}`,
    );
  });

  it('FIX-2c: buildSignal accepts valid ordered _setupMeta', () => {
    const engineOutputs = makeLongEngineOutputs({
      sweep_bar_index:        6,
      reclaim_bar_index:      8,
      mss_bar_index:          9,
      displacement_bar_index: 10,
    });
    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS3BFIX });
    assert.equal(signal.decision, 'LONG', 'valid ordered sequence should produce LONG');
  });

  // ── runEngines integration: real bar paths ────────────────────────────────

  it('FIX-3a: runEngines rejects when same bar is reclaim+MSS — MSS must be strictly after reclaim', () => {
    // With NEW code: detectMss starts from reclaimBarIndex → refLevel includes bar8.high=21016
    // No bar after 8 has close > 21016 → mssResult.detected=false → WAIT
    const ohlcv   = makeFullOhlcv(make5mSameBarReclaimMss());
    const outputs = runEngines(ohlcv);
    const signal  = buildSignal({ symbol: 'MNQ1!', engineOutputs: outputs, rules, timestamp: TS3BFIX });
    assert.equal(signal.decision, 'WAIT', 'same-bar reclaim+MSS should produce WAIT');
    // mssResult.detected=false so _meta.mss_bar_index is null
    assert.equal(outputs._setupMeta.mss_bar_index, null, 'no MSS should be found after reclaim bar');
  });

  it('FIX-3b: runEngines rejects when displacement candidate exists only before MSS', () => {
    // Bar 7 is big (displacement candidate) but comes before MSS at bar 8.
    // NEW code: findDisplacementCandle starts at mssBarIndex=8; bar 8 vol too low → no displacement → WAIT
    const ohlcv   = makeFullOhlcv(make5mDispBeforeMss());
    const outputs = runEngines(ohlcv);
    const signal  = buildSignal({ symbol: 'MNQ1!', engineOutputs: outputs, rules, timestamp: TS3BFIX });
    assert.equal(signal.decision, 'WAIT', 'displacement-before-MSS should produce WAIT');
    assert.equal(outputs._setupMeta.displacement_bar_index, null, 'no displacement found after MSS bar');
  });

  it('FIX-3c: runEngines accepts valid sweep → reclaim → MSS → displacement sequence', () => {
    const ohlcv   = makeFullOhlcv(make5mValidSequence());
    const outputs = runEngines(ohlcv);
    const meta    = outputs._setupMeta;

    assert.ok(meta.sweep_bar_index        != null, 'sweep detected');
    assert.ok(meta.reclaim_bar_index      != null, 'reclaim detected');
    assert.ok(meta.mss_bar_index          != null, 'MSS detected');
    assert.ok(meta.displacement_bar_index != null, 'displacement detected');

    // Strict ordering enforced
    assert.ok(meta.reclaim_bar_index      >  meta.sweep_bar_index,        'reclaim > sweep');
    assert.ok(meta.mss_bar_index          >  meta.reclaim_bar_index,      'MSS > reclaim');
    assert.ok(meta.displacement_bar_index >= meta.mss_bar_index,          'displacement >= MSS');

    // No sequence error in buildSignal
    assert.equal(validateSetupSequence(meta), null, 'validateSetupSequence must return null');
    // Full pipeline (LONG/SHORT allowed when all conditions are met) is verified by REQUIRED 1
    // and FIX-2c; not re-tested here because the displacement bar sweeps the Asia HIGH in this
    // fixture, triggering the Phase 3B opposite-sweep guard (correct behavior, not a test concern).
  });

  it('FIX-3d: runEngines — sweep + no reclaim + MSS-looking move → WAIT; mss and displacement must be null', () => {
    // Core bug fix: with old code, mssAfterIdx fell back to sweepBarIndex when reclaim was
    // not confirmed, falsely populating mss_bar_index and displacement_bar_index.
    // With new code, reclaim=false → mssResult={detected:false} → both must remain null.
    // Note: signal is WAIT but the reason may be opposite-sweep (Phase 3B guard fires before
    // the reclaim gate); the null meta assertions are the actual proof the fix works.
    const ohlcv   = makeFullOhlcv(make5mNoReclaimWithFalseMssMove());
    const outputs = runEngines(ohlcv);
    const signal  = buildSignal({ symbol: 'MNQ1!', engineOutputs: outputs, rules, timestamp: TS3BFIX });

    assert.equal(signal.decision, 'WAIT', 'no reclaim must produce WAIT');
    assert.ok(outputs._setupMeta.sweep_bar_index != null, 'sweep was detected');
    assert.equal(outputs._setupMeta.reclaim_bar_index,      null, 'reclaim must be null (outside window)');
    assert.equal(outputs._setupMeta.mss_bar_index,          null, 'MSS must not be detected without confirmed reclaim');
    assert.equal(outputs._setupMeta.displacement_bar_index, null, 'displacement must not be detected without confirmed reclaim');
  });

  it('FIX-3e: runEngines — sweep + reclaim missing (different path: MSS "before" reclaim is impossible by construction)', () => {
    // Architecture guarantee: detectMss starts from reclaimBarIndex when reclaim is
    // confirmed (mssBarIndex always > reclaimBarIndex), so MSS-before-reclaim cannot
    // arise from real bar data.  This test uses injected engineOutputs to verify that
    // buildSignal enforces the reclaim gate regardless of what mssResult reports.
    const engineOutputs = {
      biasResult:         { '4H': 'bullish', '1H': 'bullish', '15m': 'bullish', '5m': 'bullish', permission: 'long' },
      sessionLevels:      p3bLongLevels,
      sweepResult:        { swept: true, sweepBarIndex: 6 },
      sweepLevel:         21006,
      sweepDirection:     'low',
      reclaimResult:      { reclaimed: false, reclaimBarIndex: null, candlesToReclaim: null },
      // mssResult has detected=true even though reclaim is missing (simulates what old code
      // could produce via the sweep-fallback; or an injected adversarial scenario)
      mssResult:          { detected: true, mssBarIndex: 9 },
      displacementCandle: { index: 10, direction: 'bullish', bodySize: 15, volumeRatio: 2.0 },
      volumeResult:       { surge: true, ratio: 2.0 },
      _setupMeta: {
        sweep_bar_index:        6,
        reclaim_bar_index:      null,
        mss_bar_index:          9,
        displacement_bar_index: 10,
        latest_bar_index:       11,
        setup_age_bars:         5,
        setup_recency_valid:    true,
        setup_window_bars:      12,
        opposite_invalidated:   false,
        bar_freshness_reason:   null,
      },
    };
    const signal = buildSignal({ symbol: 'MNQ1!', engineOutputs, rules, timestamp: TS3BFIX });
    assert.equal(signal.decision, 'WAIT', 'reclaim missing → WAIT even when MSS data is present');
    assert.ok(
      signal.reasons.some(r => r.toLowerCase().includes('reclaim')),
      `reason should mention reclaim: ${signal.reasons}`,
    );
  });

  it('FIX-4: Phase 3A stale/chase unchanged — checkStaleness still fires on chased SHORT entry', () => {
    const sig = { decision: 'SHORT', entry: 21200, tp1: 21120, symbol: 'MNQ1!' };
    const reason = checkStaleness(sig, 21198.75);  // 5 ticks below entry
    assert.ok(reason !== null,                        'chased SHORT should be stale');
    assert.ok(reason.includes('too far from entry'),  `reason: ${reason}`);
  });

  it('FIX-5: Phase 3B latest-sweep unchanged — detectLatestSweep still returns newest sweep', () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({
      low:  (i === 3 || i === 15) ? 99 : 101, high: 102, close: 101,
    }));
    const r = detectLatestSweep(bars, 100, 'low', 0, 12);
    assert.equal(r.sweepBarIndex, 15, 'latest sweep at 15, not historical at 3');
  });

  it('FIX-6: live_trading_enabled remains false after Phase 3B-FIX', () => {
    assert.equal(rules?.risk?.live_trading_enabled, false, 'live_trading_enabled must remain false');
  });

  it('FIX-7: no broker/order/live execution code introduced', () => {
    const src = readFileSync(join(__dirname, '..', 'strategies', 'mtfSessionLiquidityTrap.js'), 'utf8');
    for (const p of ['placeOrder', 'submitOrder', 'createOrder', 'executeOrder', 'live_execution']) {
      assert.ok(!src.includes(p), `strategy must not contain "${p}"`);
    }
  });
});
