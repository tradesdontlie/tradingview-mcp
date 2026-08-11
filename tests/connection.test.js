import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionManager } from '../src/connection.js';
import { symbolInfo } from '../src/core/chart.js';

function makeClient(initialEvaluate) {
  const protocolHandlers = new Map();
  const clientHandlers = new Map();
  let evaluateImpl = initialEvaluate;
  let closeCount = 0;

  const register = (domain, event) => (handler) => {
    protocolHandlers.set(`${domain}.${event}`, handler);
  };

  const client = {
    Runtime: {
      enable: async () => {},
      evaluate: (params) => evaluateImpl(params),
      executionContextsCleared: register('Runtime', 'executionContextsCleared'),
    },
    Page: {
      enable: async () => {},
      frameNavigated: register('Page', 'frameNavigated'),
    },
    DOM: { enable: async () => {} },
    Inspector: { detached: register('Inspector', 'detached') },
    Target: {
      detachedFromTarget: register('Target', 'detachedFromTarget'),
      targetDestroyed: register('Target', 'targetDestroyed'),
    },
    on(event, handler) { clientHandlers.set(event, handler); },
    async close() { closeCount++; },
    setEvaluate(fn) { evaluateImpl = fn; },
    emitProtocol(domain, event, payload = {}) {
      protocolHandlers.get(`${domain}.${event}`)?.(payload);
    },
    emit(event, payload) { clientHandlers.get(event)?.(payload); },
    get closeCount() { return closeCount; },
  };
  return client;
}

function makeManager(clients, overrides = {}, targetLists = null) {
  let connectionCount = 0;
  let discoveryCount = 0;
  const connectedTargetIds = [];
  const manager = createConnectionManager({
    cdp: async ({ target }) => {
      connectedTargetIds.push(target);
      const next = clients[connectionCount++];
      if (!next) throw new Error('unexpected extra CDP connection');
      return next;
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        discoveryCount++;
        const targets = targetLists?.[Math.min(discoveryCount - 1, targetLists.length - 1)];
        return targets || [{ id: 'target-1', type: 'page', url: 'https://www.tradingview.com/chart/layout-1/' }];
      },
    }),
    timeouts: {
      liveness: 20,
      evaluate: 20,
      discovery: 50,
      connect: 100,
      setup: 50,
      close: 20,
      ...overrides,
    },
  });
  return {
    manager,
    get connectionCount() { return connectionCount; },
    get discoveryCount() { return discoveryCount; },
    connectedTargetIds,
  };
}

const never = () => new Promise(() => {});
const value = (result) => Promise.resolve({ result: { value: result } });

async function waitUntil(predicate, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached before test deadline');
}

describe('connection deadlines and recovery', () => {
  it('bounds an explicitly retryable Runtime.evaluate and resets the cached client after one retry', async () => {
    const first = makeClient(never);
    const second = makeClient(never);
    const fixture = makeManager([first, second]);
    const started = Date.now();

    await assert.rejects(
      () => fixture.manager.evaluate('window.neverResolves', { retry: true }),
      err => err.reason === 'cdp_timeout' && /Runtime\.evaluate/.test(err.message),
    );

    assert.ok(Date.now() - started < 300, 'evaluation stayed inside its bounded deadline');
    assert.equal(fixture.connectionCount, 2, 'initial connection plus exactly one reconnect');
    assert.equal(first.closeCount, 1);
    assert.equal(second.closeCount, 1);
    assert.equal(fixture.manager._debugState().hasClient, false, 'failed retry was not cached');
  });

  it('reconnects exactly once after execution-context loss and retries the evaluation', async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const first = makeClient(async () => {
      firstCalls++;
      throw new Error('Execution context was destroyed, most likely because of a navigation.');
    });
    const second = makeClient(() => {
      secondCalls++;
      return value({ ready: true });
    });
    const fixture = makeManager([first, second]);

    const result = await fixture.manager.evaluate('window.readOnlyState', { retry: true });

    assert.deepEqual(result, { ready: true });
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 1, 'explicit retry replayed the read exactly once');
    assert.equal(fixture.connectionCount, 2);
    assert.equal(first.closeCount, 1);
    assert.equal(second.closeCount, 0);
    assert.equal(fixture.manager._debugState().hasClient, true);
  });

  it('reconnects after a liveness Runtime.evaluate deadline', async () => {
    const first = makeClient(() => value(1));
    const second = makeClient(() => value(1));
    const fixture = makeManager([first, second]);
    await fixture.manager.connect();
    first.setEvaluate(never);

    const client = await fixture.manager.getClient();

    assert.equal(client, second);
    assert.equal(fixture.connectionCount, 2);
    assert.equal(first.closeCount, 1);
  });

  it('defaults to reconnecting without replay when a mutating outcome is unknown', async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const first = makeClient(async () => {
      firstCalls++;
      throw new Error('Inspected target navigated or closed');
    });
    const second = makeClient(async () => {
      secondCalls++;
      return { result: { value: true } };
    });
    const fixture = makeManager([first, second]);

    await assert.rejects(
      () => fixture.manager.evaluate('window.startMutation()'),
      err => err.reason === 'navigation_invalidated'
        && err.outcome_unknown === true
        && err.transport_reconnect_attempted === true
        && err.transport_reconnected === true,
    );

    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 0, 'uncertain mutation was not replayed');
    assert.equal(fixture.connectionCount, 2, 'connection was reacquired once for verification callers');
    assert.equal(fixture.manager._debugState().hasClient, true);
  });

  it('surfaces outcome_unknown even when transport reconnection also fails', async () => {
    const first = makeClient(async () => {
      throw new Error('Execution context was destroyed during navigation');
    });
    const fixture = makeManager([first]);

    await assert.rejects(
      () => fixture.manager.evaluate('window.startMutation()', { retry: false }),
      err => err.reason === 'execution_context_lost'
        && err.outcome_unknown === true
        && err.transport_reconnect_attempted === true
        && err.transport_reconnected === false
        && /unexpected extra CDP connection/.test(err.reconnect_error),
    );

    assert.equal(fixture.connectionCount, 2, 'one reconnect was attempted without replay');
    assert.equal(first.closeCount, 1);
    assert.equal(fixture.manager._debugState().hasClient, false);
  });

  it('does not reconnect when disconnect fences a pending evaluation failure', async () => {
    let rejectEvaluation;
    let evaluationStarted = false;
    const first = makeClient(() => {
      evaluationStarted = true;
      return new Promise((_, reject) => { rejectEvaluation = reject; });
    });
    const second = makeClient(() => value('later generation'));
    const fixture = makeManager([first, second]);

    const pending = fixture.manager.evaluate('window.pendingRead', { retry: true });
    await waitUntil(() => evaluationStarted);
    await fixture.manager.disconnect();
    rejectEvaluation(new Error('Execution context was destroyed during navigation'));

    await assert.rejects(
      pending,
      err => err.reason === 'connection_closed' && /explicit disconnect/.test(err.message),
    );
    assert.equal(fixture.connectionCount, 1, 'no connection was opened after explicit disconnect');
    assert.equal(first.closeCount, 1);
    assert.equal(second.closeCount, 0);
    assert.equal(fixture.manager._debugState().hasClient, false);

    const laterResult = await fixture.manager.evaluate('window.laterRead', { retry: true });
    assert.equal(laterResult, 'later generation', 'an explicit later operation connected on the new generation');
    assert.equal(fixture.connectionCount, 2);
  });

  it('closes a connect client that resolves after disconnect without publishing it', async () => {
    let resolveSocket;
    let socketStarted = false;
    const lateClient = makeClient(() => value(1));
    const manager = createConnectionManager({
      cdp: () => {
        socketStarted = true;
        return new Promise(resolve => { resolveSocket = resolve; });
      },
      fetchImpl: async () => ({
        ok: true,
        json: async () => [{ id: 'disconnected-target', type: 'page', url: 'https://www.tradingview.com/chart/disconnected/' }],
      }),
      timeouts: { discovery: 100, connect: 100, setup: 100, close: 20 },
    });

    const pending = manager.connect();
    await waitUntil(() => socketStarted);
    await manager.disconnect();
    resolveSocket(lateClient);

    await assert.rejects(
      pending,
      err => err.reason === 'connection_closed' && /explicit disconnect/.test(err.message),
    );
    assert.equal(lateClient.closeCount, 1, 'late client was closed exactly once');
    assert.equal(manager._debugState().hasClient, false, 'late client was never published');
    assert.equal(manager._debugState().targetInfo, null);
  });

  it('closes a CDP client that resolves after the connect deadline without caching it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let resolveSocket;
    let socketStarted = false;
    const lateClient = makeClient(() => value(1));
    const manager = createConnectionManager({
      cdp: () => {
        socketStarted = true;
        return new Promise(resolve => { resolveSocket = resolve; });
      },
      fetchImpl: async () => ({
        ok: true,
        json: async () => [{ id: 'late-target', type: 'page', url: 'https://www.tradingview.com/chart/late/' }],
      }),
      timeouts: { discovery: 100, connect: 50, setup: 100, close: 20 },
    });

    const pending = manager.connect();
    for (let i = 0; i < 100 && !socketStarted; i++) await Promise.resolve();
    assert.equal(socketStarted, true);

    t.mock.timers.tick(50);
    await assert.rejects(pending, err => err.reason === 'cdp_timeout');
    resolveSocket(lateClient);
    for (let i = 0; i < 10 && lateClient.closeCount === 0; i++) await Promise.resolve();

    assert.equal(lateClient.closeCount, 1, 'late client was closed exactly once');
    assert.equal(manager._debugState().hasClient, false, 'late client was never published');
    assert.equal(manager._debugState().targetInfo, null);
  });

  it('invalidates and reconnects once when the page navigation event fires', async () => {
    const first = makeClient(() => value(1));
    const second = makeClient(() => value(1));
    const targetA = { id: 'target-A', type: 'page', url: 'https://www.tradingview.com/chart/a/' };
    const targetB = { id: 'target-B', type: 'page', url: 'https://www.tradingview.com/chart/b/' };
    const fixture = makeManager([first, second], {}, [
      [targetB, targetA],
      [targetB, targetA],
    ]);
    await fixture.manager.connect({ expectedTargetId: 'target-A' });

    first.emitProtocol('Page', 'frameNavigated');
    await waitUntil(() => fixture.connectionCount === 2 && fixture.manager._debugState().hasClient);
    const recovered = await fixture.manager.reconnect('layout_navigation');

    assert.equal(recovered, second);
    assert.equal(first.closeCount, 1);
    assert.equal(second.closeCount, 0);
    assert.equal(fixture.connectionCount, 2, 'explicit layout recovery reused the event recovery');
    assert.deepEqual(fixture.connectedTargetIds, ['target-A', 'target-A']);
  });

  it('pins event-driven recovery to the original target when multiple charts exist', async () => {
    const first = makeClient(() => value(1));
    const second = makeClient(() => value(1));
    const targetA = { id: 'target-A', type: 'page', url: 'https://www.tradingview.com/chart/a/' };
    const targetB = { id: 'target-B', type: 'page', url: 'https://www.tradingview.com/chart/b/' };
    const fixture = makeManager([first, second], {}, [
      [targetB, targetA],
      [targetB, targetA],
    ]);
    await fixture.manager.connect({ expectedTargetId: 'target-A' });

    first.emitProtocol('Runtime', 'executionContextsCleared');
    await waitUntil(() => fixture.connectionCount === 2 && fixture.manager._debugState().hasClient);

    assert.deepEqual(fixture.connectedTargetIds, ['target-A', 'target-A']);
    assert.equal(fixture.manager._debugState().targetInfo.id, 'target-A');
  });

  it('fails closed when the pinned target disappears, while a later unpinned connect may select another chart', async () => {
    const first = makeClient(() => value(1));
    const second = makeClient(() => value(1));
    const targetA = { id: 'target-A', type: 'page', url: 'https://www.tradingview.com/chart/a/' };
    const targetB = { id: 'target-B', type: 'page', url: 'https://www.tradingview.com/chart/b/' };
    const fixture = makeManager([first, second], {}, [
      [targetA, targetB],
      [targetB],
      [targetB],
    ]);
    await fixture.manager.connect({ preferredTargetId: 'target-A' });

    await assert.rejects(
      () => fixture.manager.reconnect('layout_navigation', { expectedTargetId: 'target-A' }),
      err => err.reason === 'target_replaced',
    );
    assert.deepEqual(fixture.connectedTargetIds, ['target-A'], 'replacement target was never connected during pinned recovery');
    assert.equal(fixture.manager._debugState().hasClient, false);

    await fixture.manager.connect();
    assert.deepEqual(fixture.connectedTargetIds, ['target-A', 'target-B']);
    assert.equal(fixture.manager._debugState().targetInfo.id, 'target-B');
  });
});

describe('symbolInfo regression', () => {
  it('uses the shared injected evaluator instead of an undefined evaluate binding', async () => {
    const expected = {
      symbol: 'AAPL',
      full_name: 'NASDAQ:AAPL',
      exchange: 'NASDAQ',
      description: 'Apple Inc.',
      type: 'stock',
      pro_name: 'NASDAQ:AAPL',
      typespecs: ['common'],
      resolution: '1D',
      chart_type: 1,
    };
    const calls = [];
    const evaluate = async (expression, options) => {
      calls.push({ expression, options });
      return expected;
    };

    const result = await symbolInfo({ _deps: { evaluate } });

    assert.deepEqual(result, { success: true, ...expected });
    assert.equal(calls.length, 1);
    assert.match(calls[0].expression, /symbolExt\(\)/);
    assert.deepEqual(calls[0].options, { retry: true });
  });
});
