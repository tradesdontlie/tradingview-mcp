/**
 * Unit tests for chart_set_right_offset.
 * Pure unit (mocked CDP eval) — no TradingView Desktop required.
 *
 * Run: node --test tests/chart_right_offset.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setRightOffset } from '../src/core/chart.js';

function mockDeps() {
  const calls = [];
  const evaluate = async (expr) => {
    calls.push(expr);
    if (expr.includes('getVisibleRange')) return { from: 100, to: 200 };
    return undefined;
  };
  evaluate.calls = calls;
  return { _deps: { evaluate, evaluateAsync: evaluate, waitForChartReady: async () => true, getChartApi: async () => 'window.__api' }, evaluate };
}

describe('setRightOffset()', () => {
  it('calls timeScale().setRightOffset(n) with the requested bar count', async () => {
    const { _deps, evaluate } = mockDeps();
    await setRightOffset({ bars: 30, _deps });
    const call = evaluate.calls.find((c) => c.includes('setRightOffset'));
    assert.ok(call, 'a setRightOffset expression should be emitted');
    assert.match(call, /setRightOffset\(30\)/);
  });

  it('returns success and echoes the offset + actual range', async () => {
    const { _deps } = mockDeps();
    const res = await setRightOffset({ bars: 60, _deps });
    assert.equal(res.success, true);
    assert.equal(res.right_offset, 60);
    assert.deepEqual(res.actual, { from: 100, to: 200 });
  });

  it('coerces numeric strings', async () => {
    const { _deps, evaluate } = mockDeps();
    const res = await setRightOffset({ bars: '45', _deps });
    assert.equal(res.right_offset, 45);
    assert.match(evaluate.calls.find((c) => c.includes('setRightOffset')), /setRightOffset\(45\)/);
  });

  it('rejects non-finite bar counts', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => setRightOffset({ bars: 'abc', _deps }), /bars must be a finite number/);
  });
});
