import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLayoutSnapshot, layoutIdentityMatches, layoutSwitch } from '../src/core/ui.js';
import { assertPostScreenshotSnapshot } from '../scripts/layout_canary.js';

function verifiedSnapshot(overrides = {}) {
  return {
    url: 'https://www.tradingview.com/chart/layout-id/',
    target_id: 'stable-target',
    url_layout_id: 'layout-id',
    layout_id: null,
    layout_name: 'Analysis - Stock Database',
    layout_uid: 'layout-id',
    meta_info_available: true,
    layout_type: '2h',
    chart_api_ready: true,
    pane_count: 2,
    panes: [
      { index: 0, symbol: 'NASDAQ:AAPL', resolution: '1D', surface_ready: true, x: 0, y: 0, width: 600, height: 800 },
      { index: 1, symbol: 'NASDAQ:AAPL', resolution: '1D', surface_ready: true, x: 600, y: 0, width: 600, height: 800 },
    ],
    pane_signature: '2h|1D,1D',
    geometry_signature: '0:0:600:800|600:0:600:800',
    pane_geometry_valid: true,
    symbols_valid: true,
    resolutions_valid: true,
    invalid_symbol: false,
    visible_modal: false,
    loading: false,
    blank_chart: false,
    ...overrides,
  };
}

function makeDeps({
  internal = { status: 'resolved', source: 'internal_api', id: 'layout-id', url_layout_id: 'layout-id', name: 'Analysis - Stock Database' },
  snapshots = [verifiedSnapshot()],
  menu = { clicked: false },
  action = { clicked: false },
  selected = { selected: false },
  selectError = null,
  internalLoadError = null,
  unsaved = { dismissed: true },
  targetIds = ['stable-target'],
} = {}) {
  let currentTime = 0;
  let snapshotIndex = 0;
  let reconnectCount = 0;
  let disconnectCount = 0;
  let targetIndex = 0;
  const calls = [];
  const reconnectCalls = [];

  function marker(expression) {
    return [
      '__TV_MCP_RESOLVE_LAYOUT__',
      '__TV_MCP_LOAD_LAYOUT__',
      '__TV_MCP_LAYOUT_SNAPSHOT__',
      '__TV_MCP_UNSAVED_DIALOG__',
      '__TV_MCP_NATIVE_OPEN_MENU__',
      '__TV_MCP_NATIVE_OPEN_ACTION__',
      '__TV_MCP_NATIVE_SELECT_LAYOUT__',
    ].find(value => expression.includes(value));
  }

  const evaluate = async (expression, options) => {
    const found = marker(expression);
    calls.push({ marker: found, options, expression });
    if (found === '__TV_MCP_LOAD_LAYOUT__') {
      if (internalLoadError) throw internalLoadError;
      return { initiated: true };
    }
    if (found === '__TV_MCP_LAYOUT_SNAPSHOT__') {
      const snapshot = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
      snapshotIndex++;
      return structuredClone(snapshot);
    }
    if (found === '__TV_MCP_UNSAVED_DIALOG__') return unsaved;
    if (found === '__TV_MCP_NATIVE_OPEN_MENU__') return menu;
    if (found === '__TV_MCP_NATIVE_OPEN_ACTION__') return action;
    if (found === '__TV_MCP_NATIVE_SELECT_LAYOUT__') {
      if (selectError) throw selectError;
      return selected;
    }
    throw new Error(`unexpected evaluate expression: ${found || expression.slice(0, 40)}`);
  };

  return {
    _deps: {
      evaluate,
      evaluateAsync: async (expression, options) => {
        calls.push({ marker: marker(expression), expression, options });
        return internal;
      },
      getTargetInfo: async options => {
        calls.push({ marker: 'targetInfo', options });
        return { id: targetIds[Math.min(targetIndex++, targetIds.length - 1)] };
      },
      reconnect: async (reason, options) => {
        reconnectCount++;
        reconnectCalls.push({ reason, options });
      },
      disconnect: async () => { disconnectCount++; },
      now: () => currentTime,
      sleep: async ms => { currentTime += Math.max(1, ms); },
    },
    calls,
    reconnectCalls,
    get reconnectCount() { return reconnectCount; },
    get disconnectCount() { return disconnectCount; },
  };
}

describe('verified layout switching', () => {
  it('keeps the numeric saved-chart id while verifying and reporting the URL short id', async () => {
    const fixture = makeDeps({
      internal: {
        status: 'resolved',
        source: 'internal_api',
        id: 987654321,
        url_layout_id: 'short-AbC12',
        name: 'Analysis - Stock Database',
      },
      snapshots: [verifiedSnapshot({
        url: 'https://www.tradingview.com/chart/short-AbC12/',
        url_layout_id: 'short-AbC12',
        layout_id: 987654321,
        layout_uid: 'short-AbC12',
      })],
    });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 1000,
      _deps: fixture._deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.layout_id, 987654321);
    assert.equal(result.url_layout_id, 'short-AbC12');
    assert.equal(result.observed.layout_id, 987654321);
    assert.equal(result.observed.layout_uid, 'short-AbC12');
    assert.equal(result.observed.url_layout_id, 'short-AbC12');
    const resolveExpression = fixture.calls.find(call => call.marker === '__TV_MCP_RESOLVE_LAYOUT__').expression;
    const loadExpression = fixture.calls.find(call => call.marker === '__TV_MCP_LOAD_LAYOUT__').expression;
    assert.match(resolveExpression, /url_layout_id: urlLayoutId\(chart\.url\)/);
    assert.match(loadExpression, /loadChartFromServer\("987654321"\)/);
    assert.doesNotMatch(loadExpression, /short-AbC12/);
    const snapshotExpression = fixture.calls.find(call => call.marker === '__TV_MCP_LAYOUT_SNAPSHOT__').expression;
    assert.match(snapshotExpression, /collection && collection\.metaInfo/);
    assert.match(snapshotExpression, /layoutId = unwrap\(metaInfo && metaInfo\.id\)/);
    assert.match(snapshotExpression, /layoutName = text\(unwrap\(metaInfo && metaInfo\.name\)\)/);
    assert.match(snapshotExpression, /layoutUid = text\(unwrap\(metaInfo && metaInfo\.uid\)\)/);
    assert.match(snapshotExpression, /element\.querySelectorAll\('\[data-name="pane-canvas"\], canvas'\)/);
    assert.match(snapshotExpression, /elementValue\(widget && widget\._mainDiv\)/);
    assert.match(snapshotExpression, /hasSafeFallback = fallbackPaneContainers\.length === all\.length/);
    assert.match(snapshotExpression, /surface_ready: paneSurfaceReady\(element\)/);
    assert.match(snapshotExpression, /blank_chart: panes\.some\(function\(pane\) \{ return !pane\.surface_ready; \}\)/);
    assert.doesNotMatch(snapshotExpression, /paneCanvases\.length < panes\.length/);
    assert.deepEqual(fixture.calls.find(call => call.marker === '__TV_MCP_RESOLVE_LAYOUT__').options, { retry: true, expectedTargetId: 'stable-target', timeoutMs: 1000 });
    assert.deepEqual(fixture.calls.find(call => call.marker === '__TV_MCP_LAYOUT_SNAPSHOT__').options, { retry: true, expectedTargetId: 'stable-target', timeoutMs: 1000 });
  });

  it('cannot verify a mutation initiated on target A using a stable snapshot from target B', async () => {
    const fixture = makeDeps({ targetIds: ['target-A', 'target-B'] });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 1000,
      _deps: fixture._deps,
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'target_replaced');
    assert.equal(result.observed.target_id, 'target-B');
    const mutation = fixture.calls.find(call => call.marker === '__TV_MCP_LOAD_LAYOUT__');
    assert.equal(mutation.options.expectedTargetId, 'target-A');
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LOAD_LAYOUT__').length, 1);
    assert.deepEqual(fixture.reconnectCalls[0], {
      reason: 'layout_navigation',
      options: { expectedTargetId: 'target-A', timeoutMs: 1000 },
    });
    assert.ok(
      fixture.calls.findIndex(call => call.marker === 'targetInfo')
        < fixture.calls.findIndex(call => call.marker === '__TV_MCP_LOAD_LAYOUT__'),
      'the target was captured before the mutation',
    );
  });

  it('accepts the observed numeric metaInfo id when the URL identity is stale', async () => {
    const fixture = makeDeps({
      internal: {
        status: 'resolved',
        source: 'internal_api',
        id: 987654321,
        url_layout_id: 'expected-short-id',
        name: 'Analysis - Stock Database',
      },
      snapshots: [verifiedSnapshot({
        url: 'https://www.tradingview.com/chart/stale-short-id/',
        url_layout_id: 'stale-short-id',
        layout_id: 987654321,
        layout_uid: 'stale-short-id',
      })],
    });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 1000,
      _deps: fixture._deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.observed.layout_id, 987654321);
  });

  it('uses the UID when expected numeric identity exists but observed numeric identity is unavailable', async () => {
    const fixture = makeDeps({
      internal: {
        status: 'resolved',
        source: 'internal_api',
        id: 987654321,
        url_layout_id: 'expected-short-id',
        name: 'Analysis - Stock Database',
      },
      snapshots: [verifiedSnapshot({
        url_layout_id: 'stale-url-id',
        layout_id: null,
        layout_uid: 'expected-short-id',
      })],
    });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 1000,
      _deps: fixture._deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.observed.layout_id, null);
    assert.equal(result.observed.layout_uid, 'expected-short-id');
  });

  it('fails closed on a numeric metaInfo mismatch even when UID and URL both match', async () => {
    const fixture = makeDeps({
      internal: {
        status: 'resolved',
        source: 'internal_api',
        id: 987654321,
        url_layout_id: 'expected-short-id',
        name: 'Analysis - Stock Database',
      },
      snapshots: [verifiedSnapshot({
        url: 'https://www.tradingview.com/chart/expected-short-id/',
        url_layout_id: 'expected-short-id',
        layout_id: 111111111,
        layout_uid: 'expected-short-id',
      })],
    });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 200,
      _deps: fixture._deps,
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'navigation_timeout');
    assert.equal(result.layout_id, 987654321);
    assert.equal(result.url_layout_id, 'expected-short-id');
    assert.equal(fixture.disconnectCount, 1);
  });

  it('fails when an initiated internal layout load never verifies', async () => {
    const fixture = makeDeps({
      snapshots: [verifiedSnapshot({
        url: 'https://www.tradingview.com/chart/old-layout/',
        url_layout_id: 'old-layout',
        layout_uid: 'old-layout',
        layout_name: 'Old Layout',
      })],
    });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 200,
      _deps: fixture._deps,
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'navigation_timeout');
    assert.equal(result.verified, false);
    assert.ok(fixture.calls.some(call => call.marker === '__TV_MCP_LOAD_LAYOUT__'));
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LOAD_LAYOUT__').length, 1);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_NATIVE_OPEN_MENU__').length, 1);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_NATIVE_OPEN_ACTION__').length, 0);
    assert.equal(fixture.reconnectCount, 1);
  });

  it('uses the internal fallback when the native Open action is unavailable before selection', async () => {
    const fixture = makeDeps({ menu: { clicked: true }, action: { clicked: false } });
    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 4000,
      _deps: fixture._deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.source, 'internal_api');
    assert.equal(result.fallback_used, true);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LOAD_LAYOUT__').length, 1);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_NATIVE_SELECT_LAYOUT__').length, 0);
  });

  it('uses the internal fallback when the native row is unavailable before selection', async () => {
    const fixture = makeDeps({ menu: { clicked: true }, action: { clicked: true }, selected: { selected: false } });
    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 4000,
      _deps: fixture._deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.source, 'internal_api');
    assert.equal(result.fallback_used, true);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LOAD_LAYOUT__').length, 1);
    assert.ok(fixture.calls.some(call => call.marker === '__TV_MCP_NATIVE_SELECT_LAYOUT__'));
  });

  it('uses the native Open layout route first when the internal API is unavailable', async () => {
    const fixture = makeDeps({
      internal: { status: 'unavailable', source: 'internal_api' },
      menu: { clicked: true },
      action: { clicked: true },
      selected: { selected: true, id: '24681012', url_layout_id: 'native-short-id', name: 'Analysis - Stock Database' },
      snapshots: [verifiedSnapshot({
        url: 'https://www.tradingview.com/chart/native-short-id/',
        url_layout_id: 'native-short-id',
        layout_id: 24681012,
        layout_uid: 'native-short-id',
      })],
    });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 1000,
      _deps: fixture._deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.equal(result.source, 'native_ui');
    assert.equal(result.method, 'open_layout_ui');
    assert.equal(result.fallback_used, false);
    assert.equal(result.layout_id, '24681012');
    assert.equal(result.url_layout_id, 'native-short-id');
    assert.equal(fixture.reconnectCount, 1);
    assert.ok(fixture.calls.some(call => call.marker === '__TV_MCP_NATIVE_OPEN_MENU__'));
    assert.ok(fixture.calls.some(call => call.marker === '__TV_MCP_NATIVE_OPEN_ACTION__'));
    assert.ok(fixture.calls.some(call => call.marker === '__TV_MCP_NATIVE_SELECT_LAYOUT__'));
    const actionExpression = fixture.calls.find(call => call.marker === '__TV_MCP_NATIVE_OPEN_ACTION__').expression;
    assert.match(actionExpression, /a, \[role="row"\]/);
    assert.match(actionExpression, /\[role="gridcell"\]/);
    assert.match(actionExpression, /label\.indexOf\('open layout\.\.\.'\) === 0/);
    const selectExpression = fixture.calls.find(call => call.marker === '__TV_MCP_NATIVE_SELECT_LAYOUT__').expression;
    assert.match(selectExpression, /\[role="dialog"\]\[data-name="load-layout-dialog"\]/);
    assert.match(selectExpression, /\[role="searchbox"\]\[placeholder="Search"\]/);
    assert.match(selectExpression, /querySelectorAll\('\[data-name="list-item-title"\]'\)/);
    assert.match(selectExpression, /text\(nodes\[i\]\)\.toLowerCase\(\) === target\.toLowerCase\(\)/);
    assert.match(selectExpression, /visible\(nodes\[i\]\)/);
    assert.match(selectExpression, /closest\('\[data-name="load-chart-dialog-item"\]\[data-role="list-item"\]/);
    assert.match(selectExpression, /var href = item\.getAttribute\('href'\)/);
    assert.match(selectExpression, /new URL\(href, currentUrl\.href\)/);
    assert.ok(selectExpression.includes(String.raw`currentUrl.protocol === 'https:' && /(^|\.)tradingview\.com$/i.test(currentUrl.hostname)`));
    assert.match(selectExpression, /\|\| !safeUrl/);
    assert.match(selectExpression, /safeUrl\.protocol !== 'https:'/);
    assert.match(selectExpression, /safeUrl\.origin !== currentUrl\.origin/);
    assert.ok(selectExpression.includes(String.raw`safeUrl.pathname.match(/^\/chart\/([A-Za-z0-9_-]+)\/$/)`));
    assert.match(selectExpression, /safeUrl\.search/);
    assert.match(selectExpression, /safeUrl\.hash/);
    assert.match(selectExpression, /return \{ selected: false, unsafe_href: true \}/);
    assert.match(selectExpression, /var urlLayoutId = pathMatch\[1\]/);
    assert.match(selectExpression, /window\.location\.assign\(safeUrl\.href\)/);
    assert.doesNotMatch(selectExpression, /item\.click\(\)/);
    assert.equal((selectExpression.match(/window\.location\.assign\(/g) || []).length, 1);
    const navigationPrimitives = selectExpression.match(/window\.location\.(?:assign|replace)\(|window\.location\.href\s*=|window\.open\(|item\.click\(/g) || [];
    assert.equal(navigationPrimitives.length, 1);
    assert.match(selectExpression, /url_layout_id: urlLayoutId/);
    assert.match(selectExpression, /id: id \|\| null/);
    assert.match(selectExpression, /name: text\(title\)/);
    assert.deepEqual(fixture.calls.find(call => call.marker === '__TV_MCP_NATIVE_SELECT_LAYOUT__').options, { retry: false, expectedTargetId: 'stable-target', timeoutMs: 1000 });
  });

  it('fails closed when the exact native row has an unsafe or off-origin href', async () => {
    const fixture = makeDeps({
      internal: { status: 'unavailable', source: 'internal_api' },
      menu: { clicked: true },
      action: { clicked: true },
      selected: { selected: false, unsafe_href: true },
    });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 1000,
      _deps: fixture._deps,
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'chart_api_not_ready');
    assert.match(result.error, /unsafe or off-origin href/);
    assert.equal(result.source, 'native_ui');
    assert.equal(result.fallback_used, false);
    assert.equal(fixture.reconnectCount, 0);
    assert.ok(!fixture.calls.some(call => call.marker === '__TV_MCP_LAYOUT_SNAPSHOT__'));
  });

  it('verifies a native selection outcome_unknown after reconnect without replaying any mutation', async () => {
    const selectError = Object.assign(new Error('target navigated during native selection'), {
      reason: 'navigation_invalidated',
      outcome_unknown: true,
    });
    const fixture = makeDeps({
      internal: { status: 'resolved', source: 'internal_api', id: 24681012, url_layout_id: 'native-short-id', name: 'Analysis - Stock Database' },
      menu: { clicked: true },
      action: { clicked: true },
      selectError,
      snapshots: [verifiedSnapshot({
        layout_id: 24681012,
        layout_uid: 'native-short-id',
        url_layout_id: 'native-short-id',
      })],
    });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 1000,
      _deps: fixture._deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.equal(result.outcome_unknown_recovered, true);
    assert.equal(result.layout_id, 24681012);
    assert.equal(fixture.reconnectCount, 1);
    for (const marker of [
      '__TV_MCP_NATIVE_OPEN_MENU__',
      '__TV_MCP_NATIVE_OPEN_ACTION__',
      '__TV_MCP_NATIVE_SELECT_LAYOUT__',
    ]) {
      assert.equal(fixture.calls.filter(call => call.marker === marker).length, 1, `${marker} was not replayed`);
    }
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LAYOUT_SNAPSHOT__').length, 2);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LOAD_LAYOUT__').length, 0);
  });

  it('fails closed after an unverifiable native selection outcome_unknown without replaying selection', async () => {
    const selectError = Object.assign(new Error('target navigated during native selection'), {
      reason: 'navigation_invalidated',
      outcome_unknown: true,
    });
    const fixture = makeDeps({
      internal: { status: 'resolved', source: 'internal_api', id: 24681012, url_layout_id: 'native-short-id', name: 'Analysis - Stock Database' },
      menu: { clicked: true },
      action: { clicked: true },
      selectError,
      snapshots: [verifiedSnapshot({
        url_layout_id: 'different-layout',
        layout_id: 11223344,
        layout_uid: 'different-layout',
        layout_name: 'Different Layout',
      })],
    });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 700,
      _deps: fixture._deps,
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'navigation_timeout');
    assert.equal(result.outcome_unknown, true);
    assert.equal(fixture.reconnectCount, 1);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_NATIVE_SELECT_LAYOUT__').length, 1);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_NATIVE_OPEN_MENU__').length, 1);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_NATIVE_OPEN_ACTION__').length, 1);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LOAD_LAYOUT__').length, 0);
  });

  it('verifies an internal outcome_unknown using the remaining deadline without native replay', async () => {
    const internalLoadError = Object.assign(new Error('target navigated during internal layout load'), {
      reason: 'navigation_invalidated',
      outcome_unknown: true,
    });
    const fixture = makeDeps({ internalLoadError });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 1000,
      _deps: fixture._deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.source, 'internal_api');
    assert.equal(result.method, 'loadChartFromServer');
    assert.equal(result.outcome_unknown_recovered, true);
    assert.equal(result.fallback_used, true);
    assert.equal(fixture.reconnectCount, 1);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LOAD_LAYOUT__').length, 1);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_NATIVE_OPEN_MENU__').length, 1);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_NATIVE_OPEN_ACTION__').length, 0);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_NATIVE_SELECT_LAYOUT__').length, 0);
  });

  it('fails closed after an unverifiable internal outcome_unknown without native replay', async () => {
    const internalLoadError = Object.assign(new Error('target navigated during internal layout load'), {
      reason: 'navigation_invalidated',
      outcome_unknown: true,
    });
    const fixture = makeDeps({
      internalLoadError,
      snapshots: [verifiedSnapshot({
        url: 'https://www.tradingview.com/chart/different-layout/',
        url_layout_id: 'different-layout',
        layout_name: 'Different Layout',
        layout_uid: 'different-layout',
      })],
    });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 700,
      _deps: fixture._deps,
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'navigation_timeout');
    assert.equal(result.outcome_unknown, true);
    assert.equal(result.source, 'internal_api');
    assert.equal(result.fallback_used, true);
    assert.equal(fixture.reconnectCount, 1);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LOAD_LAYOUT__').length, 1);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LAYOUT_SNAPSHOT__').length, 3, 'verification used the full remaining deadline');
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_NATIVE_OPEN_MENU__').length, 1);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_NATIVE_OPEN_ACTION__').length, 0);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_NATIVE_SELECT_LAYOUT__').length, 0);
  });

  it('retains the internal numeric id after a verified native fallback row without one', async () => {
    const oldSnapshot = verifiedSnapshot({
      url: 'https://www.tradingview.com/chart/old-short-id/',
      url_layout_id: 'old-short-id',
      layout_id: 11223344,
      layout_uid: 'old-short-id',
      layout_name: 'Old Layout',
    });
    const switchedSnapshot = verifiedSnapshot({
      url: 'https://www.tradingview.com/chart/native-short-id/',
      url_layout_id: 'native-short-id',
      layout_id: 91305550,
      layout_uid: 'native-short-id',
    });
    const fixture = makeDeps({
      internal: {
        status: 'resolved',
        source: 'internal_api',
        id: 91305550,
        url_layout_id: 'native-short-id',
        name: 'Analysis - Stock Database',
      },
      menu: { clicked: true },
      action: { clicked: true },
      selected: { selected: true, id: 'native-short-id', url_layout_id: 'native-short-id', name: 'Analysis - Stock Database' },
      snapshots: [oldSnapshot, oldSnapshot, oldSnapshot, oldSnapshot, oldSnapshot, switchedSnapshot, switchedSnapshot],
    });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 3000,
      _deps: fixture._deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.source, 'native_ui');
    assert.equal(result.fallback_used, false);
    assert.equal(result.layout_id, 91305550);
    assert.equal(result.url_layout_id, 'native-short-id');
    assert.equal(result.observed.layout_id, 91305550);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LOAD_LAYOUT__').length, 0);
  });

  it('does not treat ordinary dialog-named buttons as modal containers and waits for a real modal to close', async () => {
    const fixture = makeDeps({
      snapshots: [
        verifiedSnapshot({ visible_modal: true }),
        verifiedSnapshot(),
        verifiedSnapshot(),
      ],
      unsaved: { dismissed: false },
    });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 4000,
      _deps: fixture._deps,
    });

    assert.equal(result.success, true);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LAYOUT_SNAPSHOT__').length, 3);
    for (const marker of ['__TV_MCP_LAYOUT_SNAPSHOT__', '__TV_MCP_UNSAVED_DIALOG__']) {
      const expression = fixture.calls.find(call => call.marker === marker).expression;
      assert.match(expression, /dialogContainer\(dialogs\[/);
      assert.match(expression, /element\.matches\('button, \[role="button"\], a, input, select, textarea'\)/);
      assert.match(expression, /style\.display === 'none'/);
      assert.match(expression, /style\.visibility === 'hidden'/);
      assert.match(expression, /opacity <= 0/);
    }
  });

  it('fails closed on the wrong optional pane signature', async () => {
    const fixture = makeDeps();

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      expected_pane_signature: '4|1D,1D,1D,1D',
      timeout_ms: 500,
      _deps: fixture._deps,
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'navigation_timeout');
    assert.equal(fixture.disconnectCount, 1);
    assert.equal(result.fallback_used, true);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_NATIVE_OPEN_MENU__').length, 1);
  });

  it('fails closed on the wrong optional symbol', async () => {
    const fixture = makeDeps();

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      expected_symbol: 'MSFT',
      timeout_ms: 500,
      _deps: fixture._deps,
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'navigation_timeout');
  });

  it('returns layout_not_found when neither route resolves the requested layout', async () => {
    const fixture = makeDeps({
      internal: { status: 'not_found', source: 'internal_api' },
      menu: { clicked: true },
      action: { clicked: true },
      selected: { selected: false },
    });

    const result = await layoutSwitch({
      name: 'Does Not Exist',
      timeout_ms: 4000,
      _deps: fixture._deps,
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'layout_not_found');
  });

  it('requires consecutive stable postcondition polls before internal success', async () => {
    const unstable = verifiedSnapshot({ geometry_signature: '0:0:500:800|500:0:700:800' });
    const stable = verifiedSnapshot();
    const fixture = makeDeps({ snapshots: [unstable, stable, stable] });

    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 1500,
      _deps: fixture._deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.equal(result.source, 'internal_api');
    assert.equal(result.stable_polls, 2);
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LAYOUT_SNAPSHOT__').length, 3);
  });

  it('fences a hanging operation at the hard overall deadline', async () => {
    let disconnectCount = 0;
    const result = await layoutSwitch({
      name: 'Analysis - Stock Database',
      timeout_ms: 50,
      _deps: {
        getTargetInfo: async () => ({ id: 'target-A' }),
        evaluateAsync: async () => new Promise(() => {}),
        disconnect: async () => { disconnectCount++; },
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'navigation_timeout');
    assert.equal(disconnectCount, 1);
  });

  it('returns a bounded read-only authoritative snapshot', async () => {
    const fixture = makeDeps();
    const snapshot = await getLayoutSnapshot({ timeout_ms: 750, _deps: fixture._deps });

    assert.equal(snapshot.layout_name, 'Analysis - Stock Database');
    assert.equal(snapshot.target_id, 'stable-target');
    assert.equal(fixture.calls.filter(call => call.marker === '__TV_MCP_LAYOUT_SNAPSHOT__').length, 1);
    assert.deepEqual(fixture.calls.find(call => call.marker === '__TV_MCP_LAYOUT_SNAPSHOT__').options, {
      retry: true,
      timeoutMs: 750,
    });
    assert.ok(!fixture.calls.some(call => call.marker === '__TV_MCP_LOAD_LAYOUT__'));
    assert.ok(!fixture.calls.some(call => call.marker === '__TV_MCP_NATIVE_SELECT_LAYOUT__'));
  });

  it('associates render surfaces with their own pane instead of using a global canvas count', async () => {
    function element({ tag = 'div', dataName = '', rect = { x: 0, y: 0, width: 600, height: 800 }, children = [] } = {}) {
      const node = {
        nodeType: 1,
        tagName: tag.toUpperCase(),
        parentElement: null,
        children,
        getBoundingClientRect: () => rect,
        getAttribute: name => name === 'data-name' ? dataName : null,
        matches(selector) {
          return selector.split(',').some(part => {
            const value = part.trim();
            return (value === 'canvas' && tag === 'canvas')
              || (value === '[data-name="pane-canvas"]' && dataName === 'pane-canvas')
              || (value === '[data-name="chart-container"]' && dataName === 'chart-container');
          });
        },
        querySelectorAll(selector) {
          const found = [];
          function visit(child) {
            if (child.matches(selector)) found.push(child);
            child.children.forEach(visit);
          }
          children.forEach(visit);
          return found;
        },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      };
      children.forEach(child => { child.parentElement = node; });
      return node;
    }

    const firstPane = element({ children: [element({ tag: 'canvas' }), element({ tag: 'canvas' })] });
    const blankPane = element({ rect: { x: 600, y: 0, width: 600, height: 800 } });
    const unrelatedCanvas = element({ tag: 'canvas' });
    const series = { symbol: () => 'NASDAQ:AAPL', interval: () => '1D' };
    const widgets = [firstPane, blankPane].map(_mainDiv => ({
      _mainDiv,
      model: () => ({ mainSeries: () => series }),
    }));
    const collection = {
      getAll: () => widgets,
      _layoutType: '2h',
      metaInfo: { uid: 'layout-id', name: 'Analysis - Stock Database' },
    };
    const window = {
      TradingViewApi: {
        _chartWidgetCollection: collection,
        _activeChartWidgetWV: { value: () => ({ symbol() {}, resolution() {} }) },
      },
      location: { href: 'https://www.tradingview.com/chart/layout-id/' },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    };
    const document = {
      querySelector: () => null,
      querySelectorAll(selector) {
        if (selector === '[data-name="chart-container"]') return [];
        if (selector === '[data-name="pane-canvas"], canvas') return [
          ...firstPane.children,
          unrelatedCanvas,
        ];
        return [];
      },
    };

    const fixture = makeDeps();
    await getLayoutSnapshot({ timeout_ms: 750, _deps: fixture._deps });
    const expression = fixture.calls.find(call => call.marker === '__TV_MCP_LAYOUT_SNAPSHOT__').expression;
    const snapshot = Function('window', 'document', `return (${expression});`)(window, document);

    assert.deepEqual(snapshot.panes.map(pane => pane.surface_ready), [true, false]);
    assert.equal(snapshot.blank_chart, true);
  });
});

describe('layout identity matching', () => {
  it('allows an exact name only when the expected layout has no authoritative identifier', () => {
    assert.equal(layoutIdentityMatches(
      { name: 'Analysis - Stock Database' },
      { layout_name: 'Analysis - Stock Database' },
    ), true);
  });

  it('fails closed when an expected numeric identifier disappears even if the name matches', () => {
    assert.equal(layoutIdentityMatches(
      { id: 987654321, name: 'Analysis - Stock Database' },
      { layout_id: null, layout_uid: null, url_layout_id: null, layout_name: 'Analysis - Stock Database' },
    ), false);
  });

  it('fails closed when an expected URL identifier disappears even if the name matches', () => {
    assert.equal(layoutIdentityMatches(
      { url_layout_id: 'short-AbC12', name: 'Analysis - Stock Database' },
      { layout_id: null, layout_uid: null, url_layout_id: null, layout_name: 'Analysis - Stock Database' },
    ), false);
  });

  it('treats observed numeric IDs as authoritative when both numeric IDs exist', () => {
    assert.equal(layoutIdentityMatches(
      { id: 987654321, url_layout_id: 'short-AbC12', name: 'Analysis - Stock Database' },
      { layout_id: 111111111, layout_uid: 'short-AbC12', url_layout_id: 'short-AbC12', layout_name: 'Analysis - Stock Database' },
    ), false);
  });
});

describe('post-screenshot layout canary verification', () => {
  function switched(snapshot = verifiedSnapshot()) {
    return {
      layout: 'Analysis - Stock Database',
      layout_id: snapshot.layout_id,
      url_layout_id: snapshot.url_layout_id,
      observed: snapshot,
    };
  }

  it('fails when a non-active pane changes', () => {
    const baseline = verifiedSnapshot();
    const changed = structuredClone(baseline);
    changed.panes[1].symbol = 'NASDAQ:MSFT';
    assert.throws(
      () => assertPostScreenshotSnapshot('database', switched(baseline), changed),
      /pane symbols or resolutions changed/,
    );
  });

  it('fails when the layout identity changes', () => {
    const baseline = verifiedSnapshot();
    const changed = verifiedSnapshot({
      url_layout_id: 'other-layout',
      layout_uid: 'other-layout',
      layout_name: 'Other Layout',
    });
    assert.throws(
      () => assertPostScreenshotSnapshot('database', switched(baseline), changed),
      /layout identity changed/,
    );
  });

  it('fails when pane geometry changes', () => {
    const baseline = verifiedSnapshot();
    const changed = verifiedSnapshot({ geometry_signature: '0:0:500:800|500:0:700:800' });
    assert.throws(
      () => assertPostScreenshotSnapshot('database', switched(baseline), changed),
      /pane geometry changed/,
    );
  });

  it('fails when one pane is blank after the screenshot', () => {
    const baseline = verifiedSnapshot();
    const changed = structuredClone(baseline);
    changed.panes[1].surface_ready = false;
    changed.blank_chart = true;
    assert.throws(
      () => assertPostScreenshotSnapshot('database', switched(baseline), changed),
      /snapshot was not stable/,
    );
  });

  it('fails when the fresh post-screenshot snapshot comes from another target', () => {
    const baseline = verifiedSnapshot({ target_id: 'target-A' });
    const changed = verifiedSnapshot({ target_id: 'target-B' });
    assert.throws(
      () => assertPostScreenshotSnapshot('database', switched(baseline), changed),
      /chart target changed/,
    );
  });
});
