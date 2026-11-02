import { it } from 'node:test';
import assert from 'node:assert/strict';
import { isChartTarget, hasChartApi } from '../src/connection.js';

it('accepts actual chart pages and excludes shells, workers, unrelated pages and lookalike URLs', () => {
  for (const url of ['https://www.tradingview.com/chart/temp/', 'https://de.tradingview.com/chart/', 'https://tradingview.com/chart']) {
    assert.equal(isChartTarget({ type: 'page', url }), true, url);
  }
  for (const url of ['file:///TradingView/app/window/index.html', 'https://www.tradingview.com/', 'https://www.tradingview.com/charting-library/', 'https://evil.example/?next=https://www.tradingview.com/chart/', 'https://tradingview.com.evil.example/chart/', 'not-a-url']) {
    assert.equal(isChartTarget({ type: 'page', url }), false, url);
  }
  assert.equal(isChartTarget({ type: 'worker', url: 'https://www.tradingview.com/chart/' }), false);
});

it('requires a live chart API, rather than a page that merely evaluates JavaScript', async () => {
  for (const value of [1, undefined, false]) {
    assert.equal(await hasChartApi({ Runtime: { evaluate: async () => ({ result: { value } }) } }), false);
  }
  assert.equal(await hasChartApi({ Runtime: { evaluate: async () => ({ result: { value: true } }) } }), true);
  assert.equal(await hasChartApi({ Runtime: { evaluate: async () => ({ result: { value: true }, exceptionDetails: {} }) } }), false);
});
