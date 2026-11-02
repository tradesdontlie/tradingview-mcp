import { it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { captureViewport, restoreViewport, restoreTimeViewport } from '../src/core/viewport.js';

function chartMock() {
  const state = { spacing: 10, offset: 3, width: 110, symbol: 'INDEX:BTCUSD', resolution: '1M', changes: 0 };
  const logical = () => ({ to: 10 + state.offset, from: 10 + state.offset - state.width / state.spacing + 1 });
  const scale = { barSpacing: () => state.spacing, rightOffset: () => state.offset, width: () => state.width,
    setBarSpacing: value => { state.changes++; state.spacing = value; },
    setRightOffset: value => { state.changes++; state.offset = value; } };
  const chart = {
    chartType: () => 1, getAllStudies: () => [], getAllShapes: () => [],
    symbolExt: () => ({ full_name: state.symbol }), resolution: () => state.resolution,
    getTimeScale: () => scale,
    getTimeScaleLogicalRange: () => ({ left: () => logical().from, right: () => logical().to }),
    getVisibleRange: () => ({ from: logical().from * 10, to: logical().to * 10 }),
    _convertIndexToPublicTime: index => index * 10,
    _chartWidget: { model: () => ({ mainSeries: () => ({ bars: () => ({ firstIndex: () => 0, lastIndex: () => 1, valueAt: () => [100] }) }), timeScale: () => ({
      timePointToIndex: time => time / 10,
      zoomToBarsRange: (from, to) => { state.changes++; state.spacing = state.width / (to - from + 1); state.offset = to - 10; },
    }) }) },
  };
  const _deps = { evaluate: expression => vm.runInNewContext(expression, { window: { TradingViewApi: { _activeChartWidgetWV: { value: () => chart } } } }), sleep: async () => {} };
  return { state, _deps };
}

it('restores exact future whitespace with scale spacing and right offset instead of last-bar clamping', async () => {
  const mock = chartMock();
  const snapshot = await captureViewport({ _deps: mock._deps });
  assert.equal(snapshot.visible_range.to, 130); // Last loaded bar is logical10 / time100.
  mock.state.spacing = 11;
  mock.state.offset = 0;
  const receipt = await restoreViewport({ snapshot, expected_current: await captureViewport({ _deps: mock._deps }), _deps: mock._deps });
  assert.equal(receipt.verified, true);
  assert.deepEqual(JSON.parse(JSON.stringify(receipt.viewport)), JSON.parse(JSON.stringify(snapshot)));
});

it('repairs an older timestamp-only snapshot via native future calendar-to-index mapping', async () => {
  const mock = chartMock();
  mock.state.offset = 0;
  const result = await restoreTimeViewport({ from: 30, to: 130, symbol: 'INDEX:BTCUSD', resolution: '1M', expected_current: await captureViewport({ _deps: mock._deps }), _deps: mock._deps });
  assert.equal(result.success, true);
  assert.equal(result.viewport.right_offset, 3);
  assert.equal(result.viewport.visible_range.to, 130);
});

it('refuses a different chart or resized viewport before performing a restoration', async () => {
  const mock = chartMock();
  const snapshot = await captureViewport({ _deps: mock._deps });
  mock.state.symbol = 'NASDAQ:AAPL';
  await assert.rejects(restoreViewport({ snapshot, expected_current: await captureViewport({ _deps: mock._deps }), _deps: mock._deps }), /identity differs/);
  assert.equal(mock.state.changes, 0);
  mock.state.symbol = snapshot.symbol;
  mock.state.width++;
  await assert.rejects(restoreViewport({ snapshot, expected_current: await captureViewport({ _deps: mock._deps }), _deps: mock._deps }), /width changed/);
  assert.equal(mock.state.changes, 0);
});

it('fences a manual zoom between preflight and the same page setter operation', async () => {
  const mock = chartMock();
  const snapshot = await captureViewport({ _deps: mock._deps });
  mock.state.offset = 0;
  const current = await captureViewport({ _deps: mock._deps });
  const ev = mock._deps.evaluate;
  mock._deps.evaluate = expression => {
    if (expression.includes('const observed =')) mock.state.offset = 1;
    return ev(expression);
  };
  await assert.rejects(restoreViewport({ snapshot, expected_current: current, _deps: mock._deps }), /Viewport changed/);
  assert.equal(mock.state.changes, 0);
});

it('repairs future points when the native inverse clamps one bar before the forward calendar projection', async () => {
  const mock = chartMock();
  const ev = mock._deps.evaluate;
  mock._deps.evaluate = expression => ev(expression.replace('native.timePointToIndex(internal)', 'Math.min(native.timePointToIndex(internal), 12)'));
  mock.state.offset = 0;
  const result = await restoreTimeViewport({ from: 30, to: 130, symbol: 'INDEX:BTCUSD', resolution: '1M', expected_current: await captureViewport({ _deps: mock._deps }), _deps: mock._deps });
  assert.equal(result.verified, true);
  assert.equal(result.viewport.visible_range.to, 130);
  assert.equal(mock.state.changes, 1);
});

it('does not dispatch a restoration after the overall deadline expires during preflight', async () => {
  const mock = chartMock();
  const snapshot = await captureViewport({ _deps: mock._deps });
  mock.state.offset = 0;
  const expected = await captureViewport({ _deps: mock._deps });
  const ev = mock._deps.evaluate;
  let now = 0;
  mock._deps.now = () => now;
  mock._deps.evaluate = expression => { const result = ev(expression); now = 150; return result; };
  await assert.rejects(restoreViewport({ snapshot, expected_current: expected, timeout_ms: 100, _deps: mock._deps }), /deadline|timed out/);
  assert.equal(mock.state.changes, 0);
});

it('refuses to restore a saved layout viewport into a different layout with the same instrument', async () => {
  const mock = chartMock();
  const current = await captureViewport({ _deps: mock._deps });
  const desired = { ...current, layout_id: 'old-layout', layout_name: 'Old layout' };
  await assert.rejects(restoreViewport({ snapshot: desired, expected_current: current, _deps: mock._deps }), /another layout/);
  assert.equal(mock.state.changes, 0);
});

it('waits for null post-replay logical layout to become ready without any mutation', async () => {
  const mock = chartMock();
  const ev = mock._deps.evaluate;
  let now = 0, reads = 0;
  mock._deps.now = () => now;
  mock._deps.sleep = async ms => { now += ms; };
  mock._deps.evaluate = expression => {
    reads++;
    if (reads < 3) return ev(expression.replace('const logical = chart.getTimeScaleLogicalRange();', 'const logical = null;'));
    return ev(expression);
  };
  const result = await captureViewport({ timeout_ms: 500, _deps: mock._deps });
  assert.equal(result.symbol, 'INDEX:BTCUSD');
  assert.equal(reads, 3);
  assert.equal(mock.state.changes, 0);
});

it('times out a continuously unavailable chart layout without a TypeError or viewport mutation', async () => {
  let now = 0, reads = 0;
  const _deps = { now: () => now, sleep: async ms => { now += ms; }, evaluate: async () => { reads++; return null; } };
  await assert.rejects(captureViewport({ timeout_ms: 100, _deps }), error => error.code === 'VIEWPORT_NOT_READY' && !/TypeError/.test(error.message));
  assert.equal(reads, 2);
});

it('does not perform a redundant restoration when the original viewport is already exact', async () => {
  const mock = chartMock();
  const snapshot = await captureViewport({ _deps: mock._deps });
  const result = await restoreViewport({ snapshot, expected_current: snapshot, _deps: mock._deps });
  assert.equal(result.verified, true);
  assert.equal(result.changed, false);
  assert.equal(mock.state.changes, 0);
});

it('captures cleanup chart state with the viewport in one readiness observation', async () => {
  const mock = chartMock();
  const snapshot = await captureViewport({ include_chart_state: true, _deps: mock._deps });
  assert.equal(snapshot.chart_state.symbol, snapshot.symbol);
  assert.equal(snapshot.chart_state.resolution, snapshot.resolution);
  assert.equal(snapshot.chart_state.visible_range.from, snapshot.visible_range.from);
  assert.equal(snapshot.chart_state.chartType, 1);
  assert.equal(mock.state.changes, 0);
});
