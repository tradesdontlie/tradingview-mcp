/**
 * Unit tests for the pine-graphics / stream performance optimizations.
 * No TradingView connection needed — these exercise the pure helpers extracted
 * from src/core/data.js and src/core/stream.js.
 *
 * Run: node --test tests/data_perf.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { studyMatchesFilter, roundValue, shapeLines, getAllGraphicsShaped } from '../src/core/data.js';
import { batchRun } from '../src/core/batch.js';
import {
  shallowFingerprint,
  fingerprintFor,
  fpQuote,
  fpBars,
  fpStudies,
  fpPanes,
} from '../src/core/stream.js';

describe('studyMatchesFilter (early-filter predicate)', () => {
  it('matches everything when filter is empty/absent', () => {
    assert.equal(studyMatchesFilter('Relative Strength Index', ''), true);
    assert.equal(studyMatchesFilter('RSI', undefined), true);
    assert.equal(studyMatchesFilter('RSI', null), true);
  });

  it('is case-insensitive substring match', () => {
    assert.equal(studyMatchesFilter('Bollinger Bands', 'bollinger'), true);
    assert.equal(studyMatchesFilter('Bollinger Bands', 'BANDS'), true);
    assert.equal(studyMatchesFilter('MarketCipher_B', 'cipher'), true);
  });

  it('returns false when no substring match', () => {
    assert.equal(studyMatchesFilter('RSI', 'MACD'), false);
  });

  it('returns false for null name with a filter', () => {
    assert.equal(studyMatchesFilter(null, 'RSI'), false);
  });
});

describe('roundValue (numeric study value formatting)', () => {
  it('returns a number, not a string', () => {
    const r = roundValue(12.3456);
    assert.equal(typeof r, 'number');
    assert.equal(r, 12.35);
  });

  it('rounds to 2 decimals numerically', () => {
    assert.equal(roundValue(0.005), 0.01);
    assert.equal(roundValue(100), 100);
  });

  it('returns null for non-finite numbers', () => {
    assert.equal(roundValue(Infinity), null);
    assert.equal(roundValue(NaN), null);
  });

  it('passes through non-number values unchanged', () => {
    assert.equal(roundValue('close'), 'close');
    assert.equal(roundValue(null), null);
  });
});

describe('shapeLines (pure shaper preserves output shape + _warnings)', () => {
  it('dedups + sorts horizontal levels high→low and carries _warnings', () => {
    const raw = [{
      name: 'NY Levels',
      count: 3,
      items: [
        { id: 'a', raw: { y1: 100, y2: 100 } },
        { id: 'b', raw: { y1: 200, y2: 200 } },
        { id: 'c', raw: { y1: 100, y2: 100 } }, // dup of a
      ],
    }];
    const out = shapeLines(raw, [{ study: 'X', reason: 'boom' }]);
    assert.equal(out.success, true);
    assert.equal(out.study_count, 1);
    assert.deepEqual(out.studies[0].horizontal_levels, [200, 100]);
    assert.equal(out.studies[0].total_lines, 3);
    assert.deepEqual(out._warnings, [{ study: 'X', reason: 'boom' }]);
  });

  it('returns empty result with no _warnings key when nothing matched', () => {
    const out = shapeLines([], []);
    assert.equal(out.study_count, 0);
    assert.equal('_warnings' in out, false);
  });
});

describe('shallowFingerprint', () => {
  it('equal data → equal fingerprint', () => {
    const a = { time: 1, close: 2, volume: 3 };
    const b = { time: 1, close: 2, volume: 3 };
    assert.equal(shallowFingerprint(a), shallowFingerprint(b));
  });

  it('changed field → changed fingerprint', () => {
    const a = { time: 1, close: 2, volume: 3 };
    const b = { time: 1, close: 2.5, volume: 3 };
    assert.notEqual(shallowFingerprint(a), shallowFingerprint(b));
  });

  it('is cheaper than full stringify (shorter for nested payloads)', () => {
    const data = { symbol: 'X', study_count: 2, studies: [{ name: 'a', values: { x: 1, y: 2, z: 3 } }, { name: 'b', values: { x: 1, y: 2, z: 3 } }] };
    // Shallow fingerprint summarizes the nested array by length, so it is
    // strictly shorter than serializing the whole nested object.
    assert.ok(shallowFingerprint(data).length < JSON.stringify(data).length);
  });

  it('handles null and primitives', () => {
    assert.equal(shallowFingerprint(null), 'null');
    assert.equal(shallowFingerprint(5), '5');
  });
});

describe('fingerprintFor', () => {
  it('returns the provided function when given one', () => {
    const fn = () => 'x';
    assert.equal(fingerprintFor(fn), fn);
  });
  it('falls back to shallowFingerprint when not a function', () => {
    assert.equal(fingerprintFor(undefined), shallowFingerprint);
    assert.equal(fingerprintFor(null), shallowFingerprint);
  });
});

describe('per-stream fingerprints (dedup behaviour)', () => {
  it('fpQuote: unchanged quote suppressed, changed close flips', () => {
    const a = { symbol: 'X', time: 100, open: 1, high: 2, low: 0, close: 1.5, volume: 10 };
    const b = { symbol: 'X', time: 100, open: 1, high: 9, low: 0, close: 1.5, volume: 10 }; // only high changed (not in fp)
    const c = { ...a, close: 1.6 };
    assert.equal(fpQuote(a), fpQuote(b), 'time:close:volume identical → same fingerprint');
    assert.notEqual(fpQuote(a), fpQuote(c), 'close change → different fingerprint');
    assert.equal(fpQuote(null), 'null');
  });

  it('fpBars: keyed on bar_time:close:volume', () => {
    const a = { bar_time: 50, close: 10, volume: 5 };
    const b = { bar_time: 50, close: 10, volume: 5 };
    const c = { bar_time: 51, close: 10, volume: 5 };
    assert.equal(fpBars(a), fpBars(b));
    assert.notEqual(fpBars(a), fpBars(c));
  });

  it('fpStudies: detects changes within nested study values', () => {
    const a = { symbol: 'X', study_count: 1, studies: [{ name: 'RSI', values: { RSI: 55.1 } }] };
    const b = { symbol: 'X', study_count: 1, studies: [{ name: 'RSI', values: { RSI: 55.1 } }] };
    const c = { symbol: 'X', study_count: 1, studies: [{ name: 'RSI', values: { RSI: 60.0 } }] };
    assert.equal(fpStudies(a), fpStudies(b));
    assert.notEqual(fpStudies(a), fpStudies(c), 'inner value change must flip fingerprint');
  });

  it('fpStudies: handles lines/labels/tables shapes', () => {
    const lines = { symbol: 'X', study_count: 1, studies: [{ study: 'L', levels: [1, 2] }] };
    const lines2 = { symbol: 'X', study_count: 1, studies: [{ study: 'L', levels: [1, 3] }] };
    assert.notEqual(fpStudies(lines), fpStudies(lines2));
    assert.equal(fpStudies(null), 'null');
  });

  it('fpPanes: detects per-pane price change', () => {
    const a = { layout: '2', pane_count: 1, panes: [{ index: 0, symbol: 'X', time: 1, close: 5, volume: 9 }] };
    const b = { layout: '2', pane_count: 1, panes: [{ index: 0, symbol: 'X', time: 1, close: 5, volume: 9 }] };
    const c = { layout: '2', pane_count: 1, panes: [{ index: 0, symbol: 'X', time: 1, close: 6, volume: 9 }] };
    assert.equal(fpPanes(a), fpPanes(b));
    assert.notEqual(fpPanes(a), fpPanes(c));
  });

  it('fingerprint is cheaper than full JSON.stringify for studies payload', () => {
    const data = { symbol: 'BINANCE:BTCUSDT', study_count: 3, studies: [
      { name: 'RSI', values: { RSI: 55.12 } },
      { name: 'MACD', values: { MACD: 1.2, Signal: 0.9, Hist: 0.3 } },
      { name: 'BB', values: { Upper: 100, Basis: 95, Lower: 90 } },
    ] };
    assert.ok(fpStudies(data).length <= JSON.stringify(data).length);
  });
});

describe('getAllGraphicsShaped — one round-trip for all four pine types', () => {
  it('issues exactly ONE evaluate and returns all four shaped slices', async () => {
    let evalCount = 0;
    const _deps = {
      evaluate: async () => {
        evalCount++;
        return { lines: [], labels: [], tables: [], boxes: [], warnings: [] };
      },
    };
    const r = await getAllGraphicsShaped({ _deps });
    assert.equal(evalCount, 1, 'exactly one CDP round-trip for all four types');
    assert.ok(r.lines && r.labels && r.tables && r.boxes, 'all four slices present');
    assert.equal(r.lines.success, true);
    assert.equal(r.boxes.success, true);
  });
});

describe('batch get_ohlcv — bounded tail-read, not full exportData', () => {
  it('reads the last N bars via valueAt and never calls exportData', async () => {
    const calls = { evaluate: [], evaluateAsync: [] };
    const _deps = {
      // Force the apiPath branch (no collection), ready immediately.
      getChartCollection: async () => { throw new Error('no collection'); },
      getChartApi: async () => 'APIPATH',
      waitForChartReady: async () => true,
      evaluate: async (js) => {
        calls.evaluate.push(js);
        if (/valueAt/.test(js)) {
          return { bar_count: 3, last_bar: { time: 3, open: 1, high: 2, low: 0, close: 1.5, volume: 9 } };
        }
        return undefined;
      },
      evaluateAsync: async (js) => { calls.evaluateAsync.push(js); return {}; },
    };
    const r = await batchRun({ symbols: ['AAPL'], timeframes: [], action: 'get_ohlcv', ohlcv_count: 3, delay_ms: 1, _deps });
    assert.equal(r.success, true);
    const ohlcvCall = calls.evaluate.find(js => /valueAt/.test(js));
    assert.ok(ohlcvCall, 'used a bounded valueAt tail-read');
    assert.ok(!/exportData/.test(ohlcvCall), 'did not export the full chart history');
    assert.equal(calls.evaluateAsync.length, 0, 'the exportData evaluateAsync path is gone');
    assert.equal(r.results[0].result.bar_count, 3);
    assert.equal(r.results[0].result.last_bar.close, 1.5);
  });
});
