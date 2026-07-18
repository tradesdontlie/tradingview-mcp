import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { futuresRoot, getBridgeContext } from '../src/core/bridge.js';
import { registerBridgeTools } from '../src/tools/bridge.js';

describe('futuresRoot()', () => {
  it('normalizes TradingView and NinjaTrader futures symbols without inventing an expiry', () => {
    assert.equal(futuresRoot('CME_MINI:ES1!'), 'ES');
    assert.equal(futuresRoot('CME_MINI:MNQ1!'), 'MNQ');
    assert.equal(futuresRoot('ES 09-26'), 'ES');
    assert.equal(futuresRoot('MNQU6'), 'MNQ');
    assert.equal(futuresRoot('NASDAQ:AAPL'), null);
    assert.equal(futuresRoot(''), null);
  });
});

describe('getBridgeContext()', () => {
  it('combines chart and NinjaTrader state without exposing account details', async () => {
    const chartState = async () => ({
      success: true,
      symbol: 'CME_MINI:ES1!',
      resolution: '5',
      chartType: 1,
      studies: [{ id: 'volume', name: 'Volume' }],
    });
    const client = {
      status: async () => ({ success: true, status: 'running', version: '3.2-optimized', mode: 'window' }),
      connections: async () => ({ success: true, hasAnyDataFeed: true, connections: [{ name: 'Simulation', isConnected: true }] }),
      positions: async () => ({ success: true, positions: [
        { instrument: 'ES 09-26', account: 'PRIVATE', quantity: 1 },
        { instrument: 'MNQ 09-26', account: 'PRIVATE', quantity: 2 },
      ] }),
      orders: async () => ({ success: true, orders: [
        { instrument: 'ESU6', account: 'PRIVATE', limitPrice: 5000 },
      ] }),
    };

    const result = await getBridgeContext({ _deps: { chartState, client } });

    assert.deepEqual(result, {
      success: true,
      tradingview: {
        symbol: 'CME_MINI:ES1!',
        resolution: '5',
        chart_type: 1,
        futures_root: 'ES',
        study_count: 1,
      },
      ninjatrader: {
        bridge_status: 'running',
        bridge_version: '3.2-optimized',
        bridge_mode: 'window',
        data_feed_available: true,
        connection_count: 1,
        position_count: 2,
        order_count: 1,
      },
      mapping: {
        compatible: true,
        compatible_instruments: ['ES 09-26', 'ESU6'],
        other_instruments: ['MNQ 09-26'],
      },
    });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|quantity|limitPrice/);
  });
});

describe('bridge MCP tools', () => {
  it('is registered by the MCP server entrypoint', () => {
    const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    assert.match(source, /registerBridgeTools\(server\)/);
  });

  it('registers bridge_get_context as read-only coordination', async () => {
    const tools = new Map();
    const server = {
      tool(name, description, schema, handler) {
        tools.set(name, { description, schema, handler });
      },
    };
    const getContext = async () => ({ success: true, mapping: { compatible: false } });

    registerBridgeTools(server, { getContext });

    const tool = tools.get('bridge_get_context');
    assert.ok(tool);
    assert.match(tool.description, /read-only/i);
    const result = await tool.handler({});
    assert.deepEqual(JSON.parse(result.content[0].text), {
      success: true,
      mapping: { compatible: false },
    });
  });
});
