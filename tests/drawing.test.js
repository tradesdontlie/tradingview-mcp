/**
 * Tests for src/core/drawing.js.
 * Regression guard: listDrawings/getProperties/removeOne/clearAll must pull
 * `evaluate`/`getChartApi` from injected deps via _resolve(). A previous refactor
 * only wired drawShape, leaving the other four referencing undefined identifiers
 * (ReferenceError: getChartApi is not defined) at runtime.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drawShape, listDrawings, getProperties, removeOne, clearAll } from '../src/core/drawing.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

function mockEvaluate(responses = {}, sequence) {
  let callIdx = 0;
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    if (sequence && callIdx < sequence.length) return sequence[callIdx++];
    for (const [key, val] of Object.entries(responses)) {
      if (expr.includes(key)) return typeof val === 'function' ? val(callIdx++) : val;
    }
    return undefined;
  };
  fn.calls = calls;
  return fn;
}

function mockDeps(responses = {}, sequence) {
  const evaluate = mockEvaluate(responses, sequence);
  return { _deps: { evaluate, getChartApi: async () => 'window.__chart' }, evaluate };
}

// ── clearAll() ─────────────────────────────────────────────────────────────

describe('clearAll() — regression: must not throw "getChartApi is not defined"', () => {
  it('calls removeAllShapes on the chart api and returns success', async () => {
    const { _deps, evaluate } = mockDeps({});
    const result = await clearAll({ _deps });
    assert.equal(result.success, true);
    assert.equal(result.action, 'all_shapes_removed');
    assert.ok(evaluate.calls.some(c => c.includes('window.__chart.removeAllShapes()')));
  });
});

// ── listDrawings() ───────────────────────────────────────────────────────────

describe('listDrawings()', () => {
  it('returns count and shapes from the chart api', async () => {
    const shapes = [{ id: 'a', name: 'horizontal_line' }, { id: 'b', name: 'trend_line' }];
    const { _deps } = mockDeps({ 'getAllShapes': shapes });
    const result = await listDrawings({ _deps });
    assert.equal(result.success, true);
    assert.equal(result.count, 2);
    assert.deepEqual(result.shapes, shapes);
  });

  it('handles an empty chart', async () => {
    const { _deps } = mockDeps({ 'getAllShapes': [] });
    const result = await listDrawings({ _deps });
    assert.equal(result.count, 0);
  });
});

// ── removeOne() ──────────────────────────────────────────────────────────────

describe('removeOne()', () => {
  it('returns removed=true when the shape is gone', async () => {
    // removeOne calls evaluate once and gets back the whole result object
    const { _deps } = mockDeps({}, [{ removed: true, entity_id: 'x1', remaining_shapes: 3 }]);
    const result = await removeOne({ entity_id: 'x1', _deps });
    assert.equal(result.success, true);
    assert.equal(result.removed, true);
    assert.equal(result.entity_id, 'x1');
  });

  it('throws when the api reports the shape was not found', async () => {
    const { _deps } = mockDeps({}, [{ error: 'Shape not found: zzz' }]);
    await assert.rejects(() => removeOne({ entity_id: 'zzz', _deps }), /not found/i);
  });
});

// ── getProperties() ──────────────────────────────────────────────────────────

describe('getProperties()', () => {
  it('returns the resolved props object', async () => {
    const { _deps } = mockDeps({}, [{ entity_id: 'p1', visible: true, name: 'horizontal_line' }]);
    const result = await getProperties({ entity_id: 'p1', _deps });
    assert.equal(result.success, true);
    assert.equal(result.entity_id, 'p1');
    assert.equal(result.visible, true);
  });
});

// ── drawShape() (already wired, smoke test) ──────────────────────────────────

describe('drawShape()', () => {
  it('creates a single-point shape and returns the new entity id', async () => {
    // before -> [], create -> undefined, after -> ['new1']
    const { _deps } = mockDeps({}, [[], undefined, ['new1']]);
    const result = await drawShape({
      shape: 'horizontal_line',
      point: { time: 1780860900, price: 0.0027 },
      _deps,
    });
    assert.equal(result.success, true);
    assert.equal(result.entity_id, 'new1');
  });

  it('rejects a non-finite price', async () => {
    const { _deps } = mockDeps({}, [[], undefined, []]);
    await assert.rejects(() => drawShape({
      shape: 'horizontal_line',
      point: { time: 1780860900, price: NaN },
      _deps,
    }));
  });
});
