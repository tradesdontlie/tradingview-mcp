/**
 * Unit tests for parallel_channel drawing support.
 * Covers drawShape() point handling (1 vs 2 vs 3 points) and the
 * drawParallelChannel() convenience wrapper.
 * Pure unit (mocked CDP eval) — no TradingView Desktop required.
 *
 * Run: node --test tests/draw_parallel_channel.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drawShape, drawParallelChannel } from '../src/core/drawing.js';

// Mock: getAllShapes returns [] before the create, then one new id after, so
// drawShape's poll resolves an entity_id on the first iteration.
function mockDeps() {
  const calls = [];
  let created = false;
  const evaluate = async (expr) => {
    calls.push(expr);
    if (expr.includes('createShape(') || expr.includes('createMultipointShape(')) { created = true; return undefined; }
    if (expr.includes('getAllShapes')) return created ? ['shape_new'] : [];
    return undefined;
  };
  evaluate.calls = calls;
  const createExpr = () => calls.find((c) => c.includes('createShape(') || c.includes('createMultipointShape('));
  return { _deps: { evaluate, evaluateAsync: evaluate, waitForChartReady: async () => true, getChartApi: async () => 'window.__api' }, evaluate, createExpr };
}

describe('drawShape() — point arity', () => {
  it('uses createShape for a single point', async () => {
    const { _deps, createExpr } = mockDeps();
    await drawShape({ shape: 'horizontal_line', point: { time: 1, price: 2 }, _deps });
    assert.match(createExpr(), /createShape\(/);
    assert.doesNotMatch(createExpr(), /createMultipointShape/);
  });

  it('uses createMultipointShape for two points', async () => {
    const { _deps, createExpr } = mockDeps();
    await drawShape({ shape: 'trend_line', point: { time: 1, price: 2 }, point2: { time: 3, price: 4 }, _deps });
    assert.match(createExpr(), /createMultipointShape\(/);
    assert.match(createExpr(), /\[\{"time":1,"price":2\},\{"time":3,"price":4\}\]/);
  });

  it('passes three points for parallel_channel / pitchfork', async () => {
    const { _deps, createExpr } = mockDeps();
    await drawShape({ shape: 'parallel_channel', point: { time: 1, price: 2 }, point2: { time: 3, price: 4 }, point3: { time: 5, price: 6 }, _deps });
    assert.match(createExpr(), /createMultipointShape\(/);
    assert.match(createExpr(), /\{"time":5,"price":6\}/);
  });

  it('resolves the new entity_id by polling getAllShapes', async () => {
    const { _deps } = mockDeps();
    const res = await drawShape({ shape: 'trend_line', point: { time: 1, price: 2 }, point2: { time: 3, price: 4 }, _deps });
    assert.equal(res.entity_id, 'shape_new');
  });
});

describe('drawParallelChannel()', () => {
  it('derives the 3rd (parallel) anchor from width below the main rail', async () => {
    const { _deps, createExpr } = mockDeps();
    await drawParallelChannel({ point: { time: 100, price: 5000 }, point2: { time: 200, price: 4000 }, width: 1000, _deps });
    assert.match(createExpr(), /shape: "parallel_channel"/);
    // third point = { time: point2.time, price: point2.price - width } = 200 / 3000
    assert.match(createExpr(), /\{"time":200,"price":3000\}/);
  });

  it('uses an explicit point3 when provided (ignores width)', async () => {
    const { _deps, createExpr } = mockDeps();
    await drawParallelChannel({ point: { time: 100, price: 5000 }, point2: { time: 200, price: 4000 }, point3: { time: 200, price: 2500 }, _deps });
    assert.match(createExpr(), /\{"time":200,"price":2500\}/);
  });

  it('never attaches a text label (breaks the parallel_channel tool)', async () => {
    const { _deps, createExpr } = mockDeps();
    await drawParallelChannel({ point: { time: 100, price: 5000 }, point2: { time: 200, price: 4000 }, width: 1000, _deps });
    assert.match(createExpr(), /text: ""/);
  });
});
