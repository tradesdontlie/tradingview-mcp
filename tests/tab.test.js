/**
 * Offline unit tests for tab management + the connection fetch helper.
 *
 * tab.js gained a `_resolve(_deps)` seam in the
 * complete-dependency-injection-and-tests change, so these tests cover the
 * tab behaviors deterministically offline:
 *   - fetchWithTimeout aborts a non-resolving fetch within its deadline.
 *   - switchTab throws on an out-of-range index (before any CDP reconnect).
 *   - switchTab activates the target then disconnects/reconnects the CDP
 *     session to the NEW target id on a valid index, with injected fakes for
 *     fetchWithTimeout/disconnect/reconnect — no live chrome-remote-interface
 *     attach required. This offline DI assertion covers the reconnect intent of
 *     fix-tab-switch-cdp-reconnect tasks.md 3.2, superseding a live-only e2e.
 *
 * Run: node --test tests/tab.test.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout } from '../src/connection.js';
import { switchTab } from '../src/core/tab.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('fetchWithTimeout', () => {
  it('aborts a non-resolving fetch within the deadline', async () => {
    // A fetch that respects the AbortSignal but otherwise never resolves.
    globalThis.fetch = (url, opts = {}) =>
      new Promise((_resolve, reject) => {
        const signal = opts.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });

    const started = Date.now();
    await assert.rejects(
      () => fetchWithTimeout('http://localhost:9222/json/list', 50),
      (err) => err.name === 'AbortError' || /abort/i.test(err.message),
    );
    // Should have aborted near the deadline, not hung for seconds.
    assert.ok(Date.now() - started < 2000, 'fetchWithTimeout should abort promptly');
  });

  it('passes through a successful fetch before the deadline', async () => {
    globalThis.fetch = async () => ({ ok: true, async json() { return []; } });
    const resp = await fetchWithTimeout('http://localhost:9222/json/list', 1000);
    assert.equal(resp.ok, true);
    assert.deepEqual(await resp.json(), []);
  });
});

describe('switchTab — index validation', () => {
  function stubTargets(n) {
    // Build a /json/list response with n tradingview chart page targets.
    const targets = Array.from({ length: n }, (_, i) => ({
      type: 'page',
      id: `TARGET-${i}`,
      title: `Live stock charts on chart ${i}`,
      url: `https://www.tradingview.com/chart/abc${i}/`,
    }));
    globalThis.fetch = async (url) => {
      if (String(url).includes('/json/list')) {
        return { async json() { return targets; } };
      }
      // /json/activate should not be reached for an out-of-range index.
      throw new Error(`unexpected fetch to ${url}`);
    };
  }

  it('throws on an index >= the number of open tabs', async () => {
    stubTargets(2); // valid indices: 0, 1
    await assert.rejects(
      () => switchTab({ index: 2 }),
      /out of range/i,
    );
  });

  it('throws on an index past the end without touching activate/reconnect', async () => {
    stubTargets(1);
    await assert.rejects(
      () => switchTab({ index: 5 }),
      /out of range \(have 1 tabs\)/i,
    );
  });

  it('rejects a negative index with the clear out-of-range error (not a TypeError)', async () => {
    stubTargets(3); // valid indices: 0, 1, 2
    await assert.rejects(
      () => switchTab({ index: -1 }),
      (err) => /Tab index -1 out of range \(have 3 tabs\)/.test(err.message)
        && !/Cannot read properties of undefined/.test(err.message),
    );
  });

  it('rejects a NaN / fractional index clearly instead of indexing undefined', async () => {
    stubTargets(3);
    await assert.rejects(
      () => switchTab({ index: NaN }),
      (err) => /out of range/.test(err.message) && !/Cannot read properties of undefined/.test(err.message),
    );
    await assert.rejects(
      () => switchTab({ index: 1.5 }),
      (err) => /out of range/.test(err.message) && !/Cannot read properties of undefined/.test(err.message),
    );
  });
});

// ── switchTab reconnect (DEFERRED from #1, now unblocked by tab.js _deps) ──
//
// tab.js gained a `_resolve(_deps)` seam in the
// complete-dependency-injection-and-tests change, so we can inject fakes for
// fetchWithTimeout/disconnect/reconnect and assert the CDP session is rebuilt
// against the NEW target id on a valid index — no live chrome-remote-interface
// attach required.
describe('switchTab — reconnects CDP to the new target (DI)', () => {
  function makeDeps(n) {
    const targets = Array.from({ length: n }, (_, i) => ({
      type: 'page',
      id: `TARGET-${i}`,
      title: `Live stock charts on chart ${i}`,
      url: `https://www.tradingview.com/chart/abc${i}/`,
    }));
    const calls = { activate: [], disconnect: 0, reconnect: [] };
    const _deps = {
      fetchWithTimeout: async (url) => {
        if (String(url).includes('/json/list')) {
          return { async json() { return targets; }, async text() { return ''; } };
        }
        if (String(url).includes('/json/activate/')) {
          calls.activate.push(String(url));
          return { async text() { return 'Target activated'; } };
        }
        throw new Error(`unexpected fetch to ${url}`);
      },
      disconnect: async () => { calls.disconnect++; },
      reconnect: async (id) => { calls.reconnect.push(id); },
    };
    return { _deps, calls };
  }

  it('activates, disconnects, and reconnects to the selected tab id', async () => {
    const { _deps, calls } = makeDeps(3);
    const r = await switchTab({ index: 2, _deps });
    assert.equal(r.success, true);
    assert.equal(r.index, 2);
    assert.equal(r.tab_id, 'TARGET-2');
    assert.equal(r.chart_id, 'abc2');
    // Activated the correct target via the HTTP endpoint.
    assert.equal(calls.activate.length, 1);
    assert.match(calls.activate[0], /\/json\/activate\/TARGET-2$/);
    // Rebuilt the CDP session against the NEW target id.
    assert.equal(calls.disconnect, 1, 'disconnect called once');
    assert.deepEqual(calls.reconnect, ['TARGET-2'], 'reconnect bound to new target');
  });

  it('does not reconnect when activate throws', async () => {
    const { _deps, calls } = makeDeps(2);
    _deps.fetchWithTimeout = async (url) => {
      if (String(url).includes('/json/list')) {
        return { async json() {
          return [
            { type: 'page', id: 'T0', title: 'Live stock charts on chart', url: 'https://www.tradingview.com/chart/a/' },
            { type: 'page', id: 'T1', title: 'Live stock charts on chart', url: 'https://www.tradingview.com/chart/b/' },
          ];
        } };
      }
      throw new Error('activate network failure');
    };
    await assert.rejects(() => switchTab({ index: 1, _deps }), /Failed to activate tab/);
    assert.equal(calls.disconnect, 0, 'no reconnect attempted after activate failure');
  });
});
