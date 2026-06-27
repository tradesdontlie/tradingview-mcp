/**
 * Offline DI-mocked tests for the three chart.js functions that previously
 * called a bare `evaluate` out of module scope (fix-chart-evaluate-scope):
 * getVisibleRange, scrollToDate, symbolInfo. Injecting `_deps.evaluate` proves
 * each resolves evaluate via _resolve(_deps) and returns its shaped result with
 * no `ReferenceError: evaluate is not defined`. A regression that drops the DI
 * resolution fails here rather than only the live tool.
 *
 * Run: node --test tests/chart.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getVisibleRange, scrollToDate, symbolInfo } from '../src/core/chart.js';

describe('chart.js getVisibleRange — resolves evaluate via DI', () => {
  it('returns the range from the injected evaluate (no ReferenceError)', async () => {
    const calls = [];
    const _deps = {
      evaluate: async (js) => {
        calls.push(js);
        return { visible_range: { from: 100, to: 200 }, bars_range: { from: 0, to: 50 } };
      },
    };
    const r = await getVisibleRange({ _deps });
    assert.equal(r.success, true);
    assert.deepEqual(r.visible_range, { from: 100, to: 200 });
    assert.deepEqual(r.bars_range, { from: 0, to: 50 });
    assert.equal(calls.length, 1, 'issued its evaluate call');
  });
});

describe('chart.js scrollToDate — resolves evaluate via DI', () => {
  it('reads resolution then issues the zoom evaluate', async () => {
    const calls = [];
    const _deps = {
      evaluate: async (js) => {
        calls.push(js);
        if (/resolution\(\)/.test(js)) return 'D';
        return null;
      },
    };
    const r = await scrollToDate({ date: '2024-01-15', _deps });
    assert.equal(r.success, true);
    assert.equal(r.date, '2024-01-15');
    assert.equal(r.resolution, 'D');
    assert.equal(typeof r.centered_on, 'number');
    assert.ok(r.window && typeof r.window.from === 'number', 'window bounds present');
    assert.ok(calls.length >= 2, 'issued resolution + zoom evaluate calls');
    assert.ok(calls.some(js => /zoomToBarsRange/.test(js)), 'issued the zoom call');
  });
});

describe('chart.js symbolInfo — resolves evaluate via DI', () => {
  it('returns symbol metadata from the injected evaluate', async () => {
    let called = false;
    const _deps = {
      evaluate: async () => {
        called = true;
        return { symbol: 'AAPL', exchange: 'NASDAQ', resolution: 'D', chart_type: 1, type: 'stock' };
      },
    };
    const r = await symbolInfo({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.symbol, 'AAPL');
    assert.equal(r.exchange, 'NASDAQ');
    assert.equal(r.resolution, 'D');
    assert.ok(called, 'called the injected evaluate');
  });
});
