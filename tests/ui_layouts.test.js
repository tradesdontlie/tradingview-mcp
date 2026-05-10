import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { layoutList, layoutSwitch } from '../src/core/ui.js';

function createAsyncQueue(values) {
  const calls = [];
  const fn = async () => {
    const next = values.shift();
    calls.push(next);
    return next;
  };
  fn.calls = calls;
  return fn;
}

function createEvalQueue(values) {
  const calls = [];
  const fn = async () => {
    const next = values.length > 0 ? values.shift() : { dismissed: false, label: null };
    calls.push(next);
    return next;
  };
  fn.calls = calls;
  return fn;
}

describe('ui layouts', () => {
  it('layoutList exposes active layout metadata', async () => {
    const evaluateAsync = createAsyncQueue([{
      source: 'load_chart_service',
      current_slug: 'hRmRbL7i',
      current_href: 'https://de.tradingview.com/chart/hRmRbL7i/',
      layouts: [
        { id: 186002420, name: '8AM Breakout Algo', url: 'hRmRbL7i', symbol: 'US500', interval: '5' },
        { id: 186166925, name: 'Hit & Run Algo', url: 'xz2DdnNx', symbol: 'SOLUSD', interval: '1D' },
      ],
    }]);

    const result = await layoutList({ _deps: { evaluateAsync } });
    assert.equal(result.success, true);
    assert.equal(result.layout_count, 2);
    assert.equal(result.current_slug, 'hRmRbL7i');
    assert.equal(result.active_layout?.name, '8AM Breakout Algo');
    assert.equal(result.layouts[0].active, true);
    assert.equal(result.layouts[1].active, false);
    assert.equal(result.layouts[0].url, 'hRmRbL7i');
  });

  it('layoutSwitch rejects ambiguous partial matches', async () => {
    const evaluateAsync = createAsyncQueue([{
      source: 'load_chart_service',
      current_slug: 'xz2DdnNx',
      current_href: 'https://de.tradingview.com/chart/xz2DdnNx/',
      layouts: [
        { id: 186166925, name: 'Hit & Run Algo', url: 'xz2DdnNx' },
        { id: 187748360, name: 'hit and run 2 US100', url: 'b2TXdUfn' },
      ],
    }]);
    const evaluate = createEvalQueue([]);

    await assert.rejects(
      () => layoutSwitch({ name: 'hit', _deps: { evaluateAsync, evaluate } }),
      /ambiguous/i,
    );
    assert.equal(evaluate.calls.length, 0, 'should not mutate UI when match is ambiguous');
  });

  it('layoutSwitch verifies the target layout and dismisses localized unsaved dialogs', async () => {
    const evaluateAsync = createAsyncQueue([
      {
        source: 'load_chart_service',
        current_slug: 'xz2DdnNx',
        current_href: 'https://de.tradingview.com/chart/xz2DdnNx/',
        layouts: [
          { id: 186002420, name: '8AM Breakout Algo', url: 'hRmRbL7i', symbol: 'US500', interval: '5' },
          { id: 186166925, name: 'Hit & Run Algo', url: 'xz2DdnNx', symbol: 'SOLUSD', interval: '1D' },
        ],
      },
      { success: true, method: 'loadChartFromServer', id: '186002420', source: 'internal_api' },
      {
        source: 'load_chart_service',
        current_slug: 'hRmRbL7i',
        current_href: 'https://de.tradingview.com/chart/hRmRbL7i/',
        layouts: [
          { id: 186002420, name: '8AM Breakout Algo', url: 'hRmRbL7i', symbol: 'US500', interval: '5' },
          { id: 186166925, name: 'Hit & Run Algo', url: 'xz2DdnNx', symbol: 'SOLUSD', interval: '1D' },
        ],
      },
    ]);
    const evaluate = createEvalQueue([
      { dismissed: true, label: 'Nicht speichern' },
    ]);

    const result = await layoutSwitch({ name: '8AM Breakout Algo', _deps: { evaluateAsync, evaluate } });
    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.equal(result.layout, '8AM Breakout Algo');
    assert.equal(result.layout_id, 186002420);
    assert.equal(result.layout_url, 'hRmRbL7i');
    assert.equal(result.current_slug, 'hRmRbL7i');
    assert.equal(result.unsaved_dialog_dismissed, true);
    assert.equal(result.active_layout?.name, '8AM Breakout Algo');
  });

  it('layoutSwitch returns already_active when target is current layout', async () => {
    const evaluateAsync = createAsyncQueue([{
      source: 'load_chart_service',
      current_slug: 'hRmRbL7i',
      current_href: 'https://de.tradingview.com/chart/hRmRbL7i/',
      layouts: [
        { id: 186002420, name: '8AM Breakout Algo', url: 'hRmRbL7i', symbol: 'US500', interval: '5' },
      ],
    }]);

    const result = await layoutSwitch({ name: '8AM Breakout Algo', _deps: { evaluateAsync, evaluate: async () => ({ dismissed: false }) } });
    assert.equal(result.success, true);
    assert.equal(result.action, 'already_active');
    assert.equal(result.verified, true);
    assert.equal(result.unsaved_dialog_dismissed, false);
  });
});
