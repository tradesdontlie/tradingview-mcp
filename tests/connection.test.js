import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectChartTarget } from '../src/connection.js';

const targets = [
  {
    id: 'tab-a',
    type: 'page',
    url: 'https://www.tradingview.com/chart/AAA/?symbol=VANTAGE%3AEURUSD',
  },
  {
    id: 'tab-b',
    type: 'page',
    url: 'https://www.tradingview.com/chart/BBB/?symbol=VANTAGE%3AGBPUSD',
  },
];

describe('connection target selection', () => {
  it('uses TV_TARGET_ID before falling back to first TradingView chart', () => {
    const selected = selectChartTarget(targets, 'tab-b');
    assert.equal(selected.id, 'tab-b');
  });

  it('fails loudly when TV_TARGET_ID does not exist', () => {
    assert.throws(
      () => selectChartTarget(targets, 'missing-tab'),
      /TV_TARGET_ID missing-tab was not found/,
    );
  });

  it('keeps legacy first-chart fallback when no target id is requested', () => {
    const selected = selectChartTarget(targets);
    assert.equal(selected.id, 'tab-a');
  });
});
