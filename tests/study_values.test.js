/**
 * Tests for getStudyValues() in src/core/data.js: `last_bar_values` come from
 * each study's own series (latest bar), not the crosshair-driven data window.
 * The page script runs in a vm sandbox against a fake TradingView chart.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { getStudyValues } from '../src/core/data.js';

function study({ name, plots, titles, last, dataWindow }) {
  return {
    metaInfo: () => ({
      description: name,
      plots: plots.map((id) => ({ id })),
      styles: Object.fromEntries(plots.filter((id) => titles[id]).map((id) => [id, { title: titles[id] }])),
    }),
    data: () => ({ last: () => (last ? { index: 300, value: last } : null) }),
    dataWindowView: () => ({ items: () => dataWindow.map(([t, v]) => ({ _title: t, _value: v })) }),
    id: () => name.toLowerCase().replace(/\W+/g, '_'),
    inputs: () => ({}),
  };
}

function runInFakeChart(sources) {
  const innerModel = { dataSources: () => sources };
  const chartWidget = { model: () => ({ model: () => innerModel }) };
  const window = { TradingViewApi: { _activeChartWidgetWV: { value: () => ({ _chartWidget: chartWidget }) } } };
  // JSON round-trip: CDP returns the page result by value, like this.
  return { evaluate: async (expr) => JSON.parse(JSON.stringify(vm.runInNewContext(expr, { window }))) };
}

describe('getStudyValues — latest bar independent of the crosshair', () => {
  it('reads last_bar_values from the series while values keep the (hovered) data window', async () => {
    const ema = study({
      name: 'EMA+ ATR Support Resistance', plots: ['plot_0', 'plot_1'], titles: { plot_0: 'EMA', plot_1: 'ATR' },
      last: [1791082800, 1.5254, 0.0122],
      dataWindow: [['EMA', '1.4860'], ['ATR', '0.0075']],          // crosshair resting on an old bar
    });
    const r = await getStudyValues({ _deps: runInFakeChart([ema]) });
    assert.equal(r.success, true);
    assert.equal(r.study_count, 1);
    const s = r.studies[0];
    assert.deepEqual(s.values, { EMA: '1.4860', ATR: '0.0075' });   // unchanged field
    assert.deepEqual(s.last_bar_values, { EMA: 1.5254, ATR: 0.0122 });
    assert.equal(s.last_bar_time, 1791082800);
  });

  it('keeps a study whose data window is empty (non-price pane, #461) and skips untitled plots', async () => {
    const rsi = study({
      name: 'Relative Strength Index', plots: ['plot_0', 'plot_1'], titles: { plot_0: 'RSI' },  // plot_1 untitled
      last: [1791082800, 47.4, 3], dataWindow: [['RSI', '∅']],
    });
    const r = await getStudyValues({ _deps: runInFakeChart([rsi]) });
    assert.equal(r.study_count, 1);
    assert.deepEqual(r.studies[0].values, {});
    assert.deepEqual(r.studies[0].last_bar_values, { RSI: 47.4 });
  });

  it('drops non-finite values and studies with nothing to report', async () => {
    const empty = study({ name: 'Dividends', plots: ['Gross'], titles: {}, last: null, dataWindow: [] });
    const vwap = study({
      name: 'Anchored VWAP', plots: ['VWAP', 'UpperBand'], titles: { VWAP: 'VWAP', UpperBand: 'Upper Band' },
      last: [1791082800, 1.4876, null], dataWindow: [],
    });
    const r = await getStudyValues({ _deps: runInFakeChart([empty, vwap]) });
    assert.deepEqual(r.studies.map((s) => s.name), ['Anchored VWAP']);
    assert.deepEqual(r.studies[0].last_bar_values, { VWAP: 1.4876 });
  });
});
