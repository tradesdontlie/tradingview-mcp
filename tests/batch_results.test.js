/**
 * Regression tests for batch result accounting in src/core/batch.js.
 *
 * The bug: batch_run derived `success` from "no exception was thrown", but
 * actions signal failure by RETURNING `{ error }`. A sweep of 15 symbols in
 * which every single iteration failed with "Strategy Tester not found" was
 * reported as `success: true, successful: 15, failed: 0` — the results were
 * useless and looked perfect.
 *
 * These import the real functions rather than reimplementing them, unlike
 * tests/e2e.test.js which duplicates each tool with raw CDP calls and so
 * cannot catch a regression in the source modules.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIterationResult, summarizeBatch } from '../src/core/batch.js';
import { normalizeSymbol } from '../src/core/data.js';

describe('normalizeSymbol', () => {
  // Guards a false "stale" flag: if the chart is already on the requested
  // symbol nothing recomputes, so the fingerprint cannot change. Comparing
  // "NSE:INFY" against the API's "INFY" must not look like a symbol change.
  it('strips the exchange prefix and casing', () => {
    assert.equal(normalizeSymbol('NSE:INFY'), 'INFY');
    assert.equal(normalizeSymbol('nse:infy'), 'INFY');
    assert.equal(normalizeSymbol('INFY'), 'INFY');
    assert.equal(normalizeSymbol('  NSE:INFY  '), 'INFY');
  });

  it('treats prefixed and bare forms of the same symbol as equal', () => {
    assert.equal(normalizeSymbol('NSE:INFY'), normalizeSymbol('INFY'));
    assert.notEqual(normalizeSymbol('NSE:INFY'), normalizeSymbol('NSE:TCS'));
  });

  it('handles null / undefined without throwing', () => {
    assert.equal(normalizeSymbol(null), '');
    assert.equal(normalizeSymbol(undefined), '');
  });
});

describe('buildIterationResult', () => {
  it('marks an iteration failed when the action returned { error }', () => {
    const row = buildIterationResult(
      { symbol: 'NSE:HDFCBANK', timeframe: null },
      { error: 'Strategy Tester not found' },
    );
    assert.equal(row.success, false);
    assert.equal(row.error, 'Strategy Tester not found');
    assert.equal(row.symbol, 'NSE:HDFCBANK');
  });

  it('marks an iteration successful when the action returned data', () => {
    const row = buildIterationResult(
      { symbol: 'NSE:TCS', timeframe: 'D' },
      { metric_count: 19, metrics: { total_trades: 14 } },
    );
    assert.equal(row.success, true);
    assert.equal(row.error, undefined);
    assert.equal(row.result.metrics.total_trades, 14);
  });

  it('does not treat a stale_warning as a failure', () => {
    const row = buildIterationResult(
      { symbol: 'NSE:INFY', timeframe: null },
      { metrics: { total_trades: 29 }, stale_warning: 'may belong to the previous symbol' },
    );
    assert.equal(row.success, true);
  });

  it('handles null / non-object action results without throwing', () => {
    assert.equal(buildIterationResult({ symbol: 'X' }, null).success, true);
    assert.equal(buildIterationResult({ symbol: 'X' }, 'raw string').success, true);
  });
});

describe('summarizeBatch', () => {
  it('reports failure when every iteration returned an error (the original bug)', () => {
    const rows = ['NSE:HDFCBANK', 'NSE:ICICIBANK', 'NSE:SBIN'].map(symbol =>
      buildIterationResult({ symbol, timeframe: null }, { error: 'Strategy Tester not found' }),
    );
    const summary = summarizeBatch(rows);
    assert.equal(summary.success, false, 'envelope must not claim success');
    assert.equal(summary.successful, 0);
    assert.equal(summary.failed, 3);
    assert.equal(summary.total_iterations, 3);
  });

  it('reports success only when every iteration succeeded', () => {
    const rows = [
      buildIterationResult({ symbol: 'A' }, { metrics: {} }),
      buildIterationResult({ symbol: 'B' }, { metrics: {} }),
    ];
    const summary = summarizeBatch(rows);
    assert.equal(summary.success, true);
    assert.equal(summary.successful, 2);
    assert.equal(summary.failed, 0);
  });

  it('counts a partial failure correctly', () => {
    const rows = [
      buildIterationResult({ symbol: 'A' }, { metrics: {} }),
      buildIterationResult({ symbol: 'B' }, { error: 'boom' }),
    ];
    const summary = summarizeBatch(rows);
    assert.equal(summary.success, false);
    assert.equal(summary.successful, 1);
    assert.equal(summary.failed, 1);
  });

  it('surfaces a stale count without marking the batch failed', () => {
    const rows = [
      buildIterationResult({ symbol: 'A' }, { metrics: {}, stale_warning: 'x' }),
      buildIterationResult({ symbol: 'B' }, { metrics: {} }),
    ];
    const summary = summarizeBatch(rows);
    assert.equal(summary.success, true);
    assert.equal(summary.stale, 1);
    assert.equal(summary.failed, 0);
  });

  it('omits the stale key entirely when nothing was stale', () => {
    const summary = summarizeBatch([buildIterationResult({ symbol: 'A' }, { metrics: {} })]);
    assert.equal('stale' in summary, false);
  });

  it('handles an empty sweep', () => {
    const summary = summarizeBatch([]);
    assert.equal(summary.total_iterations, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.success, true);
  });
});
