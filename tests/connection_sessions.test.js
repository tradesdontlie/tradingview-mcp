import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createConnectionRuntime } from '../src/connection.js';
import { createSessionContext, runWithSessionContext, getSessionContext } from '../src/session-context.js';

const chart = id => ({ id, type: 'page', url: `https://www.tradingview.com/chart/${id}/`, title: `Chart ${id}` });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const runtimes = [];

function harness(initial = ['a'], overrides = {}) {
  const targets = initial.map(chart);
  const calls = [];
  const clients = [];
  let mutations = 0;
  const makeClient = id => {
    const raw = new EventEmitter();
    raw.id = id;
    raw.ready = true;
    raw.closes = 0;
    raw.Runtime = {
      enable: async () => {},
      evaluate: async ({ expression }) => {
        calls.push({ id, expression });
        if (expression.startsWith('Boolean(')) return { result: { value: raw.ready } };
        if (expression === 'mutate-hang') { mutations++; return new Promise(() => {}); }
        return { result: { value: id } };
      },
    };
    raw.Page = { enable: async () => {}, captureScreenshot: async () => new Promise(() => {}) };
    raw.DOM = { enable: async () => {} };
    raw.close = async () => { raw.closes++; };
    clients.push(raw);
    return raw;
  };
  const runtime = createConnectionRuntime({
    cdp: async ({ target }) => makeClient(target),
    fetch: async () => ({ ok: true, json: async () => targets }),
    timeoutMs: 40, closeTimeoutMs: 10, ...overrides,
  });
  runtimes.push(runtime);
  return { runtime, targets, calls, clients, makeClient, get mutations() { return mutations; } };
}

afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.disconnect())); });

it('isolates interleaved MCP sessions and keeps the exact selected window per session', async () => {
  const { runtime } = harness(['a', 'b']);
  const a = createSessionContext({ targetId: 'a' });
  const b = createSessionContext({ targetId: 'b' });
  const results = await Promise.all([
    runWithSessionContext(a, async () => { await runtime.getClient(); await delay(5); return runtime.evaluate('read'); }),
    runWithSessionContext(b, async () => { await runtime.getClient(); return runtime.evaluate('read'); }),
  ]);
  assert.deepEqual(results, ['a', 'b']);
  assert.equal(a.selectedTargetId, 'a');
  assert.equal(b.selectedTargetId, 'b');
});

it('serializes one session while allowing nested session work without deadlock', async () => {
  const session = createSessionContext({ targetId: null });
  const gate = deferred();
  const order = [];
  const first = runWithSessionContext(session, async () => {
    order.push('first-start');
    await gate.promise;
    await runWithSessionContext(session, () => { assert.equal(getSessionContext(), session); order.push('nested'); });
    order.push('first-end');
  });
  const second = runWithSessionContext(session, () => { order.push('second'); });
  await delay(1);
  assert.deepEqual(order, ['first-start']);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'nested', 'first-end', 'second']);
});

it('requires an explicit target when several charts are open, then selects without activating UI', async () => {
  const h = harness(['a', 'b']);
  const session = createSessionContext({ targetId: null });
  await runWithSessionContext(session, async () => {
    await assert.rejects(h.runtime.evaluate('read'), /Multiple TradingView charts/);
    assert.equal(h.clients.length, 0);
    const listed = await h.runtime.listTargets();
    assert.equal(listed.targets.length, 2);
    assert.equal(listed.selected_target_id, null);
    await h.runtime.selectTarget('b');
    assert.equal(await h.runtime.evaluate('read'), 'b');
    await assert.rejects(h.runtime.selectTarget('0'), /exact ID/);
    assert.equal(session.selectedTargetId, 'b');
  });
});

it('pins a single auto-selected chart and never replaces a lost target with another window', async () => {
  const h = harness(['a']);
  const session = createSessionContext({ targetId: null });
  await runWithSessionContext(session, async () => {
    assert.equal(await h.runtime.evaluate('read'), 'a');
    h.targets.splice(0, 1, chart('b'));
    h.clients[0].ready = false;
    await assert.rejects(h.runtime.evaluate('read'), /Selected CDP target a is unavailable; no fallback/);
    assert.equal(session.selectedTargetId, 'a');
    assert.equal(h.clients.length, 1);
    assert.equal(h.clients[0].closes, 1);
  });
});

it('times out a mutation exactly once, invalidates the cache, and allows a later explicit call', async () => {
  const h = harness(['a']);
  const session = createSessionContext({ targetId: 'a' });
  await runWithSessionContext(session, async () => {
    await assert.rejects(h.runtime.evaluate('mutate-hang'), error => error.code === 'CDP_TIMEOUT');
    assert.equal(h.mutations, 1, 'uncertain operation must not be replayed');
    assert.equal(h.clients[0].closes, 1);
    assert.equal(await h.runtime.evaluate('read'), 'a');
    assert.equal(h.clients.length, 2);
  });
});

it('bounds direct CDP domain calls and client close when the renderer/socket does not respond', async () => {
  const h = harness(['a']);
  const session = createSessionContext({ targetId: 'a' });
  await runWithSessionContext(session, async () => {
    const client = await h.runtime.getClient();
    h.clients[0].close = async () => { h.clients[0].closes++; return new Promise(() => {}); };
    const started = Date.now();
    await assert.rejects(client.Page.captureScreenshot({}), error => error.code === 'CDP_TIMEOUT' && error.command_may_have_executed);
    assert.ok(Date.now() - started < 500, 'close must not hang after command timeout');
    await assert.rejects(client.Runtime.evaluate({ expression: 'read' }), /stale/);
  });
});

it('fences a CDP connection that resolves after its deadline and closes it without caching it', async () => {
  const opening = deferred();
  const h = harness(['a'], { cdp: () => opening.promise });
  const session = createSessionContext({ targetId: 'a' });
  await runWithSessionContext(session, async () => {
    await assert.rejects(h.runtime.getClient(), error => error.code === 'CDP_TIMEOUT');
    const late = h.makeClient('a');
    opening.resolve(late);
    await delay(5);
    assert.equal(late.closes, 1);
    assert.equal(h.calls.length, 0, 'late client must not enable or evaluate chart code');
  });
});

it('aborts discovery and bounds body parsing as well as the initial HTTP response', async () => {
  let signal;
  const h = harness([], { fetch: async (url, opts) => {
    signal = opts.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  } });
  await assert.rejects(h.runtime.listTargets(), error => error.code === 'CDP_TIMEOUT');
  assert.equal(signal.aborted, true);
});

it('disposes a session without closing another session, and rejects queued/future work for disposed sessions', async () => {
  const h = harness(['a', 'b']);
  const a = createSessionContext({ targetId: 'a' });
  const b = createSessionContext({ targetId: 'b' });
  await runWithSessionContext(a, () => h.runtime.getClient());
  await runWithSessionContext(b, () => h.runtime.getClient());
  await h.runtime.disposeSession(a);
  assert.equal(h.clients[0].closes, 1);
  assert.equal(h.clients[1].closes, 0);
  await assert.rejects(runWithSessionContext(a, () => h.runtime.getClient()), /closed/);
  assert.equal(await runWithSessionContext(b, () => h.runtime.evaluate('read')), 'b');
});

it('applies a shorter evaluation budget to connection establishment and never dispatches after expiry', async () => {
  const opening = deferred();
  const h = harness(['a'], { cdp: () => opening.promise, timeoutMs: 100 });
  const session = createSessionContext({ targetId: 'a' });
  await runWithSessionContext(session, async () => {
    await assert.rejects(h.runtime.evaluate('mutate-hang', { timeoutMs: 10 }), error => error.code === 'CDP_TIMEOUT');
    const late = h.makeClient('a');
    opening.resolve(late);
    await delay(5);
    assert.equal(late.closes, 1);
    assert.equal(h.mutations, 0);
  });
});

it('a late readiness failure from an expired call cannot close a newer cached connection', async () => {
  const h = harness(['a'], { timeoutMs: 100 });
  const session = createSessionContext({ targetId: 'a' });
  await runWithSessionContext(session, async () => {
    await h.runtime.getClient();
    const readiness = deferred();
    h.clients[0].Runtime.evaluate = () => readiness.promise;
    await assert.rejects(h.runtime.evaluate('mutate-hang', { timeoutMs: 10 }), error => error.code === 'CDP_TIMEOUT');
    assert.equal(await h.runtime.evaluate('read'), 'a');
    readiness.resolve({ result: { value: false } });
    await delay(5);
    assert.equal(h.clients[1].closes, 0);
    assert.equal(await h.runtime.evaluate('read'), 'a');
  });
});

it('normalizes primitive transport failures and fences a stale close handle', async () => {
  const h = harness(['a', 'b']);
  const session = createSessionContext({ targetId: 'a' });
  await runWithSessionContext(session, async () => {
    const first = await h.runtime.getClient();
    h.clients[0].Page.captureScreenshot = async () => { throw 'socket closed'; };
    await assert.rejects(first.Page.captureScreenshot({}), error => error instanceof Error && error.command_may_have_executed && /socket closed/.test(error.message));
    await h.runtime.selectTarget('b');
    await first.close();
    assert.equal(h.clients[1].closes, 0, 'stale client.close must not invalidate a new target');
    assert.equal(await h.runtime.evaluate('read'), 'b');
  });
});
