/**
 * Tests for src/core/mt5.js — validation and request shaping against a
 * mocked bridge client (no real MT5 bridge or terminal involved).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  health, getAccount, getPositions, getQuote,
  placeOrder, closeOrder, modifyOrder,
} from '../src/core/mt5.js';

function mockDeps({ get = {}, post = {} } = {}) {
  const calls = { get: [], post: [] };
  const mt5Get = async (path) => {
    calls.get.push(path);
    for (const [key, val] of Object.entries(get)) {
      if (path.includes(key)) return typeof val === 'function' ? val(path) : val;
    }
    throw new Error(`unmocked GET ${path}`);
  };
  const mt5Post = async (path, body) => {
    calls.post.push({ path, body });
    for (const [key, val] of Object.entries(post)) {
      if (path.includes(key)) return typeof val === 'function' ? val(body) : val;
    }
    throw new Error(`unmocked POST ${path}`);
  };
  return { _deps: { mt5Get, mt5Post }, calls };
}

describe('health()', () => {
  it('reports connected state from the bridge', async () => {
    const { _deps } = mockDeps({ get: { '/health': { success: true, connected: true, terminal: { build: 1 } } } });
    const res = await health({ _deps });
    assert.equal(res.success, true);
    assert.equal(res.connected, true);
    assert.deepEqual(res.terminal, { build: 1 });
  });
});

describe('getAccount()', () => {
  it('maps bridge account fields and demo flag', async () => {
    const { _deps } = mockDeps({
      get: { '/account': { success: true, account: { login: 12345, server: 'Demo-1', currency: 'USD', balance: 10000, equity: 10000, margin: 0, margin_free: 10000, margin_level: 0, leverage: 100, is_demo: true } } },
    });
    const res = await getAccount({ _deps });
    assert.equal(res.success, true);
    assert.equal(res.login, 12345);
    assert.equal(res.is_demo, true);
    assert.equal(res.balance, 10000);
  });
});

describe('getPositions()', () => {
  it('passes symbol filter through as a query param', async () => {
    const { _deps, calls } = mockDeps({ get: { '/positions': { success: true, positions: [] } } });
    await getPositions({ symbol: 'EURUSD', _deps });
    assert.ok(calls.get[0].includes('symbol=EURUSD'));
  });

  it('rejects empty symbol filter', async () => {
    const { _deps } = mockDeps({ get: { '/positions': { success: true, positions: [] } } });
    await assert.rejects(() => getPositions({ symbol: '  ', _deps }), /symbol is required/);
  });
});

describe('getQuote()', () => {
  it('requires a symbol', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => getQuote({ symbol: '', _deps }), /symbol is required/);
  });

  it('returns bid/ask fields from the bridge', async () => {
    const { _deps } = mockDeps({ get: { '/quote': { success: true, quote: { bid: 1.1, ask: 1.1002 } } } });
    const res = await getQuote({ symbol: 'EURUSD', _deps });
    assert.equal(res.symbol, 'EURUSD');
    assert.equal(res.bid, 1.1);
  });
});

describe('placeOrder()', () => {
  it('refuses to place an order without confirm: true', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => placeOrder({ symbol: 'EURUSD', side: 'buy', volume: 0.01, confirm: false, _deps }),
      /confirm must be true/
    );
  });

  it('rejects an invalid side', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => placeOrder({ symbol: 'EURUSD', side: 'long', volume: 0.01, confirm: true, _deps }),
      /side must be "buy" or "sell"/
    );
  });

  it('rejects non-positive volume', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => placeOrder({ symbol: 'EURUSD', side: 'buy', volume: 0, confirm: true, _deps }),
      /volume must be > 0/
    );
  });

  it('sends a well-formed order request when confirmed', async () => {
    const { _deps, calls } = mockDeps({ post: { '/order': { success: true, result: { retcode: 10009, order: 555 } } } });
    const res = await placeOrder({ symbol: 'EURUSD', side: 'buy', volume: 0.01, sl: 1.05, tp: 1.15, comment: 'test', confirm: true, _deps });
    assert.equal(res.success, true);
    assert.equal(res.order.order, 555);
    assert.deepEqual(calls.post[0].body, { symbol: 'EURUSD', side: 'buy', volume: 0.01, sl: 1.05, tp: 1.15, comment: 'test' });
  });
});

describe('closeOrder()', () => {
  it('refuses to close without confirm: true', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => closeOrder({ ticket: 1, confirm: false, _deps }), /confirm must be true/);
  });

  it('closes with ticket when confirmed', async () => {
    const { _deps, calls } = mockDeps({ post: { '/order/close': { success: true, result: { retcode: 10009 } } } });
    const res = await closeOrder({ ticket: 42, confirm: true, _deps });
    assert.equal(res.success, true);
    assert.deepEqual(calls.post[0].body, { ticket: 42 });
  });
});

describe('modifyOrder()', () => {
  it('requires at least sl or tp', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => modifyOrder({ ticket: 1, _deps }), /at least one of sl or tp/);
  });

  it('sends provided sl/tp', async () => {
    const { _deps, calls } = mockDeps({ post: { '/order/modify': { success: true, result: {} } } });
    await modifyOrder({ ticket: 42, sl: 1.05, _deps });
    assert.deepEqual(calls.post[0].body, { ticket: 42, sl: 1.05 });
  });
});
