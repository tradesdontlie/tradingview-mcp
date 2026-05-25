import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetLedger, recordChartMutation } from '../../src/core/_mutation_ledger.js';
import * as pine from '../../src/core/pine.js';

/**
 * C5 / A1-F6: pine_wait_for_output replaces 47 Bash(sleep N) calls with
 * a single tool that polls the requested Pine emit kind until the condition
 * is met (min_count + optional expected_for_symbol) OR timeout.
 */

function _depsThatReturnsAfter(callCount, finalStudies, chart_symbol = 'TADAWUL:2222', resolution = '60') {
  // returns an empty list for the first `callCount` polls, then finalStudies after
  let n = 0;
  return {
    evaluate: async (expr) => {
      const s = String(expr);
      if (/\.symbol\(\)/.test(s) && /\.resolution\(\)/.test(s)) {
        return { symbol: chart_symbol, resolution };
      }
      n += 1;
      if (n <= callCount) return [];
      return finalStudies;
    },
  };
}

describe('pine.waitForOutput (C5)', () => {
  beforeEach(() => _resetLedger());

  it('returns immediately when output is already present', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    const _deps = _depsThatReturnsAfter(0, [
      { name: 'EarnsExtractor', count: 5, items: [
        { id: 'l1', raw: { t: 'a', y: 1.1 } },
        { id: 'l2', raw: { t: 'b', y: 2.2 } },
      ] },
    ]);
    const r = await pine.waitForOutput({
      study_filter: 'EarnsExtractor',
      emit: 'labels',
      min_count: 1,
      poll_interval_ms: 50,
      timeout_s: 2,
      _deps,
    });
    assert.equal(r.success, true);
    assert.equal(r.emit, 'labels');
    assert.equal(r.study_filter, 'EarnsExtractor');
    assert.ok(r.polls >= 1);
    assert.ok(r.wait_ms_elapsed >= 0);
    assert.equal(r.total_count, 5);
  });

  it('polls and returns success once output appears', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    const _deps = _depsThatReturnsAfter(2, [
      { name: 'EarnsExtractor', count: 3, items: [{ id: 'l1', raw: { t: 'x', y: 1 } }] },
    ]);
    const r = await pine.waitForOutput({
      study_filter: 'EarnsExtractor',
      emit: 'labels',
      min_count: 1,
      poll_interval_ms: 50,
      timeout_s: 3,
      _deps,
    });
    assert.equal(r.success, true);
    assert.ok(r.polls >= 3);
  });

  it('returns PINE_WAIT_TIMEOUT when output never appears', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    const _deps = {
      evaluate: async (expr) => {
        const s = String(expr);
        if (/\.symbol\(\)/.test(s) && /\.resolution\(\)/.test(s)) {
          return { symbol: 'TADAWUL:2222', resolution: '60' };
        }
        return []; // always empty
      },
    };
    const start = Date.now();
    const r = await pine.waitForOutput({
      study_filter: 'NotThere',
      emit: 'labels',
      min_count: 1,
      poll_interval_ms: 50,
      timeout_s: 1,
      _deps,
    });
    const elapsed = Date.now() - start;
    assert.equal(r.success, false);
    assert.equal(r.code, 'PINE_WAIT_TIMEOUT');
    assert.equal(r.emit, 'labels');
    assert.equal(r.study_filter, 'NotThere');
    assert.ok(elapsed >= 1000, `expected >=1000ms elapsed, got ${elapsed}`);
    assert.match(r.remediation, /pine_get_errors/);
  });

  it('expected_for_symbol satisfied → returns success', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    const _deps = _depsThatReturnsAfter(0, [
      { name: 'EarnsExtractor', count: 5, items: [{ id: 'l1', raw: { t: 'OK', y: 27.9 } }] },
    ], 'TADAWUL:2222');
    const r = await pine.waitForOutput({
      study_filter: 'EarnsExtractor',
      emit: 'labels',
      min_count: 1,
      expected_for_symbol: 'TADAWUL:2222',
      poll_interval_ms: 50,
      timeout_s: 2,
      _deps,
    });
    assert.equal(r.success, true);
    assert.equal(r.chart_symbol, 'TADAWUL:2222');
  });

  it('expected_for_symbol stale → keeps polling, eventually times out', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:1120' });
    const _deps = _depsThatReturnsAfter(0, [
      { name: 'EarnsExtractor', count: 5, items: [{ id: 'l1', raw: { t: 'stale', y: 50 } }] },
    ], 'TADAWUL:1120'); // chart is on 1120 but caller wants 2222
    const r = await pine.waitForOutput({
      study_filter: 'EarnsExtractor',
      emit: 'labels',
      min_count: 1,
      expected_for_symbol: 'TADAWUL:2222',
      poll_interval_ms: 50,
      timeout_s: 1,
      _deps,
    });
    assert.equal(r.success, false);
    assert.equal(r.code, 'PINE_WAIT_TIMEOUT');
    assert.equal(r.expected_for_symbol, 'TADAWUL:2222');
  });

  it('emit=lines polls the correct getter', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    let lineCallSeen = false;
    const _deps = {
      evaluate: async (expr) => {
        const s = String(expr);
        if (/\.symbol\(\)/.test(s) && /\.resolution\(\)/.test(s)) {
          return { symbol: 'TADAWUL:2222', resolution: '60' };
        }
        if (/dwglines/.test(s)) {
          lineCallSeen = true;
          return [{ name: 'PivotLines', count: 2, items: [
            { id: 'l1', raw: { y1: 100, y2: 100 } },
            { id: 'l2', raw: { y1: 99, y2: 99 } },
          ] }];
        }
        return [];
      },
    };
    const r = await pine.waitForOutput({
      study_filter: 'PivotLines',
      emit: 'lines',
      min_count: 1,
      poll_interval_ms: 50,
      timeout_s: 2,
      _deps,
    });
    assert.equal(r.success, true);
    assert.equal(r.emit, 'lines');
    assert.equal(lineCallSeen, true);
  });

  it('rejects bad emit value', async () => {
    let threw = false;
    try {
      await pine.waitForOutput({ study_filter: 'X', emit: 'NOPE' });
    } catch (e) {
      threw = true;
      assert.match(e.message, /emit must be one of/);
    }
    assert.equal(threw, true);
  });

  it('rejects missing study_filter', async () => {
    let threw = false;
    try {
      await pine.waitForOutput({});
    } catch (e) {
      threw = true;
      assert.match(e.message, /study_filter is required/);
    }
    assert.equal(threw, true);
  });
});
