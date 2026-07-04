/**
 * Tests for multi-strategy confluence assessment in core/confluence.js.
 * Pure functions over candidate-signal arrays — no live chart/exchange connection needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assessConfluence } from '../src/core/confluence.js';

function signal(strategy, side, confirmedAt) {
  return { strategy, plan: { side, entry: 100, stop: 95, target: 110 }, confirmedAt };
}

describe('assessConfluence()', () => {
  it('reports confluence when two strategies independently agree on the same side', () => {
    const result = assessConfluence({ signals: [signal('sfp', 'long', 1000), signal('divergence', 'long', 2000)] });
    assert.equal(result.confluence, true);
    assert.equal(result.conflict, false);
    assert.equal(result.side, 'long');
    assert.deepEqual(result.agreeing_strategies.sort(), ['divergence', 'sfp']);
    assert.match(result.confidence, /confluence/);
  });

  it('uses the most recently confirmed signal\'s plan as the execution plan when strategies agree', () => {
    const older = signal('sfp', 'short', 1000);
    older.plan = { side: 'short', entry: 100, stop: 105, target: 90 };
    const newer = signal('divergence', 'short', 5000);
    newer.plan = { side: 'short', entry: 102, stop: 107, target: 88 };
    const result = assessConfluence({ signals: [older, newer] });
    assert.equal(result.confluence, true);
    assert.equal(result.primary_strategy, 'divergence');
    assert.equal(result.plan, newer.plan);
  });

  it('stands down (no confluence, no conflict) when only one strategy fires', () => {
    const result = assessConfluence({ signals: [signal('sfp', 'long', 1000)] });
    assert.equal(result.confluence, false);
    assert.equal(result.conflict, false);
    assert.equal(result.side, 'long');
    assert.match(result.reason, /no independent confirmation/);
  });

  it('stands down with conflict:true when strategies disagree on direction', () => {
    const result = assessConfluence({ signals: [signal('sfp', 'long', 1000), signal('divergence', 'short', 2000)] });
    assert.equal(result.confluence, false);
    assert.equal(result.conflict, true);
    assert.match(result.reason, /disagree/);
  });

  it('reports confluence with 3+ agreeing strategies', () => {
    const result = assessConfluence({
      signals: [signal('sfp', 'short', 1000), signal('divergence', 'short', 2000), signal('levels', 'short', 3000)],
    });
    assert.equal(result.confluence, true);
    assert.equal(result.agreeing_strategies.length, 3);
    assert.equal(result.primary_strategy, 'levels');
  });

  it('rejects an empty signals array', () => {
    assert.throws(() => assessConfluence({ signals: [] }));
  });

  it('rejects a signal missing a strategy name', () => {
    assert.throws(() => assessConfluence({ signals: [{ plan: { side: 'long' } }, signal('divergence', 'long')] }));
  });

  it('rejects a signal with an invalid plan side', () => {
    assert.throws(() => assessConfluence({ signals: [{ strategy: 'sfp', plan: { side: 'sideways' } }, signal('divergence', 'long')] }));
  });
});
