import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetLedger } from '../../src/core/_mutation_ledger.js';
import * as chart from '../../src/core/chart.js';

/**
 * C1 / A1-F4 / A2-F1: chart_get_state must cross-check its reported symbol
 * and resolution against the live data-feed (mainSeries) and return
 * success:false + error:"CHART_DATA_STATE_MISMATCH" on mismatch.
 */
describe('chart.getState — feed coherence (C1)', () => {
  beforeEach(() => _resetLedger());

  it('coherent state returns coherent:true with no errors', async () => {
    const _deps = {
      evaluate: async () => ({
        symbol: 'TADAWUL:2222',
        resolution: '60',
        chartType: 1,
        delayed_feed: false,
        studies: [],
        _data_symbol: 'TADAWUL:2222',
        _data_resolution: '60',
      }),
    };
    const r = await chart.getState({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.coherent, true);
    assert.deepEqual(r.coherence_errors, []);
    assert.equal(r.symbol, 'TADAWUL:2222');
    assert.equal(r.data_symbol, 'TADAWUL:2222');
    assert.ok(typeof r.last_chart_mutation_id === 'number');
    assert.ok(typeof r.last_data_refresh_at === 'string');
  });

  it('symbol mismatch (state=2222, feed=6015) returns CHART_DATA_STATE_MISMATCH', async () => {
    const _deps = {
      evaluate: async () => ({
        symbol: 'TADAWUL:2222',
        resolution: '1D',
        chartType: 1,
        delayed_feed: false,
        studies: [],
        _data_symbol: 'TADAWUL:6015',
        _data_resolution: '1D',
      }),
    };
    const r = await chart.getState({ _deps });
    assert.equal(r.success, false);
    assert.equal(r.coherent, false);
    assert.equal(r.error, 'CHART_DATA_STATE_MISMATCH');
    assert.match(r.remediation, /reload|chart_ensure_symbol/);
    assert.equal(r.coherence_errors.length, 1);
    assert.match(r.coherence_errors[0], /TADAWUL:2222/);
    assert.match(r.coherence_errors[0], /TADAWUL:6015/);
  });

  it('resolution mismatch (state=1D, feed=240) returns CHART_DATA_STATE_MISMATCH', async () => {
    const _deps = {
      evaluate: async () => ({
        symbol: 'TADAWUL:2222',
        resolution: '1D',
        chartType: 1,
        delayed_feed: false,
        studies: [],
        _data_symbol: 'TADAWUL:2222',
        _data_resolution: '240',
      }),
    };
    const r = await chart.getState({ _deps });
    assert.equal(r.success, false);
    assert.equal(r.coherent, false);
    assert.equal(r.error, 'CHART_DATA_STATE_MISMATCH');
    assert.match(r.coherence_errors[0], /resolution/);
  });

  it('verify_against_feed=false skips the probe (coherent=null, success=true)', async () => {
    const _deps = {
      evaluate: async () => ({
        symbol: 'TADAWUL:2222',
        resolution: '1D',
        chartType: 1,
        delayed_feed: false,
        studies: [],
        _data_symbol: 'TADAWUL:6015', // would mismatch
        _data_resolution: '240',       // would mismatch
      }),
    };
    const r = await chart.getState({ _deps, verify_against_feed: false });
    assert.equal(r.success, true);
    assert.equal(r.coherent, null);
    assert.deepEqual(r.coherence_errors, []);
  });

  it('feed unreadable (null/null) yields coherent:null, success:true (graceful)', async () => {
    const _deps = {
      evaluate: async () => ({
        symbol: 'TADAWUL:2222',
        resolution: '1D',
        chartType: 1,
        delayed_feed: false,
        studies: [],
        _data_symbol: null,
        _data_resolution: null,
      }),
    };
    const r = await chart.getState({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.coherent, null);
  });

  it('_DLY suffix on either side is normalized (no false mismatch)', async () => {
    const _deps = {
      evaluate: async () => ({
        symbol: 'TADAWUL_DLY:2222',
        resolution: '60',
        chartType: 1,
        delayed_feed: true,
        studies: [],
        _data_symbol: 'TADAWUL:2222',
        _data_resolution: '60',
      }),
    };
    const r = await chart.getState({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.coherent, true);
  });

  it('last_chart_mutation_id reflects ledger state', async () => {
    const { recordChartMutation } = await import('../../src/core/_mutation_ledger.js');
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:1120' });
    const _deps = {
      evaluate: async () => ({
        symbol: 'TADAWUL:1120',
        resolution: '60',
        chartType: 1,
        delayed_feed: false,
        studies: [],
        _data_symbol: 'TADAWUL:1120',
        _data_resolution: '60',
      }),
    };
    const r = await chart.getState({ _deps });
    assert.equal(r.last_chart_mutation_id, 2);
    assert.equal(r.mutation_id, 2);
  });
});
