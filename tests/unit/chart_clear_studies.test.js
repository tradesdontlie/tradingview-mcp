import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetLedger } from '../../src/core/_mutation_ledger.js';
import * as chart from '../../src/core/chart.js';

/**
 * C13 / A1-F13: chart_clear_studies — bulk-remove studies, preserving
 * built-ins and an optional name allowlist. Operator session
 * (CC TV MCP.txt:721-742) had to loop chart_manage_indicator(remove)
 * one study at a time; this collapses that into one call.
 */
describe('chart.clearStudies (C13)', () => {
  beforeEach(() => _resetLedger());

  it('removes all non-built-in studies by default', async () => {
    const removeCalls = [];
    const _deps = {
      evaluate: async (expr) => {
        const s = String(expr);
        if (/getAllStudies/.test(s)) {
          return [
            { id: 'a', name: 'Volume' },
            { id: 'b', name: 'EarnsExtractor' },
            { id: 'c', name: 'Linear Regression Channel' },
          ];
        }
        if (/removeEntity/.test(s)) {
          const m = s.match(/removeEntity\("([^"]+)"\)/);
          if (m) removeCalls.push(m[1]);
          return true;
        }
        return null;
      },
      evaluateAsync: async () => undefined,
      waitForChartReady: async () => true,
    };
    const r = await chart.clearStudies({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.total_studies_before, 3);
    assert.equal(r.removed.length, 2);
    assert.deepEqual(r.preserved.map(p => p.name), ['Volume']);
    assert.deepEqual(removeCalls, ['b', 'c']);
  });

  it('preserves except_names allowlist (case-insensitive)', async () => {
    const _deps = {
      evaluate: async (expr) => {
        const s = String(expr);
        if (/getAllStudies/.test(s)) {
          return [
            { id: 'a', name: 'EarnsExtractor' },
            { id: 'b', name: 'RSI' },
            { id: 'c', name: 'Volume' },
          ];
        }
        if (/removeEntity/.test(s)) return true;
        return null;
      },
      evaluateAsync: async () => undefined,
      waitForChartReady: async () => true,
    };
    const r = await chart.clearStudies({ except_names: ['EARNSEXTRACTOR'], _deps });
    assert.equal(r.success, true);
    assert.equal(r.removed.length, 1);
    assert.equal(r.removed[0].name, 'RSI');
    assert.equal(r.preserved.length, 2);
  });

  it('dry_run returns would_remove without calling removeEntity', async () => {
    let removeCalled = false;
    const _deps = {
      evaluate: async (expr) => {
        const s = String(expr);
        if (/getAllStudies/.test(s)) {
          return [{ id: 'a', name: 'Foo' }, { id: 'b', name: 'Volume' }];
        }
        if (/removeEntity/.test(s)) { removeCalled = true; return true; }
        return null;
      },
      evaluateAsync: async () => undefined,
      waitForChartReady: async () => true,
    };
    const r = await chart.clearStudies({ dry_run: true, _deps });
    assert.equal(r.dry_run, true);
    assert.equal(r.would_remove.length, 1);
    assert.equal(r.would_remove[0].name, 'Foo');
    assert.equal(removeCalled, false);
  });

  it('except_built_ins=false removes Volume too', async () => {
    const _deps = {
      evaluate: async (expr) => {
        const s = String(expr);
        if (/getAllStudies/.test(s)) {
          return [{ id: 'a', name: 'Volume' }, { id: 'b', name: 'RSI' }];
        }
        if (/removeEntity/.test(s)) return true;
        return null;
      },
      evaluateAsync: async () => undefined,
      waitForChartReady: async () => true,
    };
    const r = await chart.clearStudies({ except_built_ins: false, _deps });
    assert.equal(r.removed.length, 2);
    assert.equal(r.preserved.length, 0);
  });
});
