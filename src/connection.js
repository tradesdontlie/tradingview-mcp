import CDP from 'chrome-remote-interface';
import { getSessionContext, hasSessionContext } from './session-context.js';
// Overridable via TV_CDP_HOST/TV_CDP_PORT (or CDP_HOST/CDP_PORT) env vars.
// Default is 127.0.0.1, not localhost: on some Windows machines localhost
// resolves to ::1 first, and Electron's --remote-debugging-port only listens on IPv4.
export const CDP_HOST = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
export const CDP_PORT = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9222;
const configuredTimeout = Number(process.env.TV_CDP_TIMEOUT_MS || 10000);
export const CDP_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout >= 100 && configuredTimeout <= 120000
  ? configuredTimeout : 10000;

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
  // Number() is a conversion, not a check. Number('') and Number([]) are 0,
  // Number([5]) is 5, Number(true) is 1 — so an empty string, an array or a
  // boolean becomes a valid-looking number instead of an error, while 'abc'
  // and undefined are rejected. Callers use the returned value, so the result
  // is a silently wrong coordinate rather than a failure: an alert created at
  // price 0 instead of a complaint about the price.
  //
  // null is left coercing to 0 on purpose. tests/sanitization.test.js pins
  // that, so it is a deliberate choice rather than an oversight.
  if (value === null) return 0;
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export function isChartTarget(target) {
  if (target?.type !== 'page') return false;
  try {
    const url = new URL(target.url);
    return url.protocol === 'https:' && (url.hostname === 'tradingview.com' || url.hostname.endsWith('.tradingview.com'))
      && /^\/chart(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

export async function hasChartApi(candidate) {
  const result = await candidate.Runtime.evaluate({
    expression: "Boolean(window.TradingViewApi?._activeChartWidgetWV?.value()?.symbolExt)", returnByValue: true,
  });
  return !result.exceptionDetails && result.result?.value === true;
}

export function withCdpDeadline(operation, duration, label, onTimeout) {
    let timer;
    const expiry = new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        const error = new Error(`CDP ${label} timed out after ${Math.ceil(duration)}ms; no command retry was performed`);
        error.code = 'CDP_TIMEOUT';
        reject(error);
      }, Math.max(1, duration));
    });
    return Promise.race([operation, expiry]).finally(() => clearTimeout(timer));
  }


const closingClients = new WeakMap();
export async function closeCdpClient(raw, timeoutMs = Math.min(CDP_TIMEOUT_MS, 1000)) {
  if (!raw) return;
  if (!closingClients.has(raw)) {
    const closing = withCdpDeadline(Promise.resolve().then(() => raw.close()), timeoutMs, 'close').catch(() => {});
    closingClients.set(raw, closing);
  }
  await closingClients.get(raw);
}

export async function openCdpClient(options, { cdp = CDP, timeoutMs = CDP_TIMEOUT_MS } = {}) {
  let expired = false;
  const opening = Promise.resolve().then(() => cdp(options));
  opening.then(raw => { if (expired) void closeCdpClient(raw, Math.min(timeoutMs, 1000)); }, () => {});
  try { return await withCdpDeadline(opening, timeoutMs, 'connect', () => { expired = true; }); }
  catch (error) { expired = true; throw error; }
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * A session owns its selected chart and its connection. All transport/CDP work
 * has a deadline. Failed or timed-out commands are never replayed: the page may
 * already have performed the operation even though its response was lost.
 * Dependency injection is for deterministic fake-CDP tests, not runtime tools.
 */
export function createConnectionRuntime({
  cdp = CDP, fetch: fetchFn = globalThis.fetch, host = CDP_HOST, port = CDP_PORT,
  timeoutMs = CDP_TIMEOUT_MS, closeTimeoutMs = Math.min(timeoutMs, 1000),
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0) {
    throw new Error('CDP deadlines must be positive finite milliseconds');
  }
  const states = new Map();

  const stateFor = (session = getSessionContext()) => {
    if (session.closed) throw new Error('MCP session is closed');
    if (!states.has(session)) states.set(session, { session, generation: 0, raw: null, client: null, targetInfo: null, connecting: null });
    return states.get(session);
  };

  const deadline = withCdpDeadline;

  const closeRaw = raw => closeCdpClient(raw, closeTimeoutMs);

  async function invalidate(state) {
    state.generation++;
    const raw = state.raw;
    state.raw = null;
    state.client = null;
    state.targetInfo = null;
    state.connecting = null;
    await closeRaw(raw);
  }

  async function discover() {
    const controller = new AbortController();
    try {
      return await deadline((async () => {
        const response = await fetchFn(`http://${host}:${port}/json/list`, { signal: controller.signal });
        if (response.ok === false) throw new Error(`CDP target discovery returned HTTP ${response.status}`);
        const targets = await response.json();
        if (!Array.isArray(targets)) throw new Error('CDP target discovery returned an invalid target list');
        return targets.filter(isChartTarget);
      })(), timeoutMs, 'target discovery', () => controller.abort());
    } finally { controller.abort(); }
  }

  function boundClient(raw, state, generation) {
    const domains = new Map();
    const wrap = (object, prefix = '') => new Proxy(object, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof property === 'symbol' || property === 'then') return value;
        if (typeof value === 'function') {
          if (['on', 'once', 'addListener', 'prependListener', 'prependOnceListener', 'removeListener', 'removeAllListeners', 'off', 'emit', 'listenerCount', 'listeners', 'rawListeners', 'eventNames', 'setMaxListeners', 'getMaxListeners'].includes(property)) return value.bind(target);
          if (!prefix && property === 'close') return () => state.generation === generation ? invalidate(state) : closeRaw(raw);
          return async (...args) => {
            if (state.generation !== generation || state.raw !== raw || state.session.closed) throw new Error('CDP connection is stale; select/reconnect before another command');
            try {
              return await deadline(Promise.resolve().then(() => Reflect.apply(value, target, args)), timeoutMs, `${prefix}${String(property)}`);
            } catch (value) {
              const error = asError(value);
              error.command_may_have_executed = true;
              if (state.generation === generation) await invalidate(state);
              throw error;
            }
          };
        }
        if (value && typeof value === 'object') {
          if (!domains.has(property)) domains.set(property, wrap(value, `${String(property)}.`));
          return domains.get(property);
        }
        return value;
      },
    });
    return wrap(raw);
  }

  async function connect(targetId = null) {
    const state = stateFor();
    if (targetId !== null) {
      if (typeof targetId !== 'string' || !targetId.trim()) throw new Error('target_id must be a non-empty opaque ID');
      if (state.session.selectedTargetId !== targetId) {
        await invalidate(state);
        state.session.selectedTargetId = targetId;
      }
    }
    if (state.connecting) return state.connecting;
    if (state.raw) await invalidate(state);
    const generation = ++state.generation;
    let candidate;
    const current = () => {
      if (state.generation !== generation || state.session.closed) throw new Error('CDP connection attempt was superseded or its session closed');
    };
    const attempt = (async () => {
      const endsAt = Date.now() + timeoutMs;
      const bounded = (operation, label) => deadline(operation, Math.max(1, endsAt - Date.now()), label);
      try {
        const targets = await bounded(discover(), 'connection discovery');
        current();
        const selected = state.session.selectedTargetId;
        if (!selected && targets.length > 1) throw new Error('Multiple TradingView charts are open. Use target_list then target_select with an exact target_id.');
        const target = selected ? targets.find(t => t.id === selected) : targets[0];
        if (!target) throw new Error(selected
          ? `Selected CDP target ${selected} is unavailable; no fallback to another chart was performed`
          : 'No TradingView chart target found. Is TradingView open with a chart?');
        // Pin even an automatically selected single chart before connection. A
        // later tab/window must never become an implicit replacement target.
        state.session.selectedTargetId = target.id;
        const opening = Promise.resolve().then(() => cdp({ host, port, target: target.id }));
        opening.then(raw => {
          if (state.generation !== generation || state.session.closed) void closeRaw(raw);
        }, () => {});
        candidate = await bounded(opening, 'connect');
        current();
        await bounded(Promise.all([candidate.Runtime.enable(), candidate.Page.enable(), candidate.DOM.enable()]), 'domain setup');
        current();
        if (!await bounded(hasChartApi(candidate), 'chart API readiness')) throw new Error('Chart API is not ready on selected target');
        current();
        state.raw = candidate;
        state.client = boundClient(candidate, state, generation);
        state.targetInfo = target;
        candidate.on?.('disconnect', () => {
          if (state.generation === generation) void invalidate(state);
        });
        return state.client;
      } catch (error) {
        if (state.generation === generation) await invalidate(state);
        await closeRaw(candidate);
        throw error;
      }
    })();
    state.connecting = attempt;
    try { return await attempt; }
    finally { if (state.connecting === attempt) state.connecting = null; }
  }

  async function getClient() {
    const state = stateFor();
    if (state.raw) {
      const generation = state.generation;
      const raw = state.raw;
      try {
        if (!await deadline(hasChartApi(raw), timeoutMs, 'cached chart API readiness')) throw new Error('Chart API is not ready');
        if (state.generation !== generation || state.raw !== raw) throw new Error('CDP readiness check was superseded');
        return state.client;
      } catch (error) {
        if (state.generation !== generation) throw error;
        await invalidate(state);
      }
    }
    return connect();
  }

  async function evaluate(expression, opts = {}) {
    // The local bound covers readiness/reconnect AND command execution. Expiry
    // fences pending connection work, so it cannot later publish a client or
    // dispatch the requested expression after the caller already timed out.
    const { timeoutMs: requestedTimeout = timeoutMs, ...protocolOptions } = opts;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) throw new Error('Evaluation timeoutMs must be positive finite milliseconds');
    const state = stateFor();
    let expired = false;
    let commandStarted = false;
    const operation = (async () => {
      const client = await getClient();
      if (expired) throw new Error('CDP evaluation deadline expired before dispatch');
      commandStarted = true;
      return client.Runtime.evaluate({
        expression, returnByValue: true, awaitPromise: protocolOptions.awaitPromise ?? false, ...protocolOptions,
      });
    })();
    let result;
    try {
      result = await deadline(operation, Math.min(requestedTimeout, timeoutMs), 'evaluation', () => {
        expired = true;
        void invalidate(state);
      });
    } catch (value) {
      const error = asError(value);
      if (commandStarted) error.command_may_have_executed = true;
      throw error;
    }
    if (result.exceptionDetails) {
      const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Unknown evaluation error';
      throw new Error(`JS evaluation error: ${message}`);
    }
    return result.result?.value;
  }

  async function listTargets() {
    const targets = await discover();
    const selected = getSessionContext().selectedTargetId;
    return { success: true, selected_target_id: selected, targets: targets.map(t => ({
      id: t.id, title: t.title || '', url: t.url, selected: t.id === selected,
    })) };
  }

  async function selectTarget(targetId) {
    const state = stateFor();
    if (typeof targetId !== 'string' || !targetId.trim()) throw new Error('target_id must be a non-empty opaque ID');
    const targets = await discover();
    if (!targets.some(t => t.id === targetId)) throw new Error(`Chart target ${targetId} is unavailable; use an exact ID from target_list`);
    await invalidate(state);
    state.session.selectedTargetId = targetId;
    await connect();
    return { success: true, selected_target_id: targetId, target: state.targetInfo };
  }

  async function disconnect() {
    const sessions = hasSessionContext() ? [getSessionContext()] : [...states.keys()];
    await Promise.all(sessions.map(async session => {
      const state = states.get(session);
      if (state) { await invalidate(state); states.delete(session); }
    }));
  }

  async function disposeSession(session) {
    session.closed = true;
    const state = states.get(session);
    if (state) { await invalidate(state); states.delete(session); }
  }

  return {
    connect, getClient, evaluate,
    evaluateAsync: (expression, opts = {}) => evaluate(expression, { ...opts, awaitPromise: true }),
    reconnectTo: async targetId => {
      const state = stateFor();
      await invalidate(state);
      state.session.selectedTargetId = targetId;
      return connect(targetId);
    },
    getTargetInfo: async () => { await getClient(); return stateFor().targetInfo; },
    listTargets, selectTarget, disconnect, disposeSession,
  };
}

const runtime = createConnectionRuntime();
export const { connect, getClient, evaluate, evaluateAsync, reconnectTo, getTargetInfo, listTargets, selectTarget, disconnect, disposeSession } = runtime;

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
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
