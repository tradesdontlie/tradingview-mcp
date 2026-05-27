import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetLedger, recordChartMutation } from '../../src/core/_mutation_ledger.js';
import * as data from '../../src/core/data.js';

/**
 * C9 / A1-F9 / A2-F5: data_get_pine_tables must differentiate "no study
 * matches filter" (could be wrong filter) from "study found but no table
 * rendered on the last bar" (could be barstate.islast gating or render-range).
 */

describe('data.getPineTables — C9 diagnostic differentiation', () => {
  beforeEach(() => _resetLedger());

  it('study found + tables present → success', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    const _deps = {
      evaluate: async (expr) => {
        const s = String(expr);
        if (/\.symbol\(\)/.test(s) && /\.resolution\(\)/.test(s)) {
          return { symbol: 'TADAWUL:2222', resolution: '60' };
        }
        if (/dwgtablecells/.test(s)) {
          return [{ name: 'EarnsTable', count: 2, items: [
            { id: 't1', raw: { tid: 0, row: 0, col: 0, t: 'Q1' } },
          ] }];
        }
        if (/getAllStudies/.test(s)) {
          return [{ id: 's1', name: 'EarnsTable' }];
        }
        return null;
      },
    };
    const r = await data.getPineTables({ study_filter: 'EarnsTable', _deps });
    assert.equal(r.success, true);
    assert.equal(r.study_count, 1);
  });

  it('study found but no tables → NO_PINE_TABLES_EXTRACTED with diagnostic', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    const _deps = {
      evaluate: async (expr) => {
        const s = String(expr);
        if (/\.symbol\(\)/.test(s) && /\.resolution\(\)/.test(s)) {
          return { symbol: 'TADAWUL:2222', resolution: '60' };
        }
        if (/dwgtablecells/.test(s)) return []; // no table extracted
        if (/getAllStudies/.test(s)) {
          return [{ id: 's1', name: 'EarnsExtractor' }]; // study IS present
        }
        return null;
      },
    };
    const r = await data.getPineTables({ study_filter: 'EarnsExtractor', _deps });
    assert.equal(r.success, false);
    assert.equal(r.error, 'NO_PINE_TABLES_EXTRACTED');
    assert.deepEqual(r.studies_seen, ['EarnsExtractor']);
    assert.equal(r.tables_in_last_bar, 0);
    assert.match(r.diagnostic, /barstate\.islast|labels|chart_scroll_to_date/);
    assert.equal(r.chart_symbol, 'TADAWUL:2222');
  });

  it('study NOT found → distinct diagnostic (wrong filter)', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    const _deps = {
      evaluate: async (expr) => {
        const s = String(expr);
        if (/\.symbol\(\)/.test(s) && /\.resolution\(\)/.test(s)) {
          return { symbol: 'TADAWUL:2222', resolution: '60' };
        }
        if (/dwgtablecells/.test(s)) return [];
        if (/getAllStudies/.test(s)) {
          return [{ id: 's1', name: 'Volume' }, { id: 's2', name: 'RSI' }];
        }
        return null;
      },
    };
    const r = await data.getPineTables({ study_filter: 'NotPresent', _deps });
    assert.equal(r.success, true);
    assert.equal(r.study_count, 0);
    assert.deepEqual(r.studies_seen, []);
    assert.match(r.diagnostic, /No on-chart study matches/);
  });

  it('no studies at all on chart', async () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    const _deps = {
      evaluate: async (expr) => {
        const s = String(expr);
        if (/\.symbol\(\)/.test(s) && /\.resolution\(\)/.test(s)) {
          return { symbol: 'TADAWUL:2222', resolution: '60' };
        }
        if (/dwgtablecells/.test(s)) return [];
        if (/getAllStudies/.test(s)) return [];
        return null;
      },
    };
    const r = await data.getPineTables({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.study_count, 0);
    assert.match(r.diagnostic, /No studies are on the chart/);
  });
});
