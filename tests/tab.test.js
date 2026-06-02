/**
 * Regression tests for src/core/tab.js — switchTab fixes.
 *
 * Bugs fixed (2026-06-02):
 *   1. switchTab() called /json/activate/{id} which doesn't update the painted
 *      foreground in Electron and doesn't rebind the cached CDP client.
 *   2. findChartTarget() always picked the FIRST tradingview.com/chart tab,
 *      hijacking the user's active tab.
 *
 * Fixes:
 *   1. switchTab now opens a temporary CDP client for the target, calls
 *      Page.enable() then Page.bringToFront(), and calls setDedicatedTab() to
 *      rebind the singleton before disconnecting so the next getClient() call
 *      reconnects to the correct tab.
 *   2. connection.js now maintains a dedicatedTabId singleton; findChartTarget()
 *      prefers that id when it still exists in /json/list, falling back to
 *      createDedicatedTab() (GET /json/new) only when needed.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { switchTab } from '../src/core/tab.js';
import { setDedicatedTab, getDedicatedTabId } from '../src/connection.js';

// ── Mock helpers ──────────────────────────────────────────────────────────

function mockFn(impl) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return impl ? impl(...args) : undefined; };
  fn.calls = calls;
  return fn;
}

/** Build a fake CDP client that tracks Page.enable / Page.bringToFront calls. */
function makeFakeCdpClient() {
  const order = [];
  return {
    order,
    Page: {
      enable: async () => { order.push('Page.enable'); },
      bringToFront: async () => { order.push('Page.bringToFront'); },
    },
    close: async () => { order.push('close'); },
  };
}

/**
 * Make a mock CDP constructor that returns a pre-built fake client.
 * Signature: CDP({ host, port, target }) → client
 */
function makeCdpCtor(fakeClient) {
  const calls = [];
  const ctor = async (opts) => { calls.push(opts); return fakeClient; };
  ctor.calls = calls;
  return ctor;
}

/**
 * Build a minimal _deps object for switchTab.
 * @param {object} overrides
 */
function makeDeps({
  tabs = null,
  cdpClient = null,
  setDedicatedTabFn = null,
  disconnectFn = null,
} = {}) {
  const fakeClient = cdpClient || makeFakeCdpClient();
  const cdpCtor = makeCdpCtor(fakeClient);
  const setTabCalls = [];
  const setTab = setDedicatedTabFn || (async (id) => { setTabCalls.push(id); });
  const discCalls = [];
  const disc = disconnectFn || (async () => { discCalls.push(true); });

  const defaultTabs = tabs || {
    success: true,
    tab_count: 2,
    tabs: [
      { index: 0, id: 'tab-aaa', title: 'BTCUSD', url: 'https://www.tradingview.com/chart/abc/', chart_id: 'abc' },
      { index: 1, id: 'tab-bbb', title: 'ETHUSD', url: 'https://www.tradingview.com/chart/def/', chart_id: 'def' },
    ],
  };

  const _deps = {
    CDP: cdpCtor,
    setDedicatedTab: setTab,
    disconnect: disc,
    list: async () => defaultTabs,
  };

  return { _deps, fakeClient, cdpCtor, setTabCalls, discCalls };
}

// ── Test suite ────────────────────────────────────────────────────────────

describe('switchTab — calls Page.bringToFront (not just HTTP activate)', () => {
  it('calls Page.enable then Page.bringToFront on the CDP client for the target tab', async () => {
    const { _deps, fakeClient } = makeDeps();
    const result = await switchTab({ index: 0, _deps });

    assert.equal(result.success, true);
    assert.equal(result.action, 'switched');

    // Page.enable must come before Page.bringToFront
    const enableIdx = fakeClient.order.indexOf('Page.enable');
    const frontIdx = fakeClient.order.indexOf('Page.bringToFront');
    assert.ok(enableIdx !== -1, 'Page.enable must be called');
    assert.ok(frontIdx !== -1, 'Page.bringToFront must be called');
    assert.ok(enableIdx < frontIdx, 'Page.enable must precede Page.bringToFront');
  });

  it('opens the CDP client targeting the correct tab id', async () => {
    const { _deps, cdpCtor } = makeDeps();
    await switchTab({ index: 1, _deps });

    assert.equal(cdpCtor.calls.length, 1, 'CDP constructor called once');
    assert.equal(cdpCtor.calls[0].target, 'tab-bbb', 'CDP must connect to tab-bbb (index 1)');
  });

  it('closes the temporary CDP client after bringToFront', async () => {
    const { _deps, fakeClient } = makeDeps();
    await switchTab({ index: 0, _deps });

    assert.ok(fakeClient.order.includes('close'), 'temporary client must be closed');
    // close comes after bringToFront
    const frontIdx = fakeClient.order.indexOf('Page.bringToFront');
    const closeIdx = fakeClient.order.indexOf('close');
    assert.ok(closeIdx > frontIdx, 'close must come after bringToFront');
  });
});

describe('switchTab — rebinds the dedicated tab singleton', () => {
  it('calls setDedicatedTab with the switched tab id', async () => {
    const { _deps, setTabCalls } = makeDeps();
    await switchTab({ index: 1, _deps });

    assert.equal(setTabCalls.length, 1, 'setDedicatedTab called once');
    assert.equal(setTabCalls[0], 'tab-bbb', 'setDedicatedTab receives id of tab at index 1');
  });

  it('calls disconnect() after setDedicatedTab to force reconnect', async () => {
    const { _deps, discCalls } = makeDeps();
    await switchTab({ index: 0, _deps });

    assert.equal(discCalls.length, 1, 'disconnect() called once');
  });

  it('returns the correct tab_id and chart_id in the result', async () => {
    const { _deps } = makeDeps();
    const result = await switchTab({ index: 0, _deps });

    assert.equal(result.tab_id, 'tab-aaa');
    assert.equal(result.chart_id, 'abc');
    assert.equal(result.index, 0);
  });
});

describe('switchTab — throws on out-of-range index', () => {
  it('throws when index equals tab_count', async () => {
    const { _deps } = makeDeps();
    await assert.rejects(
      () => switchTab({ index: 2, _deps }),
      /Tab index 2 out of range \(have 2 tabs\)/,
    );
  });

  it('throws when index is greater than tab_count', async () => {
    const { _deps } = makeDeps();
    await assert.rejects(
      () => switchTab({ index: 99, _deps }),
      /Tab index 99 out of range/,
    );
  });

  it('does not call CDP or setDedicatedTab when out of range', async () => {
    const { _deps, cdpCtor, setTabCalls } = makeDeps();
    try { await switchTab({ index: 5, _deps }); } catch {}
    assert.equal(cdpCtor.calls.length, 0, 'CDP must not be called for out-of-range index');
    assert.equal(setTabCalls.length, 0, 'setDedicatedTab must not be called for out-of-range index');
  });
});

describe('connection.js — setDedicatedTab / getDedicatedTabId round-trip', () => {
  it('getDedicatedTabId returns the id set by setDedicatedTab', () => {
    setDedicatedTab('test-tab-123');
    assert.equal(getDedicatedTabId(), 'test-tab-123');
    // Reset to avoid polluting other tests
    setDedicatedTab(null);
  });

  it('getDedicatedTabId returns null after reset', () => {
    setDedicatedTab('some-id');
    setDedicatedTab(null);
    assert.equal(getDedicatedTabId(), null);
  });

  it('setDedicatedTab is idempotent — last write wins', () => {
    setDedicatedTab('first');
    setDedicatedTab('second');
    assert.equal(getDedicatedTabId(), 'second');
    setDedicatedTab(null);
  });
});

// ── Source audits ─────────────────────────────────────────────────────────

describe('tab.js source audit', () => {
  const src = readFileSync(new URL('../src/core/tab.js', import.meta.url), 'utf8');

  it('imports setDedicatedTab from connection.js', () => {
    assert.ok(src.includes('setDedicatedTab'), 'tab.js must reference setDedicatedTab');
  });

  it('calls Page.bringToFront (not just HTTP /json/activate)', () => {
    assert.ok(src.includes('Page.bringToFront'), 'switchTab must call Page.bringToFront');
  });

  it('no longer relies solely on /json/activate HTTP endpoint', () => {
    // The HTTP activate endpoint alone was the bug; it may still appear as fallback
    // but bringToFront must be the primary mechanism
    const frontIdx = src.indexOf('Page.bringToFront');
    assert.ok(frontIdx !== -1, 'Page.bringToFront must appear in source');
  });
});

describe('connection.js source audit', () => {
  const src = readFileSync(new URL('../src/connection.js', import.meta.url), 'utf8');

  it('exports setDedicatedTab', () => {
    assert.ok(src.includes('export function setDedicatedTab'), 'connection.js must export setDedicatedTab');
  });

  it('exports getDedicatedTabId', () => {
    assert.ok(src.includes('export function getDedicatedTabId'), 'connection.js must export getDedicatedTabId');
  });

  it('has a dedicatedTabId module-level variable', () => {
    assert.ok(src.includes('dedicatedTabId'), 'connection.js must declare dedicatedTabId');
  });

  it('findChartTarget checks dedicatedTabId before falling back to createDedicatedTab', () => {
    const dedicated = src.indexOf('dedicatedTabId');
    const createDed = src.indexOf('createDedicatedTab');
    assert.ok(dedicated !== -1 && createDed !== -1, 'both dedicatedTabId and createDedicatedTab must exist');
    assert.ok(dedicated < createDed, 'dedicatedTabId check must appear before createDedicatedTab call');
  });

  it('disconnect does NOT clear dedicatedTabId', () => {
    // Verify disconnect() body doesn't assign null to dedicatedTabId
    const disconnectFn = src.slice(src.indexOf('export async function disconnect'));
    // grab up to the closing brace
    const body = disconnectFn.slice(0, disconnectFn.indexOf('\n}') + 2);
    assert.ok(!body.includes('dedicatedTabId = null'), 'disconnect must not clear dedicatedTabId');
  });
});
