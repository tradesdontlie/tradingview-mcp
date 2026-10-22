/**
 * Tests for the declared-title parser behind the pine save guard: compile/save
 * refuse when the editor's saved script name differs from the source's title.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDeclaredTitle } from '../src/core/pine.js';

describe('getDeclaredTitle', () => {
  it('reads indicator, strategy and library titles', () => {
    assert.equal(getDeclaredTitle('//@version=6\nindicator("My script")\nplot(close)'), 'My script');
    assert.equal(getDeclaredTitle('//@version=6\nstrategy("My strategy", overlay=true)'), 'My strategy');
    assert.equal(getDeclaredTitle('//@version=6\nlibrary("MyLibrary")'), 'MyLibrary');
  });

  it('handles title= keyword, single quotes and unicode', () => {
    assert.equal(getDeclaredTitle("indicator(title = 'JA Invest — Tendência Semanal · Position', overlay=true)"), 'JA Invest — Tendência Semanal · Position');
  });

  it('ignores commented-out declarations and returns null when absent', () => {
    assert.equal(getDeclaredTitle('// indicator("old")\nplot(close)'), null);
    assert.equal(getDeclaredTitle(''), null);
    assert.equal(getDeclaredTitle(undefined), null);
  });
});
