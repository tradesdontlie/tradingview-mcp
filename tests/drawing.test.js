import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drawShape } from '../src/core/drawing.js';

describe('drawShape()', () => {
  it('awaits the creation promise and reports the landed entity', async () => {
    const calls = [];
    const evaluate = async (expr) => {
      calls.push(expr);
      if (expr.includes('getAllShapes')) return ['shape_1'];
      return undefined;
    };
    const evaluateAsync = async (expr) => {
      calls.push(expr);
      return 'shape_1';
    };
    const result = await drawShape({
      shape: 'horizontal_line',
      point: { time: 100, price: 50 },
      _deps: { evaluate, evaluateAsync, getChartApi: async () => 'window.__api' },
    });
    assert.equal(result.success, true);
    assert.equal(result.entity_id, 'shape_1');
    assert.ok(calls.some((c) => c.includes('createShape')), 'creation uses async evaluator');
  });

  it('reports failure when the created shape is never observable', async () => {
    const evaluate = async (expr) => (expr.includes('getAllShapes') ? [] : undefined);
    const evaluateAsync = async () => undefined;
    const result = await drawShape({
      shape: 'horizontal_line',
      point: { time: 100, price: 50 },
      _deps: { evaluate, evaluateAsync, getChartApi: async () => 'window.__api', sleep: async () => {} },
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'shape_not_observed');
  });
});
