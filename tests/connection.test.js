/**
 * Tests for findChartTarget in src/connection.js.
 *
 * Covers B14 env-var disambiguation (TRADINGVIEW_TARGET_ID / TRADINGVIEW_CHART_URL)
 * and R3-R2 warning-on-miss behavior.
 *
 * Uses dependency-injected `fetch`, `env`, and `warn` to keep the test hermetic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findChartTarget } from '../src/connection.js';

// ── Fixture targets returned by Chrome's /json/list ───────────────────────

const DEFAULT_TARGETS = [
  { type: 'page', id: 'BCDFA1C30DCC1111111111', url: 'https://www.tradingview.com/chart/CAao16sl/' },
  { type: 'page', id: '3E096BC2663F2222222222', url: 'https://www.tradingview.com/chart/R2Nyob9Y/' },
  { type: 'page', id: '39EE2DC6A1B63333333333', url: 'https://www.tradingview.com/chart/R2Nyob9Y/' },
];

function mockFetch(targets) {
  return async () => ({ json: async () => targets });
}

function makeWarn() {
  const calls = [];
  const fn = (...args) => calls.push(args);
  fn.calls = calls;
  return fn;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('findChartTarget()', () => {
  it('returns the first chart page when no env vars are set', async () => {
    const warn = makeWarn();
    const result = await findChartTarget({
      fetch: mockFetch(DEFAULT_TARGETS),
      env: {},
      warn,
    });
    assert.ok(result, 'returns a target');
    assert.equal(result.id, 'BCDFA1C30DCC1111111111');
    assert.equal(warn.calls.length, 0, 'no warning when no hints provided');
  });

  it('returns target whose id starts with TRADINGVIEW_TARGET_ID prefix', async () => {
    const warn = makeWarn();
    const result = await findChartTarget({
      fetch: mockFetch(DEFAULT_TARGETS),
      env: { TRADINGVIEW_TARGET_ID: '3E096BC2', TRADINGVIEW_CHART_URL: '' },
      warn,
    });
    assert.ok(result, 'returns a target');
    assert.equal(result.id, '3E096BC2663F2222222222');
    assert.equal(warn.calls.length, 0, 'no warning when id matches');
  });

  it('returns target whose URL includes TRADINGVIEW_CHART_URL substring', async () => {
    const warn = makeWarn();
    const result = await findChartTarget({
      fetch: mockFetch(DEFAULT_TARGETS),
      env: { TRADINGVIEW_TARGET_ID: '', TRADINGVIEW_CHART_URL: 'CAao16sl' },
      warn,
    });
    assert.ok(result, 'returns a target');
    assert.equal(result.url, 'https://www.tradingview.com/chart/CAao16sl/');
    assert.equal(warn.calls.length, 0, 'no warning when url matches');
  });

  it('TARGET_ID takes precedence over CHART_URL when both are set', async () => {
    const warn = makeWarn();
    const result = await findChartTarget({
      fetch: mockFetch(DEFAULT_TARGETS),
      env: { TRADINGVIEW_TARGET_ID: '3E096BC2', TRADINGVIEW_CHART_URL: 'CAao16sl' },
      warn,
    });
    assert.ok(result, 'returns a target');
    assert.equal(result.id, '3E096BC2663F2222222222', 'TARGET_ID wins');
    assert.equal(warn.calls.length, 0, 'no warning when id matches');
  });

  it('returns null when no env hint matches AND no fallback chart page exists', async () => {
    const warn = makeWarn();
    const targets = [
      { type: 'page', id: 'DEADBEEF', url: 'https://www.google.com/' },
      { type: 'iframe', id: 'IGNORE', url: 'https://www.tradingview.com/chart/anything/' },
    ];
    const result = await findChartTarget({
      fetch: mockFetch(targets),
      env: { TRADINGVIEW_TARGET_ID: 'NOPE_NO_MATCH', TRADINGVIEW_CHART_URL: '' },
      warn,
    });
    assert.equal(result, null, 'returns null when nothing matches and no fallback');
  });

  it('emits a console.warn when TRADINGVIEW_TARGET_ID does not match any target', async () => {
    const warn = makeWarn();
    const result = await findChartTarget({
      fetch: mockFetch(DEFAULT_TARGETS),
      env: { TRADINGVIEW_TARGET_ID: 'TYPO_NOT_FOUND', TRADINGVIEW_CHART_URL: '' },
      warn,
    });
    // Falls back to first chart page
    assert.ok(result, 'falls back to a chart page');
    assert.equal(result.id, 'BCDFA1C30DCC1111111111');
    assert.equal(warn.calls.length, 1, 'warn was called once');
    const msg = String(warn.calls[0][0] || '');
    assert.ok(msg.includes('TRADINGVIEW_TARGET_ID'), 'warning mentions the env var');
    assert.ok(msg.includes('TYPO_NOT_FOUND'), 'warning includes the bad value');
    assert.ok(msg.includes('did not match'), 'warning explains miss');
  });

  it('emits a console.warn when TRADINGVIEW_CHART_URL does not match any target', async () => {
    const warn = makeWarn();
    const result = await findChartTarget({
      fetch: mockFetch(DEFAULT_TARGETS),
      env: { TRADINGVIEW_TARGET_ID: '', TRADINGVIEW_CHART_URL: 'WRONG_URL_SUBSTR' },
      warn,
    });
    assert.ok(result, 'falls back to a chart page');
    assert.equal(warn.calls.length, 1, 'warn was called once');
    const msg = String(warn.calls[0][0] || '');
    assert.ok(msg.includes('TRADINGVIEW_CHART_URL'), 'warning mentions the env var');
    assert.ok(msg.includes('WRONG_URL_SUBSTR'), 'warning includes the bad value');
  });

  it('uses globalThis.fetch and process.env when called with no deps', async () => {
    // Smoke test: invoking with zero args should NOT throw a parameter error.
    // We stub globalThis.fetch temporarily so we don't hit a real socket.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ json: async () => DEFAULT_TARGETS });
    try {
      const result = await findChartTarget();
      assert.ok(result, 'returns a target using default deps');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
