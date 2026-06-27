import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
let lastProbeAt = 0;
export const CDP_HOST = 'localhost';
export const CDP_PORT = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;
// Bound total connection wait so the system fails reasonably fast when TV is down,
// rather than only capping each individual backoff delay.
const MAX_TOTAL_WAIT = 10000;
// Skip the getClient() liveness probe if it succeeded within this window.
const PROBE_INTERVAL = 1000;

/**
 * True if an error message looks like a transport / connection-reset drop
 * (as opposed to a real JS exception from the evaluated page code).
 * Used to decide whether evaluate() should reconnect and retry once.
 */
export function isConnectionResetError(msg) {
  return /ECONNRESET|socket hang up|Target closed|WebSocket is not open|Session closed/i.test(
    String(msg || ''),
  );
}

/**
 * Fetch a URL with a bounded deadline via AbortController.
 * Aborts (and rejects) if the response does not arrive within `ms`.
 * The timer is always cleared in finally so it never leaks.
 */
export async function fetchWithTimeout(url, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved.
  // Overridable via PINE_FACADE_URL for air-gapped / proxied setups (trailing slash trimmed).
  pineFacadeApi: (process.env.PINE_FACADE_URL || 'https://pine-facade.tradingview.com/pine-facade').replace(/\/+$/, ''),
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
 * Parse a caller-supplied JSON string defensively. If `raw` is already an object
 * it is returned as-is; if it is a string it is JSON.parsed inside a try/catch so a
 * malformed payload yields a friendly Error (with a short preview of the bad input)
 * instead of a raw SyntaxError propagating uncaught. `label` names the field
 * (e.g. "inputs", "overrides") in the error message.
 */
export function parseJsonArg(raw, label = 'value') {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    const preview = raw.length > 50 ? raw.slice(0, 50) + '…' : raw;
    throw new Error(`${label} must be valid JSON; got: ${preview}`);
  }
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

export async function getClient() {
  if (client) {
    // Throttle the liveness probe: a healthy connection used in rapid succession
    // should not pay a CDP round-trip on every call.
    if (Date.now() - lastProbeAt < PROBE_INTERVAL) {
      return client;
    }
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      lastProbeAt = Date.now();
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  const startedAt = Date.now();
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      lastProbeAt = Date.now();
      return client;
    } catch (err) {
      lastError = err;
      const elapsed = Date.now() - startedAt;
      if (elapsed >= MAX_TOTAL_WAIT) break;
      // Exponential backoff, but never sleep past the total wait budget.
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000, MAX_TOTAL_WAIT - elapsed);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// Indirection so the evaluate() reconnect path can be overridden in unit tests
// without a live CDP attach. Defaults to the real connect().
let connectImpl = connect;

async function findChartTarget() {
  const resp = await fetchWithTimeout(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  // Prefer targets with tradingview.com/chart in the URL
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

async function runEvaluate(c, expression, opts) {
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
    // A real page-side JS exception — do NOT treat as a transient transport drop.
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  try {
    return await runEvaluate(c, expression, opts);
  } catch (err) {
    // Only self-heal on a connection-reset class transport error — never on a real
    // page-side JS exception (which runEvaluate prefixes with "JS evaluation error").
    if (!isConnectionResetError(err?.message)) throw err;
    // Drop the stale singleton, rebuild it, and retry exactly once.
    client = null;
    targetInfo = null;
    lastProbeAt = 0;
    const fresh = await connectImpl();
    return runEvaluate(fresh, expression, opts);
  }
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

/**
 * Attach the cached CDP session to a SPECIFIC target id, replacing any current
 * client. Used by tab switching so subsequent evaluate() calls run against the
 * newly activated tab rather than the previously bound target.
 * Closes the existing client first (via disconnect), then enables the required
 * Runtime/Page/DOM domains on the new attachment.
 */
export async function reconnect(targetId) {
  if (!targetId) {
    throw new Error('reconnect requires a target id');
  }
  await disconnect();
  client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });

  // Enable required domains
  await client.Runtime.enable();
  await client.Page.enable();
  await client.DOM.enable();

  targetInfo = { id: targetId };
  return client;
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

// --- Test-only seams ---
// These let offline unit tests exercise the singleton/retry logic without a live
// CDP attach. They are not part of the public API and should not be used elsewhere.

/** Seed the cached client and reset the liveness-probe throttle. */
export function __setClientForTest(c) {
  client = c;
  targetInfo = c ? { id: 'test-target' } : null;
  // Force the next getClient() to skip the round-trip probe (treat as fresh).
  lastProbeAt = Date.now();
}

/** Override the reconnect path used by evaluate()'s single retry. Pass null to restore. */
export function __setConnectImplForTest(fn) {
  connectImpl = fn || connect;
}
