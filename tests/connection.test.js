import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setCurrentTarget,
  getCurrentTargetId,
  getClient,
  disconnect,
  _test,
} from '../src/connection.js';

function fakeCdpClient({ id = 'tab-X' } = {}) {
  let closed = false;
  return {
    id,
    closed: () => closed,
    close: async () => { closed = true; },
    Runtime: {
      enable: async () => {},
      evaluate: async () => ({ result: { value: 1 } }),
    },
    Page: { enable: async () => {} },
    DOM: { enable: async () => {} },
    Input: { dispatchKeyEvent: async () => {} },
  };
}

function mockFetchFor(targets) {
  return async (url) => {
    if (url.endsWith('/json/list')) {
      return { ok: true, status: 200, json: async () => targets };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

beforeEach(() => {
  _test.reset();
});

afterEach(async () => {
  await disconnect();
  _test.reset();
});

describe('connection.setCurrentTarget — invalidates stale client', () => {
  it('drops the cached client when the pin points at a different target', () => {
    const stale = fakeCdpClient({ id: 'tab-A' });
    _test.setClient(stale);
    _test.setTargetInfo({ id: 'tab-A', type: 'page', url: 'https://www.tradingview.com/chart/X/' });

    setCurrentTarget('tab-B');

    assert.equal(getCurrentTargetId(), 'tab-B');
    assert.equal(_test.getClient(), null, 'client should be nulled');
    assert.equal(_test.getTargetInfo(), null, 'targetInfo should be nulled');
  });

  it('keeps the cached client when the pin matches the current target', () => {
    const same = fakeCdpClient({ id: 'tab-A' });
    _test.setClient(same);
    _test.setTargetInfo({ id: 'tab-A', type: 'page', url: 'https://www.tradingview.com/chart/X/' });

    setCurrentTarget('tab-A');

    assert.equal(getCurrentTargetId(), 'tab-A');
    assert.equal(_test.getClient(), same, 'client should remain cached');
  });

  it('accepts null to clear the pin without forcing disconnect', () => {
    const client = fakeCdpClient({ id: 'tab-A' });
    _test.setClient(client);
    _test.setTargetInfo({ id: 'tab-A', type: 'page', url: 'https://www.tradingview.com/chart/X/' });

    setCurrentTarget(null);

    assert.equal(getCurrentTargetId(), null);
    assert.equal(_test.getClient(), client, 'clearing pin should not invalidate the cached client');
  });
});

describe('connection.getClient — connectingPromise guard', () => {
  it('calls CDP factory exactly once under concurrent getClient() callers', async () => {
    const targets = [{ id: 'tab-A', type: 'page', url: 'https://www.tradingview.com/chart/X/' }];
    _test.setFetchFn(mockFetchFor(targets));

    let callCount = 0;
    _test.setCdpFactory(async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 20));
      return fakeCdpClient({ id: 'tab-A' });
    });

    const [a, b] = await Promise.all([getClient(), getClient()]);
    assert.equal(a, b, 'both callers should receive the same client');
    assert.equal(callCount, 1, 'CDP factory should be invoked exactly once');
  });
});

describe('connection.findChartTarget — respects the pin', () => {
  it('returns the pinned target when present in /json/list', async () => {
    const targets = [
      { id: 'tab-A', type: 'page', url: 'https://www.tradingview.com/chart/aaa/' },
      { id: 'tab-B', type: 'page', url: 'https://www.tradingview.com/chart/bbb/' },
      { id: 'tab-C', type: 'page', url: 'https://www.tradingview.com/chart/ccc/' },
    ];
    _test.setFetchFn(mockFetchFor(targets));
    _test.setCdpFactory(async () => fakeCdpClient({ id: 'tab-C' }));

    setCurrentTarget('tab-C');
    await getClient();

    const info = _test.getTargetInfo();
    assert.equal(info?.id, 'tab-C', 'should connect to the pinned target, not the first URL match');
  });

  it('clears the pin and falls back to URL heuristics when the pinned target is gone', async () => {
    const targets = [
      { id: 'tab-A', type: 'page', url: 'https://www.tradingview.com/chart/aaa/' },
      { id: 'tab-B', type: 'page', url: 'https://www.tradingview.com/chart/bbb/' },
    ];
    _test.setFetchFn(mockFetchFor(targets));
    _test.setCdpFactory(async () => fakeCdpClient({ id: 'tab-A' }));

    setCurrentTarget('tab-GONE');
    await getClient();

    assert.equal(getCurrentTargetId(), null, 'stale pin should be cleared');
    const info = _test.getTargetInfo();
    assert.equal(info?.id, 'tab-A', 'should fall back to first chart URL match');
  });
});
