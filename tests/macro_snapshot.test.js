import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureMacroSnapshot } from '../src/core/macro_snapshot.js';

const assets = [
  'OANDA:XAUUSD', 'TVC:DXY', 'TVC:US02Y', 'TVC:US10Y', 'CME_MINI:ES1!', 'HOSE:VNINDEX',
].map((provider_symbol) => ({
  id: provider_symbol === 'HOSE:VNINDEX' ? 'VNINDEX' : provider_symbol,
  provider_symbol,
  expected_full_name: provider_symbol,
}));

function deps({ failQuote = null, mismatch = null, ready = true, restoreFails = false, finalMismatch = false } = {}) {
  const calls = []; let symbol = 'NASDAQ:AAPL'; let resolution = '60';
  return {
    calls,
    getState: async () => finalMismatch && symbol === 'NASDAQ:AAPL' && resolution === '60' && calls.length > 2
      ? { symbol: 'TVC:DXY', resolution: '1' } : { symbol, resolution },
    setSymbol: async ({ symbol: next }) => { calls.push(`symbol:${next}`); if (restoreFails && next === 'NASDAQ:AAPL') throw new Error('restore offline'); symbol = next; return { success: true, chart_ready: ready }; },
    setTimeframe: async ({ timeframe }) => { calls.push(`timeframe:${timeframe}`); resolution = timeframe; return { success: true, chart_ready: ready }; },
    symbolInfo: async () => ({ symbol, full_name: symbol === mismatch ? 'WRONG:NAME' : symbol, resolution }),
    getQuote: async () => { if (symbol === failQuote) throw new Error('quote unavailable'); return { last: 1, time: 1710000000 }; },
    getOhlcv: async () => ({ bars: Array.from({ length: 20 }, (_, i) => ({ time: 1710000000 + i * 60, close: i + 1 })) }),
  };
}

function capture(fake) {
  return captureMacroSnapshot({ config: { assets, sessions_version: 'v1' }, eventId: 'event', phase: 'PRE_T15', asOfUtc: '2026-07-26T00:00:00Z', deps: fake });
}

describe('macro snapshot bridge', () => {
  it('captures all configured assets in order and verifies final restoration state', async () => {
    const fake = deps(); const result = await capture(fake);
    assert.equal(result.assets.length, 6);
    assert.deepEqual(result.assets.map((asset) => asset.loaded_symbol), assets.map((asset) => asset.provider_symbol));
    assert.equal(result.assets[0].observed_at_utc, '2024-03-09T16:00:00Z');
    assert.equal(result.assets[0].retrieved_at_utc, '2024-03-09T16:00:00Z');
    assert.deepEqual(result.assets.at(-1).session_status, 'UNKNOWN');
    assert.equal(result.assets.at(-1).context_only_reason, 'VNINDEX_SESSION_UNKNOWN');
    assert.deepEqual(fake.calls.slice(-2), ['symbol:NASDAQ:AAPL', 'timeframe:60']);
  });

  it('restores after a post-switch market-data failure', async () => {
    const fake = deps({ failQuote: 'TVC:DXY' });
    await assert.rejects(() => capture(fake), /quote unavailable/);
    assert.deepEqual(fake.calls.slice(-2), ['symbol:NASDAQ:AAPL', 'timeframe:60']);
  });

  it('fails closed on identity mismatch and still restores', async () => {
    const fake = deps({ mismatch: 'TVC:DXY' });
    await assert.rejects(() => capture(fake), /identity mismatch/);
    assert.deepEqual(fake.calls.slice(-2), ['symbol:NASDAQ:AAPL', 'timeframe:60']);
  });

  it('rejects false readiness before requesting market data', async () => {
    const fake = deps({ ready: false });
    await assert.rejects(() => capture(fake), /did not become ready/);
  });

  it('reports a restoration failure distinctly', async () => {
    await assert.rejects(() => capture(deps({ restoreFails: true })), /restoration failed: restore offline/);
  });

  it('reports an unproven final restoration state distinctly', async () => {
    await assert.rejects(() => capture(deps({ finalMismatch: true })), /restoration failed: .*final restoration state mismatch/);
  });

  it('registers macro-snapshot in router help and command help', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    for (const args of [['--help'], ['macro-snapshot', '--help']]) {
      const result = spawnSync(process.execPath, ['src/cli/index.js', ...args], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /macro-snapshot/);
    }
  });
});
