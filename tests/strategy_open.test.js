import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStrategy } from '../src/core/strategy.js';

function deps(overrides = {}) {
  return {
    layoutList: async () => ({
      success: true,
      active_layout: { id: 2, name: 'Hit & Run Algo', url: 'xz2DdnNx', active: true },
      layouts: [
        { id: 1, name: '8AM Breakout Algo', url: 'hRmRbL7i', active: false },
        { id: 2, name: 'Hit & Run Algo', url: 'xz2DdnNx', active: true },
      ],
    }),
    layoutSwitch: async ({ name }) => ({
      success: true,
      action: 'switched',
      verified: true,
      layout: name,
      layout_id: 1,
      layout_url: 'hRmRbL7i',
    }),
    openPanel: async ({ panel, action }) => ({ success: true, panel, action, performed: 'opened' }),
    getState: async () => ({ success: true, symbol: 'US500', resolution: '5', chartType: 1, studies: [] }),
    ...overrides,
  };
}

describe('strategy_open', () => {
  it('returns a dry-run plan without touching TradingView', async () => {
    let switched = false;
    const result = await openStrategy({
      name: '8AM',
      dry_run: true,
      _deps: deps({
        layoutSwitch: async () => {
          switched = true;
          throw new Error('should not switch in dry_run');
        },
      }),
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'planned');
    assert.equal(result.would_switch_layout, true);
    assert.equal(result.plan.target_layout.name, '8AM Breakout Algo');
    assert.equal(switched, false);
  });

  it('opens the layout, panels, and verifies chart state', async () => {
    const panelCalls = [];
    const result = await openStrategy({
      name: '8AM Breakout Algo',
      symbol: 'US500',
      timeframe: '5',
      panels: ['alerts', 'strategy-tester'],
      _deps: deps({
        openPanel: async ({ panel, action }) => {
          panelCalls.push({ panel, action });
          return { success: true, panel, action, performed: 'opened' };
        },
      }),
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'opened');
    assert.equal(result.layout, '8AM Breakout Algo');
    assert.deepEqual(result.panels_opened, ['alerts', 'strategy-tester']);
    assert.equal(panelCalls.length, 2);
    assert.equal(result.chart_state.symbol, 'US500');
    assert.equal(result.chart_state.resolution, '5');
  });

  it('returns already_active behavior when target layout is active', async () => {
    let switches = 0;
    const result = await openStrategy({
      name: 'Hit & Run Algo',
      _deps: deps({
        layoutSwitch: async () => {
          switches += 1;
          throw new Error('should not switch active layout');
        },
        getState: async () => ({ success: true, symbol: 'SOLUSD', resolution: '1D', chartType: 1, studies: [] }),
      }),
    });

    assert.equal(result.success, true);
    assert.equal(result.steps[0].result.action, 'already_active');
    assert.equal(switches, 0);
  });

  it('fails clearly on symbol or timeframe mismatch', async () => {
    await assert.rejects(
      () => openStrategy({
        name: '8AM Breakout Algo',
        symbol: 'BTCUSD',
        timeframe: '1D',
        _deps: deps(),
      }),
      /verification failed/i,
    );
  });

  it('fails clearly on ambiguous partial matches', async () => {
    await assert.rejects(
      () => openStrategy({
        name: 'hit',
        dry_run: true,
        _deps: deps({
          layoutList: async () => ({
            success: true,
            active_layout: null,
            layouts: [
              { id: 2, name: 'Hit & Run Algo', url: 'xz2DdnNx', active: false },
              { id: 3, name: 'Hit the Open Algo', url: 'abc123', active: false },
            ],
          }),
        }),
      }),
      /ambiguous/i,
    );
  });
});
