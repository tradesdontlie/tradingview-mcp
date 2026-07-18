import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTradingBridgeClient } from '../src/core/ninjatrader.js';
import { registerNinjaTraderTools } from '../src/tools/ninjatrader.js';

describe('TradingBridge client', () => {
  it('defaults to a bridge on localhost', async () => {
    let requestedUrl;
    const fetchImpl = async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = createTradingBridgeClient({ fetchImpl });

    await client.status();

    assert.equal(requestedUrl, 'http://localhost:5555/api/status');
  });

  it('loads status from the configured local bridge with GET', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        success: true,
        status: 'running',
        version: '3.2-optimized',
        mode: 'window',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = createTradingBridgeClient({
      baseUrl: 'http://DS-WIN.local:5555',
      fetchImpl,
    });

    const result = await client.status();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://DS-WIN.local:5555/api/status');
    assert.equal(calls[0].options.method, 'GET');
    assert.deepEqual(result, {
      success: true,
      status: 'running',
      version: '3.2-optimized',
      mode: 'window',
    });
  });

  it('rejects a TradingBridge application failure returned with HTTP 200', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      success: false,
      error: 'Bridge is not ready',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const client = createTradingBridgeClient({ fetchImpl });

    await assert.rejects(() => client.status(), /Bridge is not ready/);
  });

  it('rejects a non-success HTTP response without a bridge failure envelope', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      error: 'Service unavailable',
    }), { status: 503, headers: { 'content-type': 'application/json' } });
    const client = createTradingBridgeClient({ fetchImpl });

    await assert.rejects(() => client.status(), /HTTP 503.*Service unavailable/);
  });

  it('loads bars with an encoded exact contract and provider interval', async () => {
    let requestedUrl;
    const fetchImpl = async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ success: true, bars: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = createTradingBridgeClient({
      baseUrl: 'http://DS-WIN.local:5555/',
      fetchImpl,
    });

    await client.bars({ instrument: 'MNQ 09-26', period: 'Minute', value: 5 });

    const url = new URL(requestedUrl);
    assert.equal(url.pathname, '/api/bars');
    assert.equal(url.searchParams.get('instrument'), 'MNQ 09-26');
    assert.equal(url.searchParams.get('period'), 'Minute');
    assert.equal(url.searchParams.get('value'), '5');
  });

  it('maps snapshot methods to read-only TradingBridge endpoints', async () => {
    const paths = [];
    const fetchImpl = async (url, options) => {
      paths.push({ path: new URL(url).pathname, method: options.method });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = createTradingBridgeClient({ fetchImpl });

    await client.connections();
    await client.accounts();
    await client.positions();
    await client.orders();

    assert.deepEqual(paths, [
      { path: '/api/connections', method: 'GET' },
      { path: '/api/accounts', method: 'GET' },
      { path: '/api/positions', method: 'GET' },
      { path: '/api/orders', method: 'GET' },
    ]);
  });

  it('aborts a bridge request after the configured timeout', async () => {
    const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const client = createTradingBridgeClient({ fetchImpl, timeoutMs: 5 });

    await assert.rejects(() => client.status(), /timed out|timeout/i);
  });
});

describe('NinjaTrader MCP tools', () => {
  it('is registered by the MCP server entrypoint', () => {
    const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    assert.match(source, /registerNinjaTraderTools\(server\)/);
  });

  it('registers nt_status as a read-only status tool', async () => {
    const tools = new Map();
    const server = {
      tool(name, description, schema, handler) {
        tools.set(name, { description, schema, handler });
      },
    };
    const client = {
      status: async () => ({ success: true, status: 'running', version: '3.2-optimized' }),
    };

    registerNinjaTraderTools(server, { client });

    const tool = tools.get('nt_status');
    assert.ok(tool);
    assert.match(tool.description, /read-only/i);
    const result = await tool.handler({});
    assert.deepEqual(JSON.parse(result.content[0].text), {
      success: true,
      status: 'running',
      version: '3.2-optimized',
    });
  });

  it('registers read-only snapshot and exact-contract bar tools', async () => {
    const tools = new Map();
    const server = {
      tool(name, description, schema, handler) {
        tools.set(name, { description, schema, handler });
      },
    };
    const calls = [];
    const client = {
      status: async () => ({ success: true }),
      connections: async () => ({ success: true, connections: [] }),
      accounts: async () => ({ success: true, accounts: [] }),
      positions: async () => ({ success: true, positions: [] }),
      orders: async () => ({ success: true, orders: [] }),
      bars: async (args) => { calls.push(args); return { success: true, bars: [] }; },
    };

    registerNinjaTraderTools(server, { client });

    const expected = ['nt_connections', 'nt_accounts', 'nt_positions', 'nt_orders', 'nt_bars'];
    for (const name of expected) {
      assert.ok(tools.has(name), `${name} registered`);
      assert.match(tools.get(name).description, /read-only/i);
    }
    const result = await tools.get('nt_bars').handler({
      instrument: 'MNQ 09-26',
      period: 'Minute',
      value: 5,
    });
    assert.deepEqual(calls, [{ instrument: 'MNQ 09-26', period: 'Minute', value: 5 }]);
    assert.deepEqual(JSON.parse(result.content[0].text), { success: true, bars: [] });
  });
});
