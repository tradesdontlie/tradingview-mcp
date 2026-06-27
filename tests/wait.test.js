/**
 * Offline unit tests for the generic pollUntil() helper in src/wait.js.
 *
 * pollUntil(predicate, { interval, timeout }) polls predicate() (possibly async)
 * until it returns truthy or the timeout elapses. Resolves to the truthy value on
 * success, or null on timeout. Tiny intervals/timeouts keep these tests fast.
 */
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pollUntil, normalizeResolution, waitForChartReady } from '../src/wait.js';

test('pollUntil resolves with the truthy value once the predicate becomes true', async () => {
  let calls = 0;
  const result = await pollUntil(() => {
    calls += 1;
    return calls >= 3 ? `ready-${calls}` : false;
  }, { interval: 5, timeout: 200 });
  assert.equal(result, 'ready-3');
  assert.ok(calls >= 3);
});

test('pollUntil returns the truthy value immediately when predicate is already true', async () => {
  let calls = 0;
  const result = await pollUntil(() => { calls += 1; return 42; }, { interval: 5, timeout: 50 });
  assert.equal(result, 42);
  assert.equal(calls, 1);
});

test('pollUntil returns null on timeout when predicate never becomes truthy', async () => {
  const result = await pollUntil(() => false, { interval: 5, timeout: 50 });
  assert.equal(result, null);
});

test('pollUntil supports async predicates', async () => {
  let calls = 0;
  const result = await pollUntil(async () => {
    calls += 1;
    return calls >= 2 ? 'async-ok' : null;
  }, { interval: 5, timeout: 200 });
  assert.equal(result, 'async-ok');
});

test('pollUntil uses default options when none are provided', async () => {
  // With defaults (interval 200, timeout 10000) the first immediate truthy hit
  // returns without waiting a full interval.
  const result = await pollUntil(() => 'default-ok');
  assert.equal(result, 'default-ok');
});

describe('normalizeResolution', () => {
  it('treats 1D/1W/1M as D/W/M but keeps plain 1 (1-minute)', () => {
    assert.equal(normalizeResolution('1D'), 'D');
    assert.equal(normalizeResolution('D'), 'D');
    assert.equal(normalizeResolution('1W'), 'W');
    assert.equal(normalizeResolution('1M'), 'M');
    assert.equal(normalizeResolution('1'), '1');
    assert.equal(normalizeResolution('60'), '60');
  });

  it('uppercases/trims and maps null/empty to null', () => {
    assert.equal(normalizeResolution(' d '), 'D');
    assert.equal(normalizeResolution(null), null);
    assert.equal(normalizeResolution(undefined), null);
    assert.equal(normalizeResolution(''), null);
  });
});

describe('waitForChartReady — readiness gate (DI evaluate + instant sleep)', () => {
  const stateReturning = (state) => ({ _deps: { evaluate: async () => state, sleep: async () => {} } });

  it('returns true on stable bars when resolution matches (1D == D)', async () => {
    const ok = await waitForChartReady(null, 'D', 1000, stateReturning({ isLoading: false, barCount: 100, currentSymbol: '', resolution: '1D' }));
    assert.equal(ok, true);
  });

  it('does NOT gate when the resolution cannot be read (null) — still reaches ready', async () => {
    const ok = await waitForChartReady(null, 'D', 1000, stateReturning({ isLoading: false, barCount: 100, currentSymbol: '', resolution: null }));
    assert.equal(ok, true, 'a null resolution must not block readiness');
  });

  it('blocks (times out false) only on a positively-read DIFFERENT resolution', async () => {
    const ok = await waitForChartReady(null, 'D', 40, stateReturning({ isLoading: false, barCount: 100, currentSymbol: '', resolution: '60' }));
    assert.equal(ok, false, '60 != D must keep blocking until timeout');
  });

  it('returns false on timeout while the chart is still loading', async () => {
    const ok = await waitForChartReady(null, null, 40, stateReturning({ isLoading: true, barCount: -1, currentSymbol: '', resolution: 'D' }));
    assert.equal(ok, false);
  });
});
