/**
 * Tests for getClient() liveness probe, findChartTarget shell exclusion,
 * and explicitTargetId stickiness with reconnectTo.
 *
 * Pure unit: uses _resetForTest DI to inject mock CDP factory, fetch,
 * and retry settings so no real TradingView Desktop is needed.
 *
 * Run: node --test tests/connection.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getClient, connect, reconnectTo, disconnect,
  _resetForTest,
} from '../src/connection.js';

// ── Mock targets ─────────────────────────────────────────────────────

const CHART_TARGET = {
  id: 'ABC123', type: 'page',
  url: 'file:///Applications/TradingView.app/Contents/Resources/app/chart/index.html',
  title: 'BTCUSD',
};
const SECOND_CHART = {
  id: 'DEF456', type: 'page',
  url: 'https://www.tradingview.com/chart/XyZ999/',
  title: 'ETHUSD',
};
const SHELL_TARGET = {
  id: 'SHELL1', type: 'page',
  url: 'file:///Applications/TradingView.app/Contents/Resources/app/window/index.html',
  title: 'TradingView',
};
const NEW_TAB_TARGET = {
  id: 'NEWTAB1', type: 'page',
  url: 'file:///Applications/TradingView.app/Contents/Resources/app/new-tab/index.html',
  title: 'New tab',
};

let cdpTargets = [];
let probeValue = true;
let probeThrows = false;
let connectedTargets = [];
let fetchThrows = false;

function makeMockClient() {
  return {
    Runtime: {
      evaluate: async () => {
        if (probeThrows) throw new Error('target crashed');
        return { result: { value: probeValue } };
      },
      enable: async () => {},
    },
    Page: { enable: async () => {} },
    DOM: { enable: async () => {} },
    close: async () => {},
  };
}

const mockCdpFactory = async (opts) => {
  connectedTargets.push(opts.target);
  return makeMockClient();
};
const mockFetch = async () => {
  if (fetchThrows) throw new Error('fetch failed');
  return { json: async () => [...cdpTargets] };
};

function resetAll() {
  cdpTargets = [CHART_TARGET, SHELL_TARGET, NEW_TAB_TARGET];
  probeValue = true;
  probeThrows = false;
  fetchThrows = false;
  connectedTargets = [];
  _resetForTest({
    cdpFactory: mockCdpFactory,
    fetchFn: mockFetch,
    retries: 1,
    delay: 0,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('getClient() — chart-API liveness probe', () => {
  beforeEach(resetAll);

  it('returns cached client when probe passes', async () => {
    const first = await getClient();
    const second = await getClient();
    assert.strictEqual(first, second);
    assert.equal(connectedTargets.length, 1);
  });

  it('reconnects when probe returns false (non-chart page)', async () => {
    const first = await getClient();
    probeValue = false;
    const second = await getClient();
    assert.notStrictEqual(first, second);
    assert.equal(connectedTargets.length, 2);
  });

  it('reconnects when probe throws (target crashed)', async () => {
    const first = await getClient();
    probeThrows = true;
    const second = await getClient();
    assert.notStrictEqual(first, second);
    assert.equal(connectedTargets.length, 2);
  });
});

describe('getClient() — explicitTargetId stickiness', () => {
  beforeEach(resetAll);

  it('reconnectTo sets explicitTargetId; probe failure retries same target', async () => {
    cdpTargets = [CHART_TARGET, SECOND_CHART, SHELL_TARGET];
    await reconnectTo(SECOND_CHART.id);
    connectedTargets = [];
    probeValue = false;
    await getClient();
    assert.equal(connectedTargets.length, 1);
    assert.equal(connectedTargets[0], SECOND_CHART.id,
      'should reconnect to the explicit target, not fall back to findChartTarget');
  });

  it('falls back to findChartTarget when explicit target disappears', async () => {
    cdpTargets = [CHART_TARGET, SECOND_CHART, SHELL_TARGET];
    await reconnectTo(SECOND_CHART.id);
    connectedTargets = [];
    probeValue = false;
    cdpTargets = [CHART_TARGET, SHELL_TARGET];
    await getClient();
    assert.equal(connectedTargets.length, 1);
    assert.equal(connectedTargets[0], CHART_TARGET.id);
  });

  it('connect() without targetId clears explicitTargetId', async () => {
    cdpTargets = [CHART_TARGET, SECOND_CHART, SHELL_TARGET];
    await reconnectTo(SECOND_CHART.id);
    await connect();
    connectedTargets = [];
    probeValue = false;
    await getClient();
    assert.equal(connectedTargets.length, 1);
    assert.equal(connectedTargets[0], CHART_TARGET.id,
      'should use findChartTarget after bare connect(), not the previous explicit SECOND_CHART');
  });

  it('disconnect clears explicitTargetId', async () => {
    cdpTargets = [CHART_TARGET, SECOND_CHART, SHELL_TARGET];
    await reconnectTo(SECOND_CHART.id);
    await disconnect();
    connectedTargets = [];
    probeValue = false;
    await getClient();
    assert.equal(connectedTargets.length, 1);
    assert.equal(connectedTargets[0], CHART_TARGET.id,
      'should use findChartTarget after disconnect, not the previous explicit SECOND_CHART');
  });

  it('explicit target fetch error falls back to connect with retry', async () => {
    cdpTargets = [CHART_TARGET, SECOND_CHART, SHELL_TARGET];
    _resetForTest({ retries: 2, delay: 0, cdpFactory: mockCdpFactory, fetchFn: mockFetch });
    await reconnectTo(SECOND_CHART.id);
    probeValue = false;
    fetchThrows = true;
    connectedTargets = [];
    await assert.rejects(
      () => getClient(),
      { message: /CDP connection failed/ },
    );
  });

  it('explicit target fetch error recovers when network returns', async () => {
    cdpTargets = [CHART_TARGET, SECOND_CHART, SHELL_TARGET];
    let fetchCallCount = 0;
    _resetForTest({
      retries: 3,
      delay: 0,
      cdpFactory: mockCdpFactory,
      fetchFn: async () => {
        fetchCallCount++;
        if (fetchCallCount <= 1) throw new Error('fetch failed');
        return { json: async () => [...cdpTargets] };
      },
    });
    await reconnectTo(SECOND_CHART.id);
    probeValue = false;
    fetchCallCount = 0;
    connectedTargets = [];
    const c = await getClient();
    assert.ok(c);
    assert.equal(connectedTargets[0], CHART_TARGET.id,
      'should fall back to findChartTarget after explicit target fetch error');
  });
});

describe('findChartTarget — shell/helper exclusion', () => {
  beforeEach(resetAll);

  it('prefers chart URL over shell/helper pages', async () => {
    cdpTargets = [SHELL_TARGET, NEW_TAB_TARGET, CHART_TARGET];
    await connect();
    assert.equal(connectedTargets[0], CHART_TARGET.id);
  });

  it('excludes shell and new-tab from fallback matching', async () => {
    cdpTargets = [SHELL_TARGET, NEW_TAB_TARGET];
    await assert.rejects(
      () => connect(),
      { message: /No TradingView chart target found/ },
    );
  });

  it('matches desktop Electron chart URL with /chart/ path', async () => {
    cdpTargets = [{
      id: 'DESK1', type: 'page',
      url: 'file:///Applications/TradingView.app/Contents/Resources/app/chart/ABC123.html',
      title: 'Chart',
    }];
    await connect();
    assert.equal(connectedTargets[0], 'DESK1');
  });

  it('matches tradingview.com web chart URL', async () => {
    cdpTargets = [{
      id: 'WEB1', type: 'page',
      url: 'https://www.tradingview.com/chart/XyZ123/',
      title: 'BTCUSD Chart',
    }];
    await connect();
    assert.equal(connectedTargets[0], 'WEB1');
  });
});
