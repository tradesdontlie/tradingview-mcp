import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createTabTransport } from '../src/core/tab.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const shell = id => ({ id, type: 'page', url: `file:///TradingView/app/window/index.html?window=${id}` });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function mockTransport(targets = [shell('shell')], { callback, close, cdp } = {}) {
  const clients = [];
  let writes = 0;
  const makeClient = id => {
    const client = {
      id, closes: 0,
      Runtime: { evaluate: async ({ expression }) => {
        if (expression.startsWith('!!')) return { result: { value: true } };
        if (expression === 'write') writes++;
        return callback ? callback(expression) : { result: { value: 'visible' } };
      } },
      close: async () => { client.closes++; if (close) return close(); },
    };
    clients.push(client);
    return client;
  };
  const transport = createTabTransport({
    cdp: cdp || (async ({ target }) => makeClient(target)),
    fetch: async () => ({ ok: true, json: async () => targets }), timeoutMs: 30,
  });
  return { transport, clients, makeClient, get writes() { return writes; } };
}

it('does not retry a native shell mutation when the callback fails', async () => {
  const h = mockTransport([shell('only')], { callback: () => { throw new Error('uncertain write'); } });
  await assert.rejects(h.transport.withShell(evaluate => evaluate('write')), /uncertain write/);
  assert.equal(h.writes, 1);
  assert.equal(h.clients.length, 2, 'one read-only probe and one callback connection');
  assert.ok(h.clients.every(client => client.closes === 1));
});

it('refuses ambiguous native shell ownership before any tab callback runs', async () => {
  const h = mockTransport([shell('one'), shell('two')]);
  let invoked = false;
  await assert.rejects(h.transport.withShell(() => { invoked = true; }), /Multiple TradingView shell tab bars/);
  assert.equal(invoked, false);
  assert.ok(h.clients.every(client => client.closes === 1));
});

it('bounds detached evaluations and close cleanup on an unresponsive renderer', async () => {
  const h = mockTransport([], { callback: () => new Promise(() => {}), close: () => new Promise(() => {}) });
  const started = Date.now();
  await assert.rejects(h.transport.withTarget('target', evaluate => evaluate('read')), error => error.code === 'CDP_TIMEOUT');
  assert.ok(Date.now() - started < 500);
  assert.equal(h.clients[0].closes, 1);
});

it('closes a detached connection that arrives after the callback deadline', async () => {
  const opening = deferred();
  const h = mockTransport([], { cdp: () => opening.promise });
  let invoked = false;
  await assert.rejects(h.transport.withTarget('target', () => { invoked = true; }), error => error.code === 'CDP_TIMEOUT');
  const late = h.makeClient('target');
  opening.resolve(late);
  await delay(5);
  assert.equal(invoked, false);
  assert.equal(late.closes, 1);
});

it('prevents callback continuation from dispatching after its overall deadline', async () => {
  const h = mockTransport([]);
  await assert.rejects(h.transport.withTarget('target', async evaluate => {
    await delay(60);
    return evaluate('write');
  }), error => error.code === 'CDP_TIMEOUT');
  await delay(40);
  assert.equal(h.writes, 0);
  assert.equal(h.clients[0].closes, 1);
});

it('aborts detached target discovery even when response parsing stalls', async () => {
  let signal;
  const transport = createTabTransport({ timeoutMs: 10, fetch: async (url, opts) => {
    signal = opts.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  } });
  await assert.rejects(transport.discoverTargets(), error => error.code === 'CDP_TIMEOUT');
  assert.equal(signal.aborted, true);
});
