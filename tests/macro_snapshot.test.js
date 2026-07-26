import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const assets = [
  'OANDA:XAUUSD', 'TVC:DXY', 'TVC:US02Y', 'TVC:US10Y', 'CME_MINI:ES1!', 'HOSE:VNINDEX',
].map((provider_symbol) => ({ provider_symbol, expected_full_name: provider_symbol }));

function deps(failSymbol = null) {
  const calls = [];
  return {
    calls,
    getState: async () => ({ symbol: 'NASDAQ:AAPL', resolution: '60' }),
    setSymbol: async ({ symbol }) => { calls.push(`symbol:${symbol}`); if (symbol === failSymbol) throw new Error('quote unavailable'); },
    setTimeframe: async ({ timeframe }) => calls.push(`timeframe:${timeframe}`),
    symbolInfo: async () => ({ symbol: calls.at(-2).slice(7), full_name: calls.at(-2).slice(7), resolution: '1' }),
    getQuote: async () => ({ last: 1, time: 1710000000 }),
    getOhlcv: async () => ({ bars: Array.from({ length: 20 }, (_, i) => ({ time: 1710000000 + i * 60, close: i + 1 })) }),
  };
}

describe('macro snapshot bridge', () => {
  it('captures configured assets in order and restores the chart', async () => {
    const { captureMacroSnapshot } = await import('../src/core/macro_snapshot.js');
    const fake = deps();
    const result = await captureMacroSnapshot({ config: { assets }, eventId: 'event', phase: 'PRE_T15', asOfUtc: '2026-07-26T00:00:00Z', deps: fake });
    assert.equal(result.assets.length, 6);
    assert.deepEqual(fake.calls.slice(-2), ['symbol:NASDAQ:AAPL', 'timeframe:60']);
    assert.equal(result.assets[0].loaded_full_name, 'OANDA:XAUUSD');
  });

  it('restores when capture fails', async () => {
    const { captureMacroSnapshot } = await import('../src/core/macro_snapshot.js');
    const fake = deps('TVC:DXY');
    await assert.rejects(() => captureMacroSnapshot({ config: { assets }, eventId: 'event', phase: 'PRE_T15', asOfUtc: '2026-07-26T00:00:00Z', deps: fake }));
    assert.deepEqual(fake.calls.slice(-2), ['symbol:NASDAQ:AAPL', 'timeframe:60']);
  });
});
