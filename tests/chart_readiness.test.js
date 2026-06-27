/**
 * Offline unit tests for chart-readiness handling in src/core/chart.js.
 *
 * These use the `_deps` DI seam to inject fake `waitForChartReady`, `evaluate`,
 * and `pollUntil` implementations so no live TradingView is required.
 *
 * Coverage:
 *  - setTimeframe returns { success:false } when readiness times out (false).
 *  - setTimeframe returns { success:true } when readiness resolves true.
 *  - setSymbol returns { success:false } on readiness timeout.
 *  - manageIndicator('add') resolves the new entity id once the injected
 *    evaluate reports the study list grew (via the bounded pollUntil path).
 *
 * Note: src/wait.js imports `evaluate` directly (no DI seam of its own), so its
 * resolution-matching logic is exercised here through chart.js's injected
 * waitForChartReady stub. Dedicated wait.js coverage is deferred to change #10
 * (complete-dependency-injection-and-tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeframe, setSymbol, manageIndicator } from '../src/core/chart.js';
import { pollUntil } from '../src/wait.js';

test('setTimeframe returns success:false when readiness times out', async () => {
  const deps = {
    evaluate: async () => undefined, // setResolution payload return value is ignored
    waitForChartReady: async () => false, // simulate timeout
  };
  const res = await setTimeframe({ timeframe: '60', _deps: deps });
  assert.equal(res.success, false);
  assert.match(res.error, /did not stabilize/i);
  assert.equal(res.chart_ready, false);
  assert.equal(res.timeframe, '60');
});

test('setTimeframe passes the expected timeframe to waitForChartReady', async () => {
  let seenSymbol, seenTf;
  const deps = {
    evaluate: async () => undefined,
    waitForChartReady: async (sym, tf) => { seenSymbol = sym; seenTf = tf; return true; },
  };
  const res = await setTimeframe({ timeframe: 'D', _deps: deps });
  assert.equal(res.success, true);
  assert.equal(res.chart_ready, true);
  assert.equal(seenSymbol, null);
  assert.equal(seenTf, 'D');
});

test('setSymbol returns success:false when readiness times out', async () => {
  const deps = {
    evaluateAsync: async () => undefined,
    waitForChartReady: async () => false,
  };
  const res = await setSymbol({ symbol: 'AAPL', _deps: deps });
  assert.equal(res.success, false);
  assert.match(res.error, /did not stabilize/i);
  assert.equal(res.chart_ready, false);
  assert.equal(res.symbol, 'AAPL');
});

test('setSymbol returns success:true when readiness resolves true', async () => {
  const deps = {
    evaluateAsync: async () => undefined,
    waitForChartReady: async () => true,
  };
  const res = await setSymbol({ symbol: 'AAPL', _deps: deps });
  assert.equal(res.success, true);
  assert.equal(res.chart_ready, true);
  assert.equal(res.symbol, 'AAPL');
});

test('manageIndicator(add) polls until the study list grows and returns the new id', async () => {
  // First evaluate call = "before" id list, second = createStudy payload (ignored),
  // then pollUntil reads the study list which grows on its 3rd read.
  let studyListReads = 0;
  const evaluate = async (code) => {
    if (code.includes('createStudy')) return undefined;
    if (code.includes('getAllStudies')) {
      studyListReads += 1;
      if (studyListReads === 1) return ['s1']; // before snapshot
      // pollUntil reads: first poll still 1 study, second poll the new one appears
      if (studyListReads < 3) return ['s1'];
      return ['s1', 's2'];
    }
    return undefined;
  };
  const res = await manageIndicator({
    action: 'add',
    indicator: 'Relative Strength Index',
    _deps: { evaluate, pollUntil },
  });
  assert.equal(res.success, true);
  assert.equal(res.action, 'add');
  assert.equal(res.entity_id, 's2');
  assert.equal(res.new_study_count, 1);
});

test('manageIndicator(add) reports failure when the study never appears', async () => {
  const evaluate = async (code) => {
    if (code.includes('createStudy')) return undefined;
    if (code.includes('getAllStudies')) return ['s1']; // never grows
    return undefined;
  };
  // Use a fast pollUntil to keep the test quick (override default budget).
  const fastPoll = (predicate) => pollUntil(predicate, { interval: 2, timeout: 20 });
  const res = await manageIndicator({
    action: 'add',
    indicator: 'Relative Strength Index',
    _deps: { evaluate, pollUntil: fastPoll },
  });
  assert.equal(res.success, false);
  assert.equal(res.entity_id, null);
  assert.equal(res.new_study_count, 0);
});
