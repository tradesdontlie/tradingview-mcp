/**
 * Tests for alert_create / alert_delete REST-API logic.
 *
 * The old DOM-dialog implementation silently failed (price field never populated
 * → price_set:false → no alert created). These tests lock in the REST behavior:
 * correct request shape ({payload:{conditions:[...]}}, text/plain, condition-type
 * mapping) and fail-loud verification (POST "ok" but not found on re-list → error).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { create, deleteAlerts } from '../src/core/alerts.js';

// Mock evaluateAsync: records the generated expression and returns a canned payload.
function mockEval(payload) {
  const calls = [];
  const fn = async (expr) => { calls.push(expr); return typeof payload === 'function' ? payload(expr) : payload; };
  fn.calls = calls;
  return fn;
}

describe('alerts.create() — REST request shape', () => {
  it('builds a {payload:{conditions:[...]}} body posted as text/plain', async () => {
    const evaluateAsync = mockEval({ alert_id: 1, symbol: 'BATS:AAPL', verified: true, verified_value: 150, verified_symbol: 'BATS:AAPL' });
    await create({ condition: 'crossing', price: 150, _deps: { evaluateAsync } });
    const expr = evaluateAsync.calls[0];
    assert.ok(expr.includes('/create_alert'), 'hits create_alert endpoint');
    assert.ok(expr.includes("'Content-Type': 'text/plain'"), 'uses text/plain to dodge CORS preflight');
    assert.ok(expr.includes('payload:'), 'wraps body in payload');
    assert.ok(expr.includes('conditions:'), 'uses conditions array');
    assert.ok(/list_alerts/.test(expr), 'verifies via list_alerts in the same call');
  });

  it('maps condition aliases to TradingView types', async () => {
    const cases = [['less_than', '"less"'], ['below', '"less"'], ['greater_than', '"greater"'], ['above', '"greater"'], ['crossing', '"cross"'], ['banana', '"cross"']];
    for (const [input, expected] of cases) {
      const evaluateAsync = mockEval({ alert_id: 1, symbol: 'X', verified: true });
      await create({ condition: input, price: 10, _deps: { evaluateAsync } });
      assert.ok(evaluateAsync.calls[0].includes(`type: ${expected}`), `${input} -> ${expected}`);
    }
  });

  it('rejects a non-positive price before calling out', async () => {
    const evaluateAsync = mockEval({});
    await assert.rejects(() => create({ condition: 'crossing', price: 0, _deps: { evaluateAsync } }), /positive numeric price/);
    assert.equal(evaluateAsync.calls.length, 0, 'never issued a request for an invalid price');
  });

  it('fails loudly when the POST is rejected', async () => {
    const evaluateAsync = mockEval({ error: 'invalid_request', symbol: 'BATS:AAPL' });
    const r = await create({ condition: 'less_than', price: 150, _deps: { evaluateAsync } });
    assert.equal(r.success, false);
    assert.match(r.error, /invalid_request/);
  });

  it('fails loudly when created but not found on verification', async () => {
    const evaluateAsync = mockEval({ alert_id: 99, symbol: 'BATS:AAPL', verified: false });
    const r = await create({ condition: 'less_than', price: 150, _deps: { evaluateAsync } });
    assert.equal(r.success, false);
    assert.match(r.error, /not found on verification/);
  });

  it('returns success with alert_id when verified', async () => {
    const evaluateAsync = mockEval({ alert_id: 4242, symbol: 'BATS:AAPL', verified: true, verified_value: 150, verified_symbol: 'BATS:AAPL' });
    const r = await create({ condition: 'less_than', price: 150, _deps: { evaluateAsync } });
    assert.equal(r.success, true);
    assert.equal(r.alert_id, 4242);
    assert.equal(r.price, 150);
  });
});

describe('alerts.deleteAlerts()', () => {
  it('deletes specific ids via {payload:{alert_ids:[...]}}', async () => {
    const evaluateAsync = mockEval({ deleted: 2, ids: [1, 2] });
    const r = await deleteAlerts({ alert_id: [1, 2], _deps: { evaluateAsync } });
    assert.equal(r.success, true);
    assert.equal(r.deleted, 2);
    assert.ok(evaluateAsync.calls[0].includes('alert_ids'), 'uses alert_ids payload');
    assert.ok(evaluateAsync.calls[0].includes('/delete_alerts'), 'hits delete_alerts endpoint');
  });
});
