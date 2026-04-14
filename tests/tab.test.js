import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { list, switchTab, newTab, closeTab } from '../src/core/tab.js';

function makeTabListResponse(tabs) {
  const payload = tabs.map(t => ({
    id: t.id,
    type: 'page',
    url: `https://www.tradingview.com/chart/${t.chart_id || 'abc'}/`,
    title: `${t.title || 'Live stock'} on TradingView`,
  }));
  return { ok: true, status: 200, json: async () => payload };
}

function makeActivateResponse({ ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => (ok ? 'Target activated' : 'Not Found') };
}

function makeDeps({ listTabs, activateOk = true, activateStatus = 200, client } = {}) {
  const calls = { fetch: [], setCurrentTarget: [], getCurrentTargetId: [] };
  let currentTargetId = null;
  const fetch = async (url) => {
    calls.fetch.push(url);
    if (url.endsWith('/json/list')) return makeTabListResponse(listTabs || []);
    if (url.includes('/json/activate/')) return makeActivateResponse({ ok: activateOk, status: activateStatus });
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };
  const setCurrentTarget = (id) => { calls.setCurrentTarget.push(id); currentTargetId = id; };
  const getCurrentTargetId = () => { calls.getCurrentTargetId.push(null); return currentTargetId; };
  const getClient = async () => client || { Input: { dispatchKeyEvent: async () => {} } };
  return {
    calls,
    seedCurrentTargetId(id) { currentTargetId = id; },
    _deps: { fetch, setCurrentTarget, getCurrentTargetId, getClient },
  };
}

describe('tab.switchTab — pins the new target via setCurrentTarget', () => {
  it('calls setCurrentTarget(target.id) on successful activate', async () => {
    const d = makeDeps({
      listTabs: [{ id: 'tab-A', chart_id: 'abc' }, { id: 'tab-B', chart_id: 'def' }],
    });
    const result = await switchTab({ index: 1, _deps: d._deps });
    assert.equal(result.success, true);
    assert.equal(result.tab_id, 'tab-B');
    assert.deepEqual(d.calls.setCurrentTarget, ['tab-B']);
  });

  it('throws and does NOT pin when activate returns non-OK', async () => {
    const d = makeDeps({
      listTabs: [{ id: 'tab-A' }, { id: 'tab-B' }],
      activateOk: false,
      activateStatus: 404,
    });
    await assert.rejects(() => switchTab({ index: 1, _deps: d._deps }), /activate|404/i);
    assert.deepEqual(d.calls.setCurrentTarget, []);
  });

  it('throws on out-of-range index without calling setCurrentTarget', async () => {
    const d = makeDeps({ listTabs: [{ id: 'tab-A' }] });
    await assert.rejects(() => switchTab({ index: 5, _deps: d._deps }), /out of range/i);
    assert.deepEqual(d.calls.setCurrentTarget, []);
  });
});

describe('tab.closeTab — prunes pin when pinned tab disappears', () => {
  it('clears pin when the pinned tab is no longer in the list', async () => {
    const tabsBefore = [{ id: 'tab-A' }, { id: 'tab-B' }];
    const tabsAfter = [{ id: 'tab-B' }]; // tab-A closed
    let callIdx = 0;
    const d = makeDeps({ listTabs: tabsBefore });
    d.seedCurrentTargetId('tab-A');

    // Override fetch to return different tab lists on first vs second call
    d._deps.fetch = async (url) => {
      if (url.endsWith('/json/list')) {
        const tabs = callIdx++ === 0 ? tabsBefore : tabsAfter;
        return makeTabListResponse(tabs);
      }
      throw new Error(`unexpected ${url}`);
    };

    const result = await closeTab({ _deps: d._deps });
    assert.equal(result.success, true);
    assert.deepEqual(d.calls.setCurrentTarget, [null]);
  });

  it('leaves pin intact when a non-pinned tab is closed', async () => {
    const tabsBefore = [{ id: 'tab-A' }, { id: 'tab-B' }];
    const tabsAfter = [{ id: 'tab-A' }]; // tab-B closed, pin is A
    let callIdx = 0;
    const d = makeDeps({ listTabs: tabsBefore });
    d.seedCurrentTargetId('tab-A');

    d._deps.fetch = async (url) => {
      if (url.endsWith('/json/list')) {
        const tabs = callIdx++ === 0 ? tabsBefore : tabsAfter;
        return makeTabListResponse(tabs);
      }
      throw new Error(`unexpected ${url}`);
    };

    await closeTab({ _deps: d._deps });
    assert.deepEqual(d.calls.setCurrentTarget, []);
  });
});

describe('tab.newTab — pins the newly created tab', () => {
  it('pins the single new id when exactly one tab appears', async () => {
    const tabsBefore = [{ id: 'tab-A' }];
    const tabsAfter = [{ id: 'tab-A' }, { id: 'tab-NEW' }];
    let callIdx = 0;
    const d = makeDeps({ listTabs: tabsBefore });
    d._deps.fetch = async (url) => {
      if (url.endsWith('/json/list')) {
        const tabs = callIdx++ === 0 ? tabsBefore : tabsAfter;
        return makeTabListResponse(tabs);
      }
      throw new Error(`unexpected ${url}`);
    };

    const result = await newTab({ _deps: d._deps });
    assert.equal(result.success, true);
    assert.deepEqual(d.calls.setCurrentTarget, ['tab-NEW']);
  });

  it('clears pin to null when the diff is ambiguous (no new tab or multiple)', async () => {
    const tabsBefore = [{ id: 'tab-A' }];
    const tabsAfter = [{ id: 'tab-A' }]; // nothing opened
    let callIdx = 0;
    const d = makeDeps({ listTabs: tabsBefore });
    d._deps.fetch = async (url) => {
      if (url.endsWith('/json/list')) {
        const tabs = callIdx++ === 0 ? tabsBefore : tabsAfter;
        return makeTabListResponse(tabs);
      }
      throw new Error(`unexpected ${url}`);
    };

    await newTab({ _deps: d._deps });
    assert.deepEqual(d.calls.setCurrentTarget, [null]);
  });
});
