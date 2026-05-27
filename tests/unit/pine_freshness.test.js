import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetLedger, recordChartMutation } from '../../src/core/_mutation_ledger.js';
import * as data from '../../src/core/data.js';

/**
 * C3 / A1-F3 / A2-F3: data_get_pine_labels/tables/lines/boxes must return
 * freshness provenance (chart_symbol, chart_resolution, last_chart_mutation_id)
 * and, when caller passes expected_for_symbol that differs from chart_symbol,
 * return success:false + error:"PINE_OUTPUT_STALE_AFTER_SYMBOL_CHANGE"
 * instead of stale data masquerading as success.
 */

function _depsForChart(symbol, resolution = '60', graphicsResult = []) {
  return {
    evaluate: async (expr) => {
      const s = String(expr);
      if (/\.symbol\(\)/.test(s) && /\.resolution\(\)/.test(s)) {
        return { symbol, resolution };
      }
      // graphics-buildJS calls — return supplied per-study output
      return graphicsResult;
    },
  };
}

describe('data.getPineLabels — C3 freshness provenance', () => {
  beforeEach(() => _resetLedger());

  it('returns chart_symbol + last_chart_mutation_id on success', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    const _deps = _depsForChart('TADAWUL:2222', '60', [
      { name: 'EarnsExtractor', count: 2, items: [
        { id: 'l1', raw: { t: 'EARN|2222|10.5', y: 27.9 } },
        { id: 'l2', raw: { t: 'EARN|2222|9.0',  y: 28.1 } },
      ] },
    ]);
    const r = await data.getPineLabels({ study_filter: 'EarnsExtractor', _deps });
    assert.equal(r.success, true);
    assert.equal(r.chart_symbol, 'TADAWUL:2222');
    assert.equal(r.chart_resolution, '60');
    assert.equal(r.last_chart_mutation_id, 1);
    assert.equal(r.stale, false);
    assert.equal(r.stale_reason, null);
    assert.equal(r.study_count, 1);
  });

  it('REJECTS with PINE_OUTPUT_STALE_AFTER_SYMBOL_CHANGE when expected_for_symbol differs', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:1120' });
    // chart is on 1120 (Al Rajhi); caller expected 1031 (Saudi Cement)
    const _deps = _depsForChart('TADAWUL:1120', '60', [
      { name: 'EarnsExtractor', count: 58, items: [
        { id: 'l1', raw: { t: 'EARN|1120|...', y: 50.0 } },
      ] },
    ]);
    const r = await data.getPineLabels({
      study_filter: 'EarnsExtractor',
      expected_for_symbol: 'TADAWUL:1031',
      _deps,
    });
    assert.equal(r.success, false);
    assert.equal(r.error, 'PINE_OUTPUT_STALE_AFTER_SYMBOL_CHANGE');
    assert.equal(r.stale, true);
    assert.match(r.stale_reason, /TADAWUL:1120/);
    assert.match(r.stale_reason, /TADAWUL:1031/);
    assert.deepEqual(r.studies, []);
    // provenance still surfaced for diagnosis
    assert.equal(r.chart_symbol, 'TADAWUL:1120');
  });

  it('expected_for_symbol matches chart → not stale', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    const _deps = _depsForChart('TADAWUL:2222', '60', [
      { name: 'EarnsExtractor', count: 1, items: [{ id: 'l1', raw: { t: 'OK', y: 27.9 } }] },
    ]);
    const r = await data.getPineLabels({
      study_filter: 'EarnsExtractor',
      expected_for_symbol: 'TADAWUL:2222',
      _deps,
    });
    assert.equal(r.success, true);
    assert.equal(r.stale, false);
  });

  it('_DLY normalization (chart=TADAWUL_DLY:2222, expected=TADAWUL:2222) → not stale', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL_DLY:2222' });
    const _deps = _depsForChart('TADAWUL_DLY:2222', '60', [
      { name: 'EarnsExtractor', count: 1, items: [{ id: 'l1', raw: { t: 'OK', y: 27.9 } }] },
    ]);
    const r = await data.getPineLabels({
      study_filter: 'EarnsExtractor',
      expected_for_symbol: 'TADAWUL:2222',
      _deps,
    });
    assert.equal(r.success, true);
    assert.equal(r.stale, false);
  });

  it('no expected_for_symbol → provenance only, no staleness', async () => {
    const _deps = _depsForChart('TADAWUL:2222', '60', []);
    const r = await data.getPineLabels({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.stale, false);
    assert.equal(r.chart_symbol, 'TADAWUL:2222');
  });
});

describe('data.getPineTables — C3 freshness provenance', () => {
  beforeEach(() => _resetLedger());

  it('returns provenance + studies on success', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    const _deps = _depsForChart('TADAWUL:2222', '1D', [
      { name: 'EarnsTable', count: 2, items: [
        { id: 't1', raw: { tid: 0, row: 0, col: 0, t: 'Q1' } },
        { id: 't2', raw: { tid: 0, row: 0, col: 1, t: '10.5' } },
      ] },
    ]);
    const r = await data.getPineTables({ study_filter: 'EarnsTable', _deps });
    assert.equal(r.success, true);
    assert.equal(r.chart_symbol, 'TADAWUL:2222');
    assert.equal(r.chart_resolution, '1D');
    assert.ok(r.last_chart_mutation_id >= 1);
  });

  it('REJECTS stale read', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:1120' });
    const _deps = _depsForChart('TADAWUL:1120', '1D', []);
    const r = await data.getPineTables({
      expected_for_symbol: 'TADAWUL:2222',
      _deps,
    });
    assert.equal(r.success, false);
    assert.equal(r.error, 'PINE_OUTPUT_STALE_AFTER_SYMBOL_CHANGE');
  });
});

describe('data.getPineLines — C3 freshness provenance', () => {
  beforeEach(() => _resetLedger());

  it('returns provenance', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    const _deps = _depsForChart('TADAWUL:2222', '60', []);
    const r = await data.getPineLines({ _deps });
    assert.equal(r.chart_symbol, 'TADAWUL:2222');
    assert.equal(r.last_chart_mutation_id, 1);
    assert.equal(r.stale, false);
  });

  it('REJECTS stale read', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:1120' });
    const _deps = _depsForChart('TADAWUL:1120', '60', []);
    const r = await data.getPineLines({ expected_for_symbol: 'TADAWUL:6015', _deps });
    assert.equal(r.success, false);
    assert.equal(r.error, 'PINE_OUTPUT_STALE_AFTER_SYMBOL_CHANGE');
  });
});

describe('data.getPineBoxes — C3 freshness provenance', () => {
  beforeEach(() => _resetLedger());

  it('returns provenance', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    const _deps = _depsForChart('TADAWUL:2222', '60', []);
    const r = await data.getPineBoxes({ _deps });
    assert.equal(r.chart_symbol, 'TADAWUL:2222');
    assert.equal(r.last_chart_mutation_id, 1);
  });

  it('REJECTS stale read', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:1120' });
    const _deps = _depsForChart('TADAWUL:1120', '60', []);
    const r = await data.getPineBoxes({ expected_for_symbol: 'TADAWUL:6015', _deps });
    assert.equal(r.success, false);
    assert.equal(r.error, 'PINE_OUTPUT_STALE_AFTER_SYMBOL_CHANGE');
  });
});
