/**
 * Tests for src/core/screener_columns.js — list + stretch stubs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { list, reset, remove, add, reorder } from '../src/core/screener_columns.js';

function mockEvaluate(handler) {
  const calls = [];
  const fn = async (expr) => { calls.push(expr); return handler(expr, calls.length - 1); };
  fn.calls = calls;
  return fn;
}

describe('screener_columns.list()', () => {
  it('returns not-open when screener is closed', async () => {
    const evaluate = mockEvaluate(() => null);
    const r = await list({ _deps: { evaluate } });
    assert.equal(r.success, false);
    assert.equal(r.open, false);
    assert.match(r.error, /not open/i);
  });

  it('returns columns when open', async () => {
    const cols = ['Symbol', 'Price', 'Change %', 'Volume', 'Market cap'];
    const evaluate = mockEvaluate(() => ({ columns: cols }));
    const r = await list({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.action, 'list');
    assert.equal(r.count, 5);
    assert.deepEqual(r.columns, cols);
  });

  it('propagates table_not_found error from probe', async () => {
    const evaluate = mockEvaluate(() => ({ error: 'table_not_found' }));
    const r = await list({ _deps: { evaluate } });
    assert.equal(r.success, false);
    assert.equal(r.error, 'table_not_found');
    assert.equal(r.open, true);
  });
});

describe('screener_columns stretch actions', () => {
  it('reset returns not-open when closed', async () => {
    const evaluate = mockEvaluate(() => null);
    const r = await reset({ _deps: { evaluate } });
    assert.equal(r.success, false);
    assert.equal(r.open, false);
  });

  it('reset returns not_implemented_yet when open', async () => {
    const evaluate = mockEvaluate(() => ({ columns: ['Symbol'] }));
    const r = await reset({ _deps: { evaluate } });
    assert.equal(r.success, false);
    assert.equal(r.error, 'not_implemented_yet');
    assert.ok(r.hint);
  });

  it('remove returns not_implemented_yet when open', async () => {
    const evaluate = mockEvaluate(() => ({ columns: [] }));
    const r = await remove({ column: 'Price', _deps: { evaluate } });
    assert.equal(r.error, 'not_implemented_yet');
  });

  it('add returns not_implemented_yet when open', async () => {
    const evaluate = mockEvaluate(() => ({ columns: [] }));
    const r = await add({ column: 'Beta', _deps: { evaluate } });
    assert.equal(r.error, 'not_implemented_yet');
  });

  it('reorder returns not_implemented_yet when open', async () => {
    const evaluate = mockEvaluate(() => ({ columns: [] }));
    const r = await reorder({ columns: ['Symbol', 'Price'], _deps: { evaluate } });
    assert.equal(r.error, 'not_implemented_yet');
  });
});
