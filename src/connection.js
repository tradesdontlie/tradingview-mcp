import CDP from 'chrome-remote-interface';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

const DEFAULT_TIMEOUTS = Object.freeze({
  liveness: 1500,
  evaluate: 10000,
  discovery: 3000,
  connect: 8000,
  setup: 3000,
  close: 500,
});

const RECOVERABLE_REASONS = new Set([
  'cdp_timeout',
  'execution_context_lost',
  'navigation_invalidated',
  'target_replaced',
]);

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

export class CdpError extends Error {
  constructor(reason, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'CdpError';
    this.reason = reason;
    if (options.outcomeUnknown) this.outcome_unknown = true;
  }
}

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export function classifyCdpError(err) {
  if (err?.reason) return err.reason;
  const message = String(err?.message || err || '');
  if (/timed out|timeout/i.test(message)) return 'cdp_timeout';
  if (/execution context|context.*destroyed|cannot find context|contexts? cleared/i.test(message)) {
    return 'execution_context_lost';
  }
  if (/navigat|frame was detached|frame.*removed/i.test(message)) return 'navigation_invalidated';
  if (/target.*(?:closed|detached|destroyed)|inspector.*detached|session.*closed|websocket.*(?:closed|not open)|socket.*closed|connection.*closed|not connected|no target with given id/i.test(message)) {
    return 'target_replaced';
  }
  return 'cdp_command_failed';
}

function toCdpError(err, label, options = {}) {
  if (err instanceof CdpError) return err;
  const reason = options.reason || classifyCdpError(err);
  return new CdpError(reason, `${label} failed: ${err?.message || String(err)}`, {
    cause: err,
    outcomeUnknown: options.outcomeUnknown,
  });
}

function subscribeProtocolEvent(client, domain, event, handler) {
  const eventMethod = client?.[domain]?.[event];
  if (typeof eventMethod === 'function') {
    try {
      eventMethod.call(client[domain], handler);
      return;
    } catch {
      // Fall through to EventEmitter-style subscription.
    }
  }
  if (typeof client?.on === 'function') client.on(`${domain}.${event}`, handler);
}

/**
 * Create an isolated connection manager. Exported for deterministic offline tests;
 * production callers use the singleton wrappers below.
 */
export function createConnectionManager({
  cdp = CDP,
  fetchImpl = globalThis.fetch,
  host = CDP_HOST,
  port = CDP_PORT,
  timeouts = {},
} = {}) {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  let cachedClient = null;
  let cachedTargetInfo = null;
  let connectPromise = null;
  let connectPromiseGeneration = null;
  let autoRecoveredClient = null;
  let epoch = 0;
  let teardownGeneration = 0;
  const closingClients = new WeakSet();

  function expectedTargetIdFrom(options) {
    if (typeof options === 'string') return options || null;
    const value = options?.expectedTargetId
      ?? options?.preferredTargetId
      ?? options?.expected_target_id
      ?? options?.preferred_target_id;
    return value == null || value === '' ? null : String(value);
  }

  function isTradingViewChartTarget(target) {
    return target?.type === 'page' && /tradingview\.com\/chart/i.test(target.url || '');
  }

  function assertExpectedTarget(expectedTargetId, label = 'CDP connection') {
    if (!expectedTargetId || (cachedTargetInfo?.id != null && String(cachedTargetInfo.id) === expectedTargetId)) return;
    throw new CdpError('target_replaced', `${label} could not retain the expected TradingView chart target`);
  }

  function withDeadline(promise, timeoutMs, label) {
    const ms = Math.max(1, Number(timeoutMs) || 1);
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new CdpError('cdp_timeout', `${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  async function closeBounded(candidate) {
    if (!candidate || typeof candidate.close !== 'function') return;
    if ((typeof candidate === 'object' || typeof candidate === 'function') && closingClients.has(candidate)) return;
    if (typeof candidate === 'object' || typeof candidate === 'function') closingClients.add(candidate);
    try {
      await withDeadline(Promise.resolve().then(() => candidate.close()), limits.close, 'CDP client close');
    } catch {
      // Best effort. Cache state is cleared before close is attempted.
    }
  }

  async function invalidate(candidate = cachedClient) {
    if (!candidate || cachedClient !== candidate) return false;
    cachedClient = null;
    cachedTargetInfo = null;
    if (autoRecoveredClient === candidate) autoRecoveredClient = null;
    epoch++;
    await closeBounded(candidate);
    return true;
  }

  async function findChartTarget(options = {}) {
    const expectedTargetId = expectedTargetIdFrom(options);
    let controller;
    try { controller = new AbortController(); } catch { controller = null; }
    const url = `http://${host}:${port}/json/list`;
    let response;
    try {
      response = await withDeadline(
        fetchImpl(url, controller ? { signal: controller.signal } : undefined),
        limits.discovery,
        'CDP target discovery',
      );
      if (typeof response?.ok === 'boolean' && !response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const targets = await withDeadline(response.json(), limits.discovery, 'CDP target list parsing');
      if (expectedTargetId) {
        const expected = targets.find(target => String(target?.id) === expectedTargetId);
        if (!isTradingViewChartTarget(expected)) {
          throw new CdpError('target_replaced', 'Expected TradingView chart target is no longer available');
        }
        return expected;
      }
      return targets.find(isTradingViewChartTarget)
        || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
        || null;
    } catch (err) {
      try { controller?.abort(); } catch {}
      throw toCdpError(err, 'CDP target discovery');
    }
  }

  function connectionClosedError(label = 'CDP operation') {
    return new CdpError('connection_closed', `${label} was interrupted by explicit disconnect`);
  }

  function assertCurrentGeneration(operationGeneration, label) {
    if (operationGeneration === teardownGeneration) return;
    throw connectionClosedError(label);
  }

  function assertCurrentAttempt(attemptEpoch, attemptGeneration) {
    assertCurrentGeneration(attemptGeneration, 'CDP connection attempt');
    if (attemptEpoch === epoch) return;
    throw new CdpError('target_replaced', 'CDP connection attempt was superseded');
  }

  function attachInvalidationHandlers(candidate, clientGeneration, candidateTargetId) {
    const recover = (reason) => {
      if (cachedClient !== candidate || clientGeneration !== teardownGeneration) return;
      void (async () => {
        const invalidated = await invalidate(candidate);
        if (!invalidated) return;
        try {
          assertCurrentGeneration(clientGeneration, `CDP event recovery (${reason})`);
          const recovered = await connectForGeneration(clientGeneration, { expectedTargetId: candidateTargetId });
          if (cachedClient === recovered) autoRecoveredClient = recovered;
        } catch { /* Next public call will retry discovery. */ }
      })();
    };

    if (typeof candidate?.on === 'function') {
      candidate.on('disconnect', () => recover('target_replaced'));
      candidate.on('close', () => recover('target_replaced'));
      candidate.on('error', () => recover('target_replaced'));
    }
    subscribeProtocolEvent(candidate, 'Runtime', 'executionContextsCleared', () => recover('execution_context_lost'));
    subscribeProtocolEvent(candidate, 'Inspector', 'detached', () => recover('target_replaced'));
    subscribeProtocolEvent(candidate, 'Target', 'detachedFromTarget', event => {
      if (!event?.targetId || event.targetId === candidateTargetId) recover('target_replaced');
    });
    subscribeProtocolEvent(candidate, 'Target', 'targetDestroyed', event => {
      if (!event?.targetId || event.targetId === candidateTargetId) recover('target_replaced');
    });
    subscribeProtocolEvent(candidate, 'Page', 'frameNavigated', event => {
      if (!event?.frame?.parentId) recover('navigation_invalidated');
    });
  }

  async function connectOnce(attemptEpoch, attemptGeneration, expectedTargetId) {
    const target = await findChartTarget({ expectedTargetId });
    assertCurrentAttempt(attemptEpoch, attemptGeneration);
    if (!target) {
      throw new CdpError('target_replaced', 'No TradingView chart target found. Is TradingView open with a chart?');
    }

    let candidate;
    try {
      const socketPromise = Promise.resolve().then(() => cdp({ host, port, target: target.id }));
      try {
        candidate = await withDeadline(socketPromise, limits.connect, 'CDP socket connection');
      } catch (err) {
        // Promise.race cannot cancel the underlying CDP connection. If its own
        // deadline won, dispose a client that arrives after this attempt failed.
        if (err instanceof CdpError && err.reason === 'cdp_timeout') {
          void socketPromise.then(lateClient => closeBounded(lateClient), () => {});
        }
        throw err;
      }
      assertCurrentAttempt(attemptEpoch, attemptGeneration);
      await withDeadline(candidate.Runtime.enable(), limits.setup, 'CDP Runtime.enable');
      assertCurrentAttempt(attemptEpoch, attemptGeneration);
      await withDeadline(candidate.Page.enable(), limits.setup, 'CDP Page.enable');
      assertCurrentAttempt(attemptEpoch, attemptGeneration);
      await withDeadline(candidate.DOM.enable(), limits.setup, 'CDP DOM.enable');
      assertCurrentAttempt(attemptEpoch, attemptGeneration);
    } catch (err) {
      await closeBounded(candidate);
      throw toCdpError(err, 'CDP connection');
    }

    cachedClient = candidate;
    cachedTargetInfo = target;
    attachInvalidationHandlers(candidate, attemptGeneration, String(target.id));
    return candidate;
  }

  async function connectForGeneration(operationGeneration, options = {}) {
    const expectedTargetId = expectedTargetIdFrom(options);
    assertCurrentGeneration(operationGeneration, 'CDP connection');
    if (cachedClient) {
      assertExpectedTarget(expectedTargetId);
      return cachedClient;
    }
    if (connectPromise && connectPromiseGeneration === operationGeneration) {
      try {
        const candidate = await withDeadline(connectPromise, limits.connect, 'CDP connection');
        assertCurrentGeneration(operationGeneration, 'CDP connection');
        assertExpectedTarget(expectedTargetId);
        return candidate;
      } catch (err) {
        assertCurrentGeneration(operationGeneration, 'CDP connection');
        throw toCdpError(err, 'CDP connection');
      }
    }

    const attemptEpoch = ++epoch;
    const pending = connectOnce(attemptEpoch, operationGeneration, expectedTargetId);
    connectPromise = pending;
    connectPromiseGeneration = operationGeneration;
    try {
      const candidate = await withDeadline(pending, limits.connect, 'CDP connection');
      assertCurrentGeneration(operationGeneration, 'CDP connection');
      assertExpectedTarget(expectedTargetId);
      return candidate;
    } catch (err) {
      if (attemptEpoch === epoch) epoch++;
      assertCurrentGeneration(operationGeneration, 'CDP connection');
      throw toCdpError(err, 'CDP connection');
    } finally {
      if (connectPromise === pending) {
        connectPromise = null;
        connectPromiseGeneration = null;
      }
    }
  }

  async function connect(options = {}) {
    const operationGeneration = teardownGeneration;
    return connectForGeneration(operationGeneration, options);
  }

  async function reconnectForGeneration(reason, operationGeneration, options = {}) {
    const expectedTargetId = expectedTargetIdFrom(options);
    assertCurrentGeneration(operationGeneration, `CDP reconnect (${reason})`);
    if (reason === 'layout_navigation' && cachedClient && autoRecoveredClient === cachedClient) {
      assertExpectedTarget(expectedTargetId, `CDP reconnect (${reason})`);
      const recovered = cachedClient;
      autoRecoveredClient = null;
      return recovered;
    }
    const previous = cachedClient;
    if (previous) await invalidate(previous);
    try {
      assertCurrentGeneration(operationGeneration, `CDP reconnect (${reason})`);
      return await connectForGeneration(operationGeneration, { expectedTargetId });
    } catch (err) {
      throw toCdpError(err, `CDP reconnect (${reason})`);
    }
  }

  async function reconnect(reason = 'target_replaced', options = {}) {
    if (reason && typeof reason === 'object') {
      options = reason;
      reason = 'target_replaced';
    }
    const operationGeneration = teardownGeneration;
    return reconnectForGeneration(reason, operationGeneration, options);
  }

  async function getClientForGeneration(operationGeneration, options = {}) {
    const requestedTargetId = expectedTargetIdFrom(options);
    assertCurrentGeneration(operationGeneration, 'CDP getClient');
    if (!cachedClient) return connectForGeneration(operationGeneration, { expectedTargetId: requestedTargetId });
    assertExpectedTarget(requestedTargetId, 'CDP getClient');
    const candidate = cachedClient;
    const candidateTargetId = cachedTargetInfo?.id || requestedTargetId;
    try {
      await withDeadline(
        candidate.Runtime.evaluate({ expression: '1', returnByValue: true }),
        limits.liveness,
        'CDP liveness Runtime.evaluate',
      );
      assertCurrentGeneration(operationGeneration, 'CDP getClient');
      if (cachedClient !== candidate) {
        throw new CdpError('target_replaced', 'CDP client changed during liveness check');
      }
      return candidate;
    } catch (err) {
      assertCurrentGeneration(operationGeneration, 'CDP getClient');
      const failure = toCdpError(err, 'CDP liveness Runtime.evaluate');
      await invalidate(candidate);
      if (!RECOVERABLE_REASONS.has(failure.reason)) throw failure;
      assertCurrentGeneration(operationGeneration, 'CDP getClient');
      return connectForGeneration(operationGeneration, { expectedTargetId: candidateTargetId });
    }
  }

  async function getClient(options = {}) {
    const operationGeneration = teardownGeneration;
    return getClientForGeneration(operationGeneration, options);
  }

  async function runEvaluation(candidate, expression, protocolOpts, timeoutMs) {
    return withDeadline(
      candidate.Runtime.evaluate({
        ...protocolOpts,
        expression,
        returnByValue: protocolOpts.returnByValue ?? true,
        awaitPromise: protocolOpts.awaitPromise ?? false,
      }),
      timeoutMs,
      'CDP Runtime.evaluate',
    );
  }

  async function evaluate(expression, opts = {}) {
    const operationGeneration = teardownGeneration;
    const {
      timeoutMs = limits.evaluate,
      retry = false,
      expectedTargetId,
      preferredTargetId,
      expected_target_id,
      preferred_target_id,
      ...protocolOpts
    } = opts;
    const requestedTargetId = expectedTargetIdFrom({
      expectedTargetId,
      preferredTargetId,
      expected_target_id,
      preferred_target_id,
    });
    // These are manager-owned even if supplied through an object spread.
    delete protocolOpts.retry;

    let candidate = cachedClient || await connectForGeneration(operationGeneration, { expectedTargetId: requestedTargetId });
    assertExpectedTarget(requestedTargetId, 'CDP Runtime.evaluate');
    const candidateTargetId = cachedTargetInfo?.id || requestedTargetId;
    assertCurrentGeneration(operationGeneration, 'CDP Runtime.evaluate');
    let response;
    try {
      response = await runEvaluation(candidate, expression, protocolOpts, timeoutMs);
      assertCurrentGeneration(operationGeneration, 'CDP Runtime.evaluate');
    } catch (err) {
      assertCurrentGeneration(operationGeneration, 'CDP Runtime.evaluate');
      const failure = toCdpError(err, 'CDP Runtime.evaluate', { outcomeUnknown: !retry });
      if (!RECOVERABLE_REASONS.has(failure.reason)) throw failure;

      await invalidate(candidate);
      assertCurrentGeneration(operationGeneration, 'CDP Runtime.evaluate recovery');
      let reconnectFailure = null;
      try {
        candidate = await connectForGeneration(operationGeneration, { expectedTargetId: candidateTargetId }); // Exactly one bounded rediscovery/reconnect.
      } catch (connectErr) {
        assertCurrentGeneration(operationGeneration, 'CDP Runtime.evaluate recovery');
        reconnectFailure = toCdpError(connectErr, 'CDP Runtime.evaluate reconnect');
      }
      if (!retry) {
        const uncertain = new CdpError(failure.reason, failure.message, {
          cause: failure,
          outcomeUnknown: true,
        });
        uncertain.transport_reconnect_attempted = true;
        uncertain.transport_reconnected = !reconnectFailure;
        if (reconnectFailure) uncertain.reconnect_error = reconnectFailure.message;
        throw uncertain;
      }
      if (reconnectFailure) throw reconnectFailure;

      try {
        response = await runEvaluation(candidate, expression, protocolOpts, timeoutMs);
        assertCurrentGeneration(operationGeneration, 'CDP Runtime.evaluate retry');
      } catch (retryErr) {
        assertCurrentGeneration(operationGeneration, 'CDP Runtime.evaluate retry');
        const retryFailure = toCdpError(retryErr, 'CDP Runtime.evaluate retry');
        if (RECOVERABLE_REASONS.has(retryFailure.reason)) await invalidate(candidate);
        throw retryFailure;
      }
    }

    if (response.exceptionDetails) {
      const message = response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || 'Unknown evaluation error';
      throw new CdpError('evaluation_failed', `JS evaluation error: ${message}`);
    }
    return response.result?.value;
  }

  async function evaluateAsync(expression, opts = {}) {
    return evaluate(expression, { ...opts, awaitPromise: true });
  }

  async function getTargetInfo(options = {}) {
    const expectedTargetId = expectedTargetIdFrom(options);
    const operationGeneration = teardownGeneration;
    if (!cachedTargetInfo) await getClientForGeneration(operationGeneration, { expectedTargetId });
    assertCurrentGeneration(operationGeneration, 'CDP getTargetInfo');
    assertExpectedTarget(expectedTargetId, 'CDP getTargetInfo');
    return cachedTargetInfo;
  }

  async function disconnect() {
    teardownGeneration++;
    const candidate = cachedClient;
    if (candidate) await invalidate(candidate);
    else {
      cachedTargetInfo = null;
      epoch++;
    }
  }

  return {
    getClient,
    connect,
    reconnect,
    getTargetInfo,
    evaluate,
    evaluateAsync,
    disconnect,
    invalidateClient: invalidate,
    // Deliberately limited test visibility; no production caller should depend on it.
    _debugState: () => ({ hasClient: !!cachedClient, targetInfo: cachedTargetInfo, epoch, teardownGeneration }),
  };
}

const manager = createConnectionManager();

export async function getClient(options) { return manager.getClient(options); }
export async function connect(options) { return manager.connect(options); }
export async function reconnect(reason, options) { return manager.reconnect(reason, options); }
export async function getTargetInfo(options) { return manager.getTargetInfo(options); }
export async function evaluate(expression, opts) { return manager.evaluate(expression, opts); }
export async function evaluateAsync(expression, opts) { return manager.evaluateAsync(expression, opts); }
export async function disconnect() { return manager.disconnect(); }
export async function invalidateClient(candidate) { return manager.invalidateClient(candidate); }

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`, { retry: true });
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
