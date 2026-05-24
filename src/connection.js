import CDP from 'chrome-remote-interface';
import { AsyncLocalStorage } from 'node:async_hooks';

const clients = new Map();
const targetInfos = new Map();
let activeTargetId = null;
const targetContext = new AsyncLocalStorage();
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

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
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

function currentTargetId(explicitTargetId) {
  return explicitTargetId || targetContext.getStore()?.targetId || activeTargetId;
}

export function targetDeps(targetId) {
  return {
    evaluate: (expression, opts = {}) => evaluate(expression, { ...opts, targetId }),
    evaluateAsync: (expression, opts = {}) => evaluate(expression, { ...opts, awaitPromise: true, targetId }),
    getClient: () => getClient({ targetId }),
  };
}

export async function withTarget(targetId, fn) {
  if (!targetId) return fn();
  return targetContext.run({ targetId }, fn);
}

export async function getClient({ targetId } = {}) {
  const resolvedTargetId = currentTargetId(targetId);
  const existing = resolvedTargetId ? clients.get(resolvedTargetId) : null;
  if (existing) {
    try {
      // Quick liveness check
      await existing.Runtime.evaluate({ expression: '1', returnByValue: true });
      return existing;
    } catch {
      clients.delete(resolvedTargetId);
      targetInfos.delete(resolvedTargetId);
      if (activeTargetId === resolvedTargetId) activeTargetId = null;
    }
  }

  if (!resolvedTargetId) {
    const firstExisting = clients.get(activeTargetId);
    if (firstExisting) {
      try {
        await firstExisting.Runtime.evaluate({ expression: '1', returnByValue: true });
        return firstExisting;
      } catch {
        clients.delete(activeTargetId);
        targetInfos.delete(activeTargetId);
        activeTargetId = null;
      }
    }
  }

  // Per-command target (from withTarget) must not change the global default.
  // Only an explicit switchTarget() should activate.
  const fromContext = !!targetContext.getStore()?.targetId;
  return connect({ targetId: resolvedTargetId, activate: !fromContext });
}

export async function connect({ targetId, activate = true } = {}) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = targetId ? await findTargetById(targetId) : await findChartTarget();
      if (!target) {
        throw new Error(targetId
          ? `No CDP target found for id: ${targetId}`
          : 'No TradingView chart target found. Is TradingView open with a chart?');
      }

      const existing = clients.get(target.id);
      if (existing) {
        try {
          await existing.Runtime.evaluate({ expression: '1', returnByValue: true });
          if (activate) activeTargetId = target.id;
          targetInfos.set(target.id, target);
          return existing;
        } catch {
          try { await existing.close(); } catch {}
          clients.delete(target.id);
          targetInfos.delete(target.id);
        }
      }

      const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      clients.set(target.id, client);
      targetInfos.set(target.id, target);
      if (activate) activeTargetId = target.id;

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

export async function listTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const contextTargetId = currentTargetId();
  return targets.map((t, i) => ({
    index: i,
    id: t.id,
    type: t.type,
    title: t.title || '',
    url: t.url || '',
    chart_id: t.url?.match(/\/chart\/([^/?]+)/)?.[1] || null,
    is_chart: t.type === 'page' && /tradingview\.com\/chart/i.test(t.url || ''),
    is_tradingview: /tradingview/i.test(`${t.title || ''} ${t.url || ''}`),
    connected: contextTargetId === t.id,
    has_client: clients.has(t.id),
  }));
}

async function findTargetById(targetId) {
  const targets = await listTargets();
  return targets.find(t => t.id === targetId) || null;
}

async function findChartTarget() {
  const targets = await listTargets();
  // Prefer targets with tradingview.com/chart in the URL
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

export async function switchTarget(targetId) {
  if (!targetId) throw new Error('target_id is required');
  const c = await connect({ targetId });
  return { client: c, target: targetInfos.get(targetId) };
}

export async function getTargetInfo({ targetId } = {}) {
  const resolvedTargetId = currentTargetId(targetId);
  if (resolvedTargetId && targetInfos.has(resolvedTargetId)) {
    return targetInfos.get(resolvedTargetId);
  }
  await getClient({ targetId: resolvedTargetId });
  const current = currentTargetId(resolvedTargetId);
  return current ? targetInfos.get(current) : null;
}

export async function evaluate(expression, opts = {}) {
  const { targetId, ...runtimeOpts } = opts;
  const c = await getClient({ targetId });
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: runtimeOpts.awaitPromise ?? false,
    ...runtimeOpts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression, opts = {}) {
  return evaluate(expression, { ...opts, awaitPromise: true });
}

export async function disconnect({ targetId } = {}) {
  if (targetId) {
    const client = clients.get(targetId);
    if (client) try { await client.close(); } catch {}
    clients.delete(targetId);
    targetInfos.delete(targetId);
    if (activeTargetId === targetId) activeTargetId = null;
    return;
  }
  for (const c of clients.values()) {
    try { await c.close(); } catch {}
  }
  clients.clear();
  targetInfos.clear();
  activeTargetId = null;
}

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
