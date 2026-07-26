import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
// Set when the caller pinned a specific tab via reconnectTo (tab_switch), so
// recovery from a dead client returns to that tab instead of re-picking the
// first chart tab findChartTarget() happens to see.
let pinnedTargetId = null;
// Overridable via TV_CDP_HOST/TV_CDP_PORT (or CDP_HOST/CDP_PORT) env vars.
// Default is 127.0.0.1, not localhost: on some Windows machines localhost
// resolves to ::1 first, and Electron's --remote-debugging-port only listens on IPv4.
export const CDP_HOST = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
export const CDP_PORT = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9222;
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

export async function getClient() {
  if (client) {
    try {
      // A pinned tab (tab_switch) only needs to be alive. Both of today's
      // reconnectTo() callers pin chart tabs, so this is defensive: the
      // function is exported and takes any target id, and a non-chart pin
      // would fail the strict probe below and be silently dropped.
      const expression = pinnedTargetId
        ? '1'
        // Strict liveness for auto-picked tabs: must be alive AND expose chart
        // APIs. Plain `Runtime.evaluate('1')` passes on any TradingView page
        // (news-flow, watchlist, symbols) and used to lock the picker to
        // whichever tab was attached first — silently breaking every
        // chart-API tool when a chart tab opened later.
        : 'typeof window.TradingViewApi !== "undefined" && window.TradingViewApi._activeChartWidgetWV !== undefined';
      const probe = await client.Runtime.evaluate({ expression, returnByValue: true });
      if (pinnedTargetId || probe?.result?.value === true) return client;
    } catch {}
    client = null;
    targetInfo = null;
  }
  // Reconnect to the pinned tab if there is one, so a dead-client recovery does
  // not silently migrate the session back to an auto-picked chart tab.
  return connect(pinnedTargetId);
}

export async function connect(targetId = null) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = targetId ? await findTargetById(targetId) : await findChartTarget();
      // findChartTarget now throws explicit errors with actionable hints (no
      // chart tab vs no TV at all), so only findTargetById can still return null.
      if (targetId && !target) {
        // Drop the pin so a closed tab does not wedge every later call on a
        // target that no longer exists; the next call auto-picks a chart tab.
        pinnedTargetId = null;
        throw new Error(`CDP target ${targetId} not found — is the tab still open?`);
      }
      pinnedTargetId = targetId;
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
      // Don't retry actionable user-facing errors; they won't fix themselves
      // by waiting (need user to open a chart tab).
      if (err.message && /No TradingView chart tab found/.test(err.message)) {
        throw err;
      }
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

/**
 * Re-attach the cached CDP client to a specific target id.
 * Used by tab_switch so subsequent reads (chart_get_state, data_get_*,
 * quote_get, screenshots) follow the activated tab instead of staying
 * glued to the target picked at first connect.
 */
export async function reconnectTo(targetId) {
  if (client) {
    try { await client.close(); } catch { /* already gone */ }
    client = null;
    targetInfo = null;
  }
  return connect(targetId);
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  // Strict: only attach to actual chart tabs. Previously fell back to any
  // tradingview tab (news-flow, watchlist, symbols pages) which silently
  // broke every chart-API tool because _activeChartWidgetWV was undefined.
  const chart = targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  if (chart) return chart;
  const otherTV = targets.filter(t => t.type === 'page' && /tradingview/i.test(t.url));
  if (otherTV.length > 0) {
    const paths = otherTV.slice(0, 3).map(t => {
      try { return new URL(t.url).pathname; } catch { return t.url; }
    });
    throw new Error(
      `No TradingView chart tab found. Detected ${otherTV.length} non-chart ` +
      `TradingView tab(s): ${paths.join(', ')}. Open a chart in TV Desktop ` +
      `(Cmd+T then a ticker, or click a saved layout) and retry.`
    );
  }
  throw new Error(
    'No TradingView chart target found. Is TradingView open with a chart? ' +
    'Launch with: /Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222'
  );
}

async function findTargetById(id) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.find(t => t.id === id) || null;
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
    client = null;
    targetInfo = null;
  }
  // An explicit disconnect ends the session, so the tab_switch pin ends with it.
  pinnedTargetId = null;
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
