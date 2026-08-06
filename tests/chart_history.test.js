/**
 * Unit tests for setVisibleRange history paging.
 * Pure unit (mocked CDP eval) — no TradingView Desktop required.
 *
 * Run: node --test tests/chart_history.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setVisibleRange } from '../src/core/chart.js';

// Stateful mock: a probe reports the earliest loaded bar (`current`); each
// requestMoreData(1000) page pushes that earliest bar back by `step`.
function mockDeps({ firstTime = 500, more = true, step = 2000 } = {}) {
  const calls = [];
  let current = firstTime;
  const evaluate = async (expr) => {
    calls.push(expr);
    if (expr.includes('requestMoreDataAvailable')) return { firstTime: current, more };   // probe
    if (expr.includes('requestMoreData(1000)')) { current -= step; return undefined; }     // page
    if (expr.includes('getVisibleRange')) return { from: 11, to: 22 };                      // actual
    return undefined;                                                                       // zoom
  };
  evaluate.calls = calls;
  const pageCount = () => calls.filter((c) => c.includes('requestMoreData(1000)')).length;
  return { _deps: { evaluate, evaluateAsync: evaluate, waitForChartReady: async () => true, getChartApi: async () => 'window.__api' }, evaluate, pageCount };
}

describe('setVisibleRange() — history paging', () => {
  it('does NOT page when the earliest loaded bar already covers `from`', async () => {
    const { _deps, pageCount } = mockDeps({ firstTime: 500 }); // 500 <= from(1000)
    await setVisibleRange({ from: 1000, to: 2000, _deps });
    assert.equal(pageCount(), 0);
  });

  it('pages back via requestMoreData until the earliest bar reaches `from`', async () => {
    const { _deps, pageCount } = mockDeps({ firstTime: 5000, step: 2000 }); // 5000→3000→1000
    await setVisibleRange({ from: 1000, to: 9000, _deps });
    assert.equal(pageCount(), 2);
  });

  it('stops paging when the feed reports no more data', async () => {
    const { _deps, pageCount } = mockDeps({ firstTime: 5000, more: false });
    await setVisibleRange({ from: 1000, to: 9000, _deps });
    assert.equal(pageCount(), 0);
  });

  it('always zooms and returns requested + actual range', async () => {
    const { _deps, evaluate } = mockDeps({ firstTime: 500 });
    const res = await setVisibleRange({ from: 1000, to: 2000, _deps });
    assert.ok(evaluate.calls.some((c) => c.includes('zoomToBarsRange')));
    assert.deepEqual(res.requested, { from: 1000, to: 2000 });
    assert.deepEqual(res.actual, { from: 11, to: 22 });
  });
});
