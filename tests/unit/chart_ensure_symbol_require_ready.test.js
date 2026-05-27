import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetLedger } from '../../src/core/_mutation_ledger.js';
import * as chart from '../../src/core/chart.js';

/**
 * C11 / A1-F11 / A2-F4: chart_ensure_symbol must hard-stop (return
 * success:false + error:CHART_NOT_READY) when the chart did not become
 * ready, instead of silently returning chart_ready:false alongside a
 * resolved symbol that the caller treats as "safe enough".
 */
describe('chart.ensureSymbol — require_ready hard-stop (C11)', () => {
  beforeEach(() => _resetLedger());

  it('require_ready=true (default) → CHART_NOT_READY when not ready', async () => {
    const _deps = {
      evaluate: async () => ({ symbol: 'TADAWUL:2222', exchange: 'TADAWUL', description: '', type: 'stock' }),
      evaluateAsync: async () => undefined,
      waitForChartReady: async () => false,
    };
    const r = await chart.ensureSymbol({ symbol: 'TADAWUL:2222', _deps });
    assert.equal(r.success, false);
    assert.equal(r.error, 'CHART_NOT_READY');
    assert.equal(r.chart_ready, false);
    assert.match(r.next_action, /ready_timeout_ms|require_ready=false/);
  });

  it('success path: ready=true → no error, success=true', async () => {
    const _deps = {
      evaluate: async () => ({ symbol: 'TADAWUL:2222', exchange: 'TADAWUL', description: '', type: 'stock' }),
      evaluateAsync: async () => undefined,
      waitForChartReady: async () => true,
    };
    const r = await chart.ensureSymbol({ symbol: 'TADAWUL:2222', _deps });
    assert.equal(r.success, true);
    assert.equal(r.chart_ready, true);
    assert.equal(r.error, undefined);
  });

  it('require_ready=false (legacy) tolerates not-ready', async () => {
    const _deps = {
      evaluate: async () => ({ symbol: 'TADAWUL:2222', exchange: 'TADAWUL', description: '', type: 'stock' }),
      evaluateAsync: async () => undefined,
      waitForChartReady: async () => false,
    };
    const r = await chart.ensureSymbol({ symbol: 'TADAWUL:2222', require_ready: false, _deps });
    assert.equal(r.success, true);
    assert.equal(r.chart_ready, false);
    assert.equal(r.error, undefined);
  });
});
