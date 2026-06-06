/**
 * Tests for chart.js functions missed by the DI refactor (f23eb1b):
 * getVisibleRange, scrollToDate, symbolInfo. Each previously referenced a
 * bare `evaluate` identifier that resolves nowhere (module imports it as
 * `_evaluate`), so EVERY invocation threw `ReferenceError: evaluate is not
 * defined` — these tests fail on that regression by construction, since
 * exercising the functions at all requires the `_resolve(_deps)` line.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getVisibleRange, scrollToDate, symbolInfo } from '../src/core/chart.js';

// ── Mock helpers (same shape as replay.test.js) ─────────────────────────

/**
 * Create a mock evaluate function that returns scripted values.
 * Calls are tracked in .calls array.
 * @param {object} responses — map of substring→return value. First matching key wins.
 */
function mockEvaluate(responses = {}) {
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    for (const [key, val] of Object.entries(responses)) {
      if (expr.includes(key)) return typeof val === 'function' ? val(calls.length) : val;
    }
    return undefined;
  };
  fn.calls = calls;
  return fn;
}

function mockDeps(responses = {}) {
  const evaluate = mockEvaluate(responses);
  return { _deps: { evaluate }, evaluate };
}

// ── getVisibleRange() ────────────────────────────────────────────────────

describe('getVisibleRange() — DI + pass-through', () => {
  it('returns visible_range and bars_range from the chart', async () => {
    const { _deps, evaluate } = mockDeps({
      'getVisibleRange': {
        visible_range: { from: 1383264000, to: 1780617600 },
        bars_range: { firstBar: 10, lastBar: 2400 },
      },
    });
    const result = await getVisibleRange({ _deps });
    assert.equal(result.success, true);
    assert.deepEqual(result.visible_range, { from: 1383264000, to: 1780617600 });
    assert.deepEqual(result.bars_range, { firstBar: 10, lastBar: 2400 });
    assert.equal(evaluate.calls.length, 1);
    assert.ok(evaluate.calls[0].includes('getVisibleBarsRange'), 'queries the bars range');
  });

});

// ── scrollToDate() ───────────────────────────────────────────────────────

describe('scrollToDate() — DI + window math', () => {
  it('centers a daily chart on an ISO date with a ±25-bar window', async () => {
    const { _deps, evaluate } = mockDeps({
      '.resolution()': 'D',
      'zoomToBarsRange': undefined,
    });
    const result = await scrollToDate({ date: '2014-01-02', _deps });
    const ts = Math.floor(new Date('2014-01-02').getTime() / 1000);
    assert.equal(result.success, true);
    assert.equal(result.centered_on, ts);
    assert.equal(result.resolution, 'D');
    assert.deepEqual(result.window, { from: ts - 25 * 86400, to: ts + 25 * 86400 });
    const zoomCall = evaluate.calls.find((c) => c.includes('zoomToBarsRange'));
    assert.ok(zoomCall, 'issues the zoom expression');
    assert.ok(zoomCall.includes(String(ts - 25 * 86400)), 'window lower bound in the expression');
  });

  it('accepts a unix-timestamp string and intraday resolutions', async () => {
    const { _deps } = mockDeps({ '.resolution()': '15', 'zoomToBarsRange': undefined });
    const result = await scrollToDate({ date: '1700000000', _deps });
    assert.equal(result.centered_on, 1700000000);
    assert.deepEqual(result.window, {
      from: 1700000000 - 25 * 15 * 60,
      to: 1700000000 + 25 * 15 * 60,
    });
  });

  it('rejects an unparseable date before any CDP call', async () => {
    const { _deps, evaluate } = mockDeps();
    await assert.rejects(
      () => scrollToDate({ date: 'not-a-date', _deps }),
      /Could not parse date/,
    );
    assert.equal(evaluate.calls.length, 0, 'no evaluate call for invalid input');
  });
});

// ── symbolInfo() ─────────────────────────────────────────────────────────

describe('symbolInfo() — DI + pass-through', () => {
  it('spreads the symbolExt fields into the result', async () => {
    const info = {
      symbol: 'ORCL', full_name: 'NYSE:ORCL', exchange: 'NYSE',
      description: 'Oracle Corporation', type: 'stock', pro_name: 'NYSE:ORCL',
      typespecs: [], resolution: '1D', chart_type: 1,
    };
    const { _deps, evaluate } = mockDeps({ 'symbolExt': info });
    const result = await symbolInfo({ _deps });
    assert.equal(result.success, true);
    assert.equal(result.symbol, 'ORCL');
    assert.equal(result.exchange, 'NYSE');
    assert.equal(result.resolution, '1D');
    assert.equal(evaluate.calls.length, 1);
    assert.ok(evaluate.calls[0].includes('symbolExt'), 'queries symbolExt');
  });

});
