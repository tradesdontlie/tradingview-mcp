/**
 * Tests for capSource() in src/core/pine.js — the pine_get_source output cap.
 * Pure string logic, no chart/CDP needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { capSource } from '../src/core/pine.js';

const SRC = 'abcdefghij'; // 10 chars

describe('capSource()', () => {
  it('returns full source untruncated when no cap is given', () => {
    assert.deepEqual(capSource(SRC), { source: SRC, truncated: false });
    assert.deepEqual(capSource(SRC, null), { source: SRC, truncated: false });
    assert.deepEqual(capSource(SRC, undefined), { source: SRC, truncated: false });
  });

  it('does not truncate when the cap is >= the length', () => {
    assert.deepEqual(capSource(SRC, 10), { source: SRC, truncated: false });
    assert.deepEqual(capSource(SRC, 999), { source: SRC, truncated: false });
  });

  it('truncates to exactly max_chars when the source is longer', () => {
    const r = capSource(SRC, 4);
    assert.equal(r.source, 'abcd');
    assert.equal(r.truncated, true);
    assert.equal(r.source.length, 4);
  });

  it('ignores non-positive and non-finite caps (returns full source)', () => {
    for (const bad of [0, -5, NaN, Infinity, 'x']) {
      assert.deepEqual(capSource(SRC, bad), { source: SRC, truncated: false }, `cap=${bad}`);
    }
  });

  it('coerces a numeric-string cap', () => {
    const r = capSource(SRC, '3');
    assert.equal(r.source, 'abc');
    assert.equal(r.truncated, true);
  });
});
