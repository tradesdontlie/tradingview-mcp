/**
 * Regression tests for src/core/batch.js.
 *
 * Bug (2026-06-02): batch_run action=get_ohlcv returned
 *   "JS evaluation error: Uncaught (in promise)" for every symbol because it
 *   called chartApi.exportData(), which this TradingView Desktop build rejects
 *   with the string "Data export is not supported". The working single-symbol
 *   data_get_ohlcv reads bars directly via mainSeries().bars(). The fix routes
 *   batch get_ohlcv through that same proven path (the injectable getOhlcv dep)
 *   and returns a compact per-symbol summary.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { batchRun } from '../src/core/batch.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

function mockFn(impl) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return impl ? impl(...args) : undefined; };
  fn.calls = calls;
  return fn;
}

const SUMMARY = {
  success: true, bar_count: 30, period: { from: 1, to: 2 },
  open: 100, close: 110, high: 120, low: 90, range: 30,
  change: 10, change_pct: '10%', avg_volume: 5000,
  last_5_bars: [{}, {}, {}, {}, {}],
};

function makeDeps(overrides = {}) {
  const evaluate = mockFn();
  const getOhlcv = mockFn(async () => ({ ...SUMMARY }));
  const _deps = {
    evaluate,
    getChartApi: async () => 'API',
    getChartCollection: async () => 'COL',
    waitForChartReady: async () => true,
    getOhlcv,
    getClient: async () => ({ Page: { captureScreenshot: async () => ({ data: '' }) } }),
    ...overrides,
  };
  return { _deps, evaluate, getOhlcv };
}

// ── get_ohlcv action ───────────────────────────────────────────────────────

describe('batchRun get_ohlcv — uses direct-bars read, not exportData', () => {
  it('routes get_ohlcv through the getOhlcv dep (not exportData)', async () => {
    const { _deps, getOhlcv } = makeDeps();
    const result = await batchRun({
      symbols: ['BINANCE:SOLUSDT'], timeframes: ['D'],
      action: 'get_ohlcv', delay_ms: 1, ohlcv_count: 30, _deps,
    });
    assert.equal(result.success, true);
    assert.equal(result.successful, 1);
    assert.equal(result.failed, 0);
    assert.equal(getOhlcv.calls.length, 1, 'getOhlcv called once');
    // getOhlcv must be asked for a summary, capped at the requested count
    assert.deepEqual(getOhlcv.calls[0][0], { count: 30, summary: true });
  });

  it('returns a compact summary per symbol (no bulky last_5_bars / inner success)', async () => {
    const { _deps } = makeDeps();
    const result = await batchRun({
      symbols: ['BINANCE:SOLUSDT'], timeframes: ['D'],
      action: 'get_ohlcv', delay_ms: 1, _deps,
    });
    const r = result.results[0];
    assert.equal(r.success, true);
    assert.equal(r.result.close, 110);
    assert.equal(r.result.change_pct, '10%');
    assert.equal(r.result.high, 120);
    assert.equal(r.result.low, 90);
    assert.equal(r.result.avg_volume, 5000);
    assert.equal(r.result.bar_count, 30);
    assert.ok(!('last_5_bars' in r.result), 'last_5_bars stripped for compactness');
    assert.ok(!('success' in r.result), 'inner success flag stripped');
  });

  it('caps ohlcv_count at 500', async () => {
    const { _deps, getOhlcv } = makeDeps();
    await batchRun({ symbols: ['X'], action: 'get_ohlcv', delay_ms: 1, ohlcv_count: 9999, _deps });
    assert.equal(getOhlcv.calls[0][0].count, 500);
  });

  it('iterates every symbol × timeframe and sets each on the chart', async () => {
    const { _deps, evaluate, getOhlcv } = makeDeps();
    const result = await batchRun({
      symbols: ['AAA', 'BBB'], timeframes: ['D', '60'],
      action: 'get_ohlcv', delay_ms: 1, _deps,
    });
    assert.equal(result.total_iterations, 4);
    assert.equal(result.successful, 4);
    assert.equal(getOhlcv.calls.length, 4);
    const setSymbolCalls = evaluate.calls.filter(c => /setSymbol/.test(c[0]));
    const setResCalls = evaluate.calls.filter(c => /setResolution/.test(c[0]));
    assert.equal(setSymbolCalls.length, 4, 'setSymbol per iteration');
    assert.equal(setResCalls.length, 4, 'setResolution per iteration (tf given)');
  });

  it('isolates a per-symbol read failure without failing the batch', async () => {
    const getOhlcv = mockFn(async () => { throw new Error('Could not extract OHLCV data.'); });
    const { _deps } = makeDeps({ getOhlcv });
    const result = await batchRun({
      symbols: ['AAA', 'BBB'], action: 'get_ohlcv', delay_ms: 1, _deps,
    });
    assert.equal(result.successful, 0);
    assert.equal(result.failed, 2);
    assert.match(result.results[0].error, /Could not extract OHLCV/);
  });
});

// ── Source audit ─────────────────────────────────────────────────────────

describe('batch.js source audit', () => {
  it('no longer references the unsupported exportData API', () => {
    const src = readFileSync(new URL('../src/core/batch.js', import.meta.url), 'utf8');
    assert.ok(!src.includes('exportData'), 'exportData must not appear in batch.js');
  });
});
