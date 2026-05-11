import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCdpEndpoint,
  getCdpHttpBase,
  getChartIdFromUrl,
  getTargetSelector,
  hasTargetSelector,
  selectChartTarget,
  targetMatchesSelector,
} from '../src/connection.js';

const targets = [
  { type: 'page', id: 'toast', title: 'index.html', url: 'file:///toast/index.html' },
  { type: 'page', id: 'chart-a-target', title: 'TradingView', url: 'https://www.tradingview.com/chart/AAA111/' },
  { type: 'page', id: 'docs', title: 'TradingView docs', url: 'https://www.tradingview.com/pine-script-docs/' },
  { type: 'page', id: 'chart-b-target', title: 'TradingView', url: 'https://www.tradingview.com/chart/BBB222/?symbol=CME_MINI%3ANQ1%21' },
  { type: 'worker', id: 'worker', title: '', url: '' },
];

function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('connection target selection', () => {
  it('extracts TradingView chart ids from chart URLs', () => {
    assert.equal(getChartIdFromUrl('https://www.tradingview.com/chart/AAA111/'), 'AAA111');
    assert.equal(getChartIdFromUrl('https://www.tradingview.com/chart/BBB222/?symbol=AAPL'), 'BBB222');
    assert.equal(getChartIdFromUrl('https://www.tradingview.com/pine-script-docs/'), null);
  });

  it('defaults to first chart page target', () => {
    assert.equal(selectChartTarget(targets)?.id, 'chart-a-target');
  });

  it('selects exact CDP target id when provided', () => {
    assert.equal(selectChartTarget(targets, { targetId: 'chart-b-target' })?.id, 'chart-b-target');
  });

  it('selects chart page by TradingView chart id', () => {
    assert.equal(selectChartTarget(targets, { chartId: 'BBB222' })?.id, 'chart-b-target');
  });

  it('selects page by URL substring for advanced cases', () => {
    assert.equal(selectChartTarget(targets, { urlMatch: 'pine-script-docs' })?.id, 'docs');
  });

  it('returns null when requested target is missing', () => {
    assert.equal(selectChartTarget(targets, { chartId: 'NOPE' }), null);
  });

  it('checks whether a target satisfies configured selectors', () => {
    const target = targets[1];
    assert.equal(targetMatchesSelector(target, { targetId: 'chart-a-target' }), true);
    assert.equal(targetMatchesSelector(target, { chartId: 'AAA111' }), true);
    assert.equal(targetMatchesSelector(target, { urlMatch: 'chart/AAA111' }), true);
    assert.equal(targetMatchesSelector(target, { chartId: 'BBB222' }), false);
  });

  it('detects whether any explicit target selector is configured', () => {
    assert.equal(hasTargetSelector({}), false);
    assert.equal(hasTargetSelector({ targetId: '', chartId: '', urlMatch: '' }), false);
    assert.equal(hasTargetSelector({ chartId: 'AAA111' }), true);
  });
});

describe('connection env config', () => {
  it('uses TV_CDP_HOST and TV_CDP_PORT', () => withEnv({
    TV_CDP_HOST: '127.0.0.1',
    TV_CDP_PORT: '9333',
    CDP_HOST: undefined,
    CDP_PORT: undefined,
  }, () => {
    assert.deepEqual(getCdpEndpoint(), { host: '127.0.0.1', port: 9333 });
  }));

  it('builds CDP HTTP URLs for IPv4, hostnames, and IPv6 literals', () => {
    assert.equal(getCdpHttpBase({ host: 'localhost', port: 9222 }), 'http://localhost:9222');
    assert.equal(getCdpHttpBase({ host: '127.0.0.1', port: 9222 }), 'http://127.0.0.1:9222');
    assert.equal(getCdpHttpBase({ host: '::1', port: 9222 }), 'http://[::1]:9222');
    assert.equal(getCdpHttpBase({ host: '[::1]', port: 9222 }), 'http://[::1]:9222');
  });

  it('rejects invalid CDP ports', () => withEnv({ TV_CDP_PORT: 'not-a-port' }, () => {
    assert.throws(() => getCdpEndpoint(), /TV_CDP_PORT must be a valid TCP port/);
  }));

  it('reads target selector from env', () => withEnv({
    TV_TARGET_ID: 'target-1',
    TV_CHART_ID: 'chart-1',
    TV_TARGET_URL_MATCH: 'chart/AAA',
  }, () => {
    assert.deepEqual(getTargetSelector(), {
      targetId: 'target-1',
      chartId: 'chart-1',
      urlMatch: 'chart/AAA',
    });
  }));
});
