import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
let connectedEndpoint = null;
const DEFAULT_CDP_HOST = 'localhost';
const DEFAULT_CDP_PORT = 9222;
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

export function getCdpEndpoint() {
  const host = process.env.TV_CDP_HOST || process.env.CDP_HOST || DEFAULT_CDP_HOST;
  const rawPort = process.env.TV_CDP_PORT || process.env.CDP_PORT || String(DEFAULT_CDP_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`TV_CDP_PORT must be a valid TCP port, got: ${rawPort}`);
  }
  return { host, port };
}

export function getCdpHttpBase(endpoint = getCdpEndpoint()) {
  const host = endpoint.host.includes(':') && !endpoint.host.startsWith('[')
    ? `[${endpoint.host}]`
    : endpoint.host;
  return `http://${host}:${endpoint.port}`;
}

export function getChartIdFromUrl(url = '') {
  return String(url).match(/\/chart\/([^/?#]+)/)?.[1] || null;
}

export function getTargetSelector() {
  return {
    targetId: process.env.TV_TARGET_ID || process.env.CDP_TARGET_ID || '',
    chartId: process.env.TV_CHART_ID || '',
    urlMatch: process.env.TV_TARGET_URL_MATCH || '',
  };
}

function selectorDescription(selector) {
  const parts = [];
  if (selector.targetId) parts.push(`TV_TARGET_ID=${selector.targetId}`);
  if (selector.chartId) parts.push(`TV_CHART_ID=${selector.chartId}`);
  if (selector.urlMatch) parts.push(`TV_TARGET_URL_MATCH=${selector.urlMatch}`);
  return parts.join(', ');
}

export function selectChartTarget(targets, selector = {}) {
  const pages = (targets || []).filter(t => t.type === 'page');
  const chartPages = pages.filter(t => /tradingview\.com\/chart/i.test(t.url || ''));
  const tradingViewPages = pages.filter(t => /tradingview/i.test(t.url || '') || /tradingview/i.test(t.title || ''));

  if (selector.targetId) {
    return pages.find(t => t.id === selector.targetId) || null;
  }
  if (selector.chartId) {
    return chartPages.find(t => getChartIdFromUrl(t.url) === selector.chartId) || null;
  }
  if (selector.urlMatch) {
    return pages.find(t => String(t.url || '').includes(selector.urlMatch)) || null;
  }

  return chartPages[0] || tradingViewPages[0] || null;
}

export function hasTargetSelector(selector = getTargetSelector()) {
  return !!(selector.targetId || selector.chartId || selector.urlMatch);
}

export function targetMatchesSelector(target, selector) {
  if (!target) return false;
  if (selector.targetId) return target.id === selector.targetId;
  if (selector.chartId) return getChartIdFromUrl(target.url) === selector.chartId;
  if (selector.urlMatch) return String(target.url || '').includes(selector.urlMatch);
  return true;
}

function sameEndpoint(a, b) {
  return !!a && !!b && a.host === b.host && a.port === b.port;
}

export async function getClient() {
  if (client) {
    try {
      const endpoint = getCdpEndpoint();
      const selector = getTargetSelector();
      const currentTarget = await findCurrentTargetInfo(targetInfo?.id, endpoint);
      if (!sameEndpoint(connectedEndpoint, endpoint) || !targetMatchesSelector(currentTarget, selector)) {
        await disconnect();
        return connect();
      }
      targetInfo = currentTarget;
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch {
      client = null;
      targetInfo = null;
      connectedEndpoint = null;
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      const { host, port } = getCdpEndpoint();
      const nextClient = await CDP({ host, port, target: target.id });

      // Enable required domains
      try {
        await nextClient.Runtime.enable();
        await nextClient.Page.enable();
        await nextClient.DOM.enable();
      } catch (err) {
        try { await nextClient.close(); } catch {}
        throw err;
      }

      client = nextClient;
      targetInfo = target;
      connectedEndpoint = { host, port };
      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

async function findChartTarget() {
  const endpoint = getCdpEndpoint();
  const targets = await listTargets(endpoint);
  const selector = getTargetSelector();
  const target = selectChartTarget(targets, selector);
  if (!target && selectorDescription(selector)) {
    throw new Error(`No TradingView chart target found matching ${selectorDescription(selector)} on ${endpoint.host}:${endpoint.port}`);
  }
  return target;
}

async function listTargets(endpoint = getCdpEndpoint()) {
  const resp = await fetch(`${getCdpHttpBase(endpoint)}/json/list`);
  return resp.json();
}

async function findCurrentTargetInfo(targetId, endpoint = getCdpEndpoint()) {
  if (!targetId) return null;
  const targets = await listTargets(endpoint);
  return targets.find(t => t.id === targetId) || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
  }
  client = null;
  targetInfo = null;
  connectedEndpoint = null;
}

export async function reconnectToTarget(target) {
  await disconnect();
  const { host, port } = getCdpEndpoint();
  const nextClient = await CDP({ host, port, target: target.id });
  try {
    await nextClient.Runtime.enable();
    await nextClient.Page.enable();
    await nextClient.DOM.enable();
  } catch (err) {
    try { await nextClient.close(); } catch {}
    throw err;
  }
  client = nextClient;
  targetInfo = target;
  connectedEndpoint = { host, port };
  return nextClient;
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
