/**
 * Offline unit tests for src/core/ui.js via the `_deps` injection seam.
 *   - mapKey() pure mapping (named keys, letters, digits, unsupported).
 *   - click()/findElement() route the selector value through safeString() so a
 *     malicious value is JSON-escaped (double-quoted) and never single-quoted
 *     into the evaluate payload.
 *   - keyboard() rejects unsupported keys before dispatching.
 *
 * Run: node --test tests/ui.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeString } from '../src/connection.js';
import { mapKey, click, findElement, keyboard } from '../src/core/ui.js';

function mockEval() {
  const calls = [];
  const fn = async (expr) => { calls.push(expr); return { found: true, tag: 'button' }; };
  fn.calls = calls;
  return fn;
}

describe('ui.mapKey — pure key mapping', () => {
  it('maps named keys', () => {
    assert.deepEqual(mapKey('Enter'), { code: 'Enter', vk: 13 });
    assert.deepEqual(mapKey('Escape'), { code: 'Escape', vk: 27 });
  });
  it('maps single letters and digits', () => {
    assert.deepEqual(mapKey('a'), { code: 'KeyA', vk: 65 });
    assert.deepEqual(mapKey('5'), { code: 'Digit5', vk: '5'.charCodeAt(0) });
  });
  it('returns null for unsupported keys', () => {
    assert.equal(mapKey('Ctrl+Shift+K'), null);
    assert.equal(mapKey(''), null);
    assert.equal(mapKey(42), null);
  });
});

describe('ui.click — selector sanitization', () => {
  it('routes the value through safeString (double-quoted, not single)', async () => {
    const evaluate = mockEval();
    const payload = '"]; fetch("https://evil"); //';
    await click({ by: 'data-name', value: payload, _deps: { evaluate } });
    const call = evaluate.calls[0];
    assert.ok(call.includes(safeString(payload)), 'value JSON-escaped via safeString');
    // The raw value must not appear single-quoted as a JS string literal.
    assert.ok(!call.includes(`= '${payload}'`), 'no single-quoted interpolation');
  });

  it('throws when no element is found', async () => {
    const evaluate = async () => ({ found: false });
    await assert.rejects(
      () => click({ by: 'text', value: 'Nope', _deps: { evaluate } }),
      /No matching element/,
    );
  });
});

describe('ui.findElement — query sanitization', () => {
  it('passes the query through safeString', async () => {
    const evaluate = mockEval();
    evaluate.calls.length = 0;
    const fn = async (expr) => { evaluate.calls.push(expr); return []; };
    await findElement({ query: 'a"b', strategy: 'aria-label', _deps: { evaluate: fn } });
    assert.ok(evaluate.calls[0].includes(safeString('a"b')), 'query JSON-escaped');
  });
});

describe('ui.keyboard — rejects unsupported keys', () => {
  it('throws before dispatching for an unsupported key', async () => {
    const client = { Input: { dispatchKeyEvent: async () => { throw new Error('should not dispatch'); } } };
    await assert.rejects(
      () => keyboard({ key: 'NotARealKey', _deps: { getClient: async () => client } }),
      /Unsupported key/,
    );
  });

  it('dispatches a mapped key via the injected client', async () => {
    const events = [];
    const client = { Input: { dispatchKeyEvent: async (e) => { events.push(e); } } };
    const r = await keyboard({ key: 'Escape', _deps: { getClient: async () => client } });
    assert.equal(r.success, true);
    assert.equal(events[0].code, 'Escape');
  });
});
