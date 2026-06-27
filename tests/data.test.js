/**
 * Offline failure-path unit tests for src/core/data.js, exercising the `_deps`
 * injection seam added in the complete-dependency-injection-and-tests change.
 * No live TradingView required — a fake `evaluate` returns canned payloads.
 *
 * Covers behaviors tightened by sibling proposals:
 *   - pine-graphics readers surface `_warnings` when the page payload carries
 *     warnings (instead of a silent empty result).
 *   - getStudyValues returns NUMERIC values (not .toFixed strings).
 *   - getOhlcv propagates an injected evaluate() error rather than masking it.
 *   - strategy readers throw when the injected payload carries an error.
 *
 * Run: node --test tests/data.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPineLines,
  getPineLabels,
  getStudyValues,
  getOhlcv,
  getStrategyResults,
  getAllGraphics,
} from '../src/core/data.js';

// Build a _deps bag whose evaluate() returns `payload` (or runs a custom fn).
function depsReturning(payload) {
  return { _deps: { evaluate: async () => payload } };
}
function depsThrowing(err) {
  return { _deps: { evaluate: async () => { throw err; } } };
}

describe('data.js getPineLines — _warnings surfaced', () => {
  it('returns _warnings when the page payload carries warnings', async () => {
    const { _deps } = depsReturning({
      results: [],
      warnings: [{ study: 'Prophesier', reason: 'primitives parse failed: boom' }],
    });
    const r = await getPineLines({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.study_count, 0);
    assert.ok(Array.isArray(r._warnings), '_warnings present');
    assert.equal(r._warnings.length, 1);
    assert.match(r._warnings[0].reason, /primitives parse failed/);
  });

  it('omits _warnings entirely when there are none', async () => {
    const { _deps } = depsReturning({ results: [], warnings: [] });
    const r = await getPineLines({ _deps });
    assert.equal(r.success, true);
    assert.ok(!('_warnings' in r), 'no _warnings key when clean');
  });
});

describe('data.js getPineLabels — _warnings surfaced on broken shape', () => {
  it('surfaces a warning rather than a silent empty result', async () => {
    const { _deps } = depsReturning({
      results: [],
      warnings: [{ study: 'X', reason: 'study scan failed: undefined is not an object' }],
    });
    const r = await getPineLabels({ _deps });
    assert.equal(r.study_count, 0);
    assert.equal(r._warnings.length, 1);
  });
});

describe('data.js getAllGraphics — passes warnings through', () => {
  it('carries warnings from the single round-trip payload', async () => {
    const { _deps } = depsReturning({
      lines: [], labels: [], tables: [], boxes: [],
      warnings: [{ study: 'Y', reason: 'tableCells parse failed: x' }],
    });
    const r = await getAllGraphics({ _deps });
    assert.deepEqual(r.lines, []);
    assert.equal(r.warnings.length, 1);
  });
});

describe('data.js getStudyValues — numeric values', () => {
  it('returns values as numbers (not .toFixed strings)', async () => {
    const { _deps } = depsReturning([
      { entity_id: 's1', name: 'RSI', values: { RSI: 54.32, Signal: 50 } },
    ]);
    const r = await getStudyValues({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.study_count, 1);
    const vals = r.studies[0].values;
    assert.equal(typeof vals.RSI, 'number', 'RSI is a number, not a string');
    assert.equal(vals.RSI, 54.32);
    assert.equal(typeof vals.Signal, 'number');
  });
});

describe('data.js getOhlcv — propagates injected evaluate error', () => {
  it('does NOT mask a CDP/page error with the loading hint', async () => {
    const boom = new Error('CDP evaluate failed: Cannot read properties of undefined');
    const { _deps } = depsThrowing(boom);
    await assert.rejects(() => getOhlcv({ _deps }), /CDP evaluate failed/);
  });

  it('throws the loading hint only when extraction returned no bars', async () => {
    const { _deps } = depsReturning({ bars: [], total_bars: 0, source: 'direct_bars' });
    await assert.rejects(() => getOhlcv({ _deps }), /chart may still be loading/i);
  });

  it('returns a summary for a valid bar payload', async () => {
    const { _deps } = depsReturning({
      bars: [
        { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 },
        { time: 2, open: 11, high: 13, low: 10, close: 12, volume: 200 },
      ],
      total_bars: 2,
      source: 'direct_bars',
    });
    const r = await getOhlcv({ summary: true, _deps });
    assert.equal(r.success, true);
    assert.equal(r.bar_count, 2);
    assert.equal(r.high, 13);
    assert.equal(r.low, 9);
  });
});

describe('data.js getStrategyResults — throws on payload error', () => {
  it('throws when the injected payload reports no strategy', async () => {
    const { _deps } = depsReturning({
      metrics: {}, source: 'internal_api', error: 'No strategy found on chart. Add a strategy indicator first.',
    });
    await assert.rejects(() => getStrategyResults({ _deps }), /No strategy found/);
  });

  it('returns metrics when the payload is clean', async () => {
    const { _deps } = depsReturning({ metrics: { netProfit: 1234 }, source: 'internal_api' });
    const r = await getStrategyResults({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.metric_count, 1);
    assert.equal(r.metrics.netProfit, 1234);
  });
});
