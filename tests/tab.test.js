/**
 * Tests for tab management in src/core/tab.js.
 * Focus: switchTab must re-attach the CDP client to the activated target
 * (regression for the bug where reads kept returning the previous tab's data).
 * Uses the _deps DI hook to inject a fake fetch + reconnectTo.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { switchTab, list } from '../src/core/tab.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

const TARGETS = [
  { type: 'page', id: 'AAA', title: 'Live stock charts on TradingView — ES', url: 'https://www.tradingview.com/chart/abc123/' },
  { type: 'page', id: 'BBB', title: 'Live stock charts on TradingView — NQ', url: 'https://www.tradingview.com/chart/def456/' },
  { type: 'page', id: 'CCC', title: 'Live stock charts on TradingView — CL', url: 'https://www.tradingview.com/chart/ghi789/' },
  // A non-chart page that must be ignored by list().
  { type: 'page', id: 'ZZZ', title: 'Settings', url: 'https://www.tradingview.com/settings/' },
];

/**
 * Build a _deps object with a fake fetch (serving /json/list and /json/activate)
 * and a reconnectTo stub. Both record their calls for assertions.
 */
function mockDeps(targets = TARGETS) {
  const fetchCalls = [];
  const reconnectCalls = [];
  const fetch = async (url) => {
    fetchCalls.push(url);
    if (url.includes('/json/list')) {
      return { json: async () => targets, text: async () => JSON.stringify(targets) };
    }
    if (url.includes('/json/activate/')) {
      return { json: async () => ({}), text: async () => 'Target activated' };
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };
  const reconnectTo = async (id) => { reconnectCalls.push(id); };
  return { _deps: { fetch, reconnectTo }, fetchCalls, reconnectCalls };
}

// ── list() ─────────────────────────────────────────────────────────────────

describe('list() — chart tab enumeration', () => {
  it('returns only tradingview chart page targets, indexed in order', async () => {
    const { _deps } = mockDeps();
    const res = await list({ _deps });
    assert.equal(res.success, true);
    assert.equal(res.tab_count, 3); // ZZZ settings page excluded
    assert.deepEqual(res.tabs.map(t => t.id), ['AAA', 'BBB', 'CCC']);
    assert.equal(res.tabs[1].chart_id, 'def456');
  });
});

// ── switchTab() — the regression ─────────────────────────────────────────────

describe('switchTab() — CDP re-attach to activated target', () => {
  it('activates the target AND reconnects CDP to that same target id', async () => {
    const { _deps, fetchCalls, reconnectCalls } = mockDeps();
    const res = await switchTab({ index: 1, _deps });

    assert.equal(res.success, true);
    assert.equal(res.action, 'switched');
    assert.equal(res.index, 1);
    assert.equal(res.tab_id, 'BBB');
    assert.equal(res.chart_id, 'def456');

    // The activate call hit the right target...
    assert.ok(
      fetchCalls.some(u => u.includes('/json/activate/BBB')),
      'fetched /json/activate/BBB',
    );
    // ...and — the whole point of the fix — CDP re-attached to that same target.
    assert.deepEqual(reconnectCalls, ['BBB']);
  });

  it('reconnects to tab 0 on a round-trip back', async () => {
    const { _deps, reconnectCalls } = mockDeps();
    await switchTab({ index: 2, _deps });
    await switchTab({ index: 0, _deps });
    assert.deepEqual(reconnectCalls, ['CCC', 'AAA']);
  });

  it('throws on an out-of-range index and never reconnects', async () => {
    const { _deps, reconnectCalls } = mockDeps();
    await assert.rejects(
      () => switchTab({ index: 9, _deps }),
      /out of range/,
    );
    assert.deepEqual(reconnectCalls, []);
  });
});
