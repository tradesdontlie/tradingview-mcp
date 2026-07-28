import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCdpPort, resolveConnectionTargetId, selectChartTarget } from '../src/connection.js';

describe('selectChartTarget', () => {
  it('selects the explicitly owned CDP target instead of the first TradingView tab', () => {
    const targets = [
      { id: 'existing-iren', type: 'page', url: 'https://www.tradingview.com/chart/?symbol=IREN' },
      { id: 'owned-abbv', type: 'page', url: 'https://www.tradingview.com/chart/?symbol=ABBV' },
    ];

    assert.equal(selectChartTarget(targets, 'owned-abbv')?.id, 'owned-abbv');
  });
});

describe('resolveConnectionTargetId', () => {
  it('uses the Ticker Alpha owned-target environment binding by default', () => {
    assert.equal(
      resolveConnectionTargetId(null, { TRADINGVIEW_MCP_TARGET_ID: 'owned-abbv' }),
      'owned-abbv',
    );
  });
});

describe('resolveCdpPort', () => {
  it('accepts the Ticker Alpha TradingView CDP port variable', () => {
    assert.equal(resolveCdpPort({ TRADINGVIEW_CDP_PORT: '9224' }), 9224);
  });
});
