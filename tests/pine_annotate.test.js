/**
 * Unit tests for pine_check's annotated output and message interpolation.
 * Stubs fetch — no TradingView connection or network needed.
 *
 * Run: node --test tests/pine_annotate.test.js
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { annotate, check } from '../src/core/pine.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFacade(payload) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload,
  });
}

describe('annotate', () => {
  it('puts a caret under the reported column', () => {
    const source = '//@version=5\nindicator("t")\nplot(ta.sma(clse, 20))';
    const out = annotate(source, [{ line: 3, column: 13, message: 'Undeclared identifier "clse"' }]);
    const [srcLine, caretLine] = out.split('\n');

    assert.equal(srcLine, '   3 | plot(ta.sma(clse, 20))');
    assert.equal(caretLine.indexOf('^'), srcLine.indexOf('clse'));
    assert.ok(caretLine.endsWith('^-- Undeclared identifier "clse"'));
  });

  it('handles a line number outside the source without throwing', () => {
    const out = annotate('plot(close)', [{ line: 99, column: 1, message: 'nope' }]);
    assert.equal(out, '   ? | nope');
  });

  it('handles a missing column', () => {
    const out = annotate('plot(close)', [{ line: 1, message: 'no column given' }]);
    assert.ok(out.includes('^-- no column given'));
  });

  it('renders one block per issue', () => {
    const source = 'a\nb\nc';
    const out = annotate(source, [
      { line: 1, column: 1, message: 'first' },
      { line: 3, column: 1, message: 'second' },
    ]);
    assert.equal(out.split('\n').length, 4);
    assert.ok(out.includes('first') && out.includes('second'));
  });
});

describe('check — message interpolation', () => {
  it('fills {placeholders} from the ctx map', async () => {
    stubFacade({
      success: true,
      result: {
        errors2: [{
          code: 'CE10272',
          ctx: { identifier: 'risk' },
          message: 'Undeclared identifier "{identifier}"',
          start: { line: 1, column: 5 },
          end: { line: 1, column: 8 },
        }],
      },
    });

    const result = await check({ source: 'x := 1' });
    assert.equal(result.compiled, false);
    assert.equal(result.errors[0].message, 'Undeclared identifier "risk"');
    assert.equal(result.errors[0].code, 'CE10272');
    assert.ok(result.annotated.includes('^-- Undeclared identifier "risk"'));
  });

  it('leaves a placeholder alone when ctx has no value for it', async () => {
    stubFacade({
      success: true,
      result: {
        errors2: [{ ctx: { other: 'x' }, message: 'Missing {identifier}', start: { line: 1, column: 1 } }],
      },
    });

    const result = await check({ source: 'plot(close)' });
    assert.equal(result.errors[0].message, 'Missing {identifier}');
  });

  it('interpolates warnings too and annotates them', async () => {
    stubFacade({
      success: true,
      result: {
        warnings2: [{ ctx: { fn: 'plot' }, message: 'Slow "{fn}"', start: { line: 1, column: 1 } }],
      },
    });

    const result = await check({ source: 'plot(close)' });
    assert.equal(result.compiled, true, 'warnings alone still compile');
    assert.equal(result.warning_count, 1);
    assert.equal(result.warnings[0].message, 'Slow "plot"');
    assert.ok(result.annotated.includes('^-- Slow "plot"'));
  });

  it('omits annotated when the script is clean', async () => {
    stubFacade({ success: true, result: { functions2: [] } });

    const result = await check({ source: 'plot(close)' });
    assert.equal(result.compiled, true);
    assert.equal(result.annotated, undefined);
    assert.equal(result.note, 'Pine Script compiled successfully.');
  });
});
