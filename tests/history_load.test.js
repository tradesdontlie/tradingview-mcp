import { it } from 'node:test';
import assert from 'node:assert/strict';
import { loadHistory } from '../src/core/history.js';

function history({ count = 100, oldest = 5000, more = true, increment = 100, shift = false } = {}) {
  let clock = 0, requests = 0;
  const expressions = [], budgets = [];
  return {
    get requests() { return requests; }, expressions, budgets,
    _deps: {
      now: () => clock,
      sleep: async ms => { clock += ms; },
      evaluate: async (expression, options) => {
        expressions.push(expression); budgets.push(options.timeoutMs);
        if (expression.includes('series.requestMoreData(')) { requests++; count += increment; oldest -= increment; return true; }
        return { symbol: 'NASDAQ:AAPL', resolution: 'D', count, oldest, newest: 10000, more,
          visible_range: { from: 8000 + (shift && requests ? 1 : 0), to: 10000 } };
      },
    },
  };
}

it('loads requested total history without zooming, scrolling or changing symbol/timeframe', async () => {
  const mock = history();
  const result = await loadHistory({ count: 300, _deps: mock._deps });
  assert.equal(result.success, true);
  assert.equal(mock.requests, 2);
  assert.equal(result.loaded_after, 300);
  assert.equal(result.view_preserved, true);
  assert.ok(mock.expressions.every(e => !/zoomTo|setVisibleRange|setSymbol|setResolution|scrollTo/.test(e)));
});

it('does not request any additional page when before/count are already reached', async () => {
  const mock = history();
  const result = await loadHistory({ before: 6000, count: 50, _deps: mock._deps });
  assert.equal(result.status, 'reached');
  assert.equal(mock.requests, 0);
});

it('reports feed exhaustion separately from reaching the target', async () => {
  const mock = history({ more: false });
  const result = await loadHistory({ before: 1000, _deps: mock._deps });
  assert.equal(result.success, false);
  assert.equal(result.exhausted, true);
  assert.equal(mock.requests, 0);
});

it('enforces iteration and time bounds and forwards shrinking per-evaluation budgets', async () => {
  const mock = history();
  const result = await loadHistory({ count: 10000, max_iterations: 2, _deps: mock._deps });
  assert.equal(result.status, 'iteration_limit');
  assert.equal(mock.requests, 2);
  assert.ok(mock.budgets.at(-1) < mock.budgets[0]);
  const timed = history({ increment: 0 });
  const timeResult = await loadHistory({ count: 10000, timeout_ms: 100, settle_ms: 100, _deps: timed._deps });
  assert.equal(timeResult.status, 'deadline');
  assert.equal(timeResult.verification_complete, false);
  assert.equal(timeResult.view_preserved, null);
  assert.equal(timeResult.outcome, 'pending_or_unknown');
  assert.equal(timed.requests, 1);
});

it('stops if the native API changes the viewport, without falsely claiming preservation', async () => {
  const mock = history({ shift: true });
  const result = await loadHistory({ count: 10000, _deps: mock._deps });
  assert.equal(result.status, 'chart_or_view_changed');
  assert.equal(result.success, false);
  assert.equal(result.view_preserved, false);
  assert.equal(mock.requests, 1);
});

it('does not replay a page request when its transport outcome is uncertain', async () => {
  const mock = history();
  const ev = mock._deps.evaluate;
  let writes = 0;
  mock._deps.evaluate = async (expression, options) => {
    if (expression.includes('series.requestMoreData(')) { writes++; throw new Error('CDP timed out; outcome unknown'); }
    return ev(expression, options);
  };
  await assert.rejects(loadHistory({ count: 10000, _deps: mock._deps }), /outcome unknown/);
  assert.equal(writes, 1);
});

it('validates finite bounded inputs before accessing the chart', async () => {
  for (const options of [{ count: NaN }, { count: 0 }, { max_iterations: 51 }, { timeout_ms: Infinity }, { before: '2026-01-01' }]) {
    await assert.rejects(loadHistory({ ...options, _deps: { evaluate: () => { throw new Error('must not evaluate'); } } }), /must be an integer/);
  }
});

it('accepts bounded pre-1970 Unix timestamps without parsing local dates', async () => {
  const mock = history({ oldest: -2000 });
  const result = await loadHistory({ before: -1000, _deps: mock._deps });
  assert.equal(result.status, 'reached');
  assert.equal(mock.requests, 0);
});

it('reports pending or unknown after slow no-progress polls instead of certifying a final viewport', async () => {
  const mock = history({ increment: 0 });
  const result = await loadHistory({ count: 10000, timeout_ms: 30000, _deps: mock._deps });
  assert.equal(result.status, 'no_progress');
  assert.equal(result.verification_complete, false);
  assert.equal(result.view_preserved, null);
  assert.equal(result.outcome, 'pending_or_unknown');
  assert.equal(mock.requests, 1);
});
