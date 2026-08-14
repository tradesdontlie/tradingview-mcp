import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
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
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
    } catch {
      client = null;
      targetInfo = null;
      return connect();
    }

    // Liveness alone isn't enough: with multiple chart tabs open, the cached
    // target can still be a live but backgrounded tab (stale state/screenshots)
    // if the user switched tabs outside of tab_switch. TradingView Desktop's
    // custom tab bar doesn't drive document.visibilityState/hasFocus() per tab
    // (every tab reports hidden/unfocused regardless of which is on screen —
    // confirmed by direct probing), so visibility APIs can't tell us which tab
    // is actually shown. Compare layout names instead: read which tab is
    // .active in the shell's tab bar, and if that differs from what the cached
    // target itself is displaying, find and follow the matching one.
    try {
      const shellActiveName = await getShellActiveLayoutName();
      if (shellActiveName) {
        const cachedName = await readLayoutName(client);
        if (cachedName && cachedName === shellActiveName) return client;

        const match = await findTargetByLayoutName(shellActiveName);
        if (match && match.id !== targetInfo?.id) {
          return reconnectTo(match.id);
        }
      }
    } catch {
      // Best-effort — fall through and keep using the cached client rather
      // than breaking a previously-working connection over this.
    }
    return client;
  }
  return connect();
}

// Reads the layout name TradingView itself is currently rendering in the
// save/load toolbar button, e.g. "Daily Set Up - Crypto". The primary
// selector targets today's (hashed, build-specific) class name; the fallback
// scans buttons for the "<name>Save" pattern that button renders as, so a
// TradingView UI update that changes the hash doesn't silently break this.
const READ_LAYOUT_NAME_EXPR = `
  (function() {
    var el = document.querySelector('span[class*="text-OjWQ1m5F"]');
    if (el && el.textContent.trim()) return el.textContent.trim();
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim();
      if (/Save$/.test(t) && t.length > 4) return t.replace(/Save$/, '').trim();
    }
    return null;
  })()
`;

async function readLayoutName(cdpClient) {
  const { result } = await cdpClient.Runtime.evaluate({ expression: READ_LAYOUT_NAME_EXPR, returnByValue: true });
  return result?.value || null;
}

/**
 * Read the layout name of whichever tab is .active in the Electron shell's
 * tab bar (the top tab strip, not the chart page itself).
 */
async function getShellActiveLayoutName() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const shells = targets.filter(t => t.type === 'page' && /\/window\/index\.html/i.test(t.url || ''));

  for (const s of shells) {
    let c;
    try {
      c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: s.id });
      const probe = await c.Runtime.evaluate({
        expression: `!!document.querySelector('.tabs-container .tab')`, returnByValue: true,
      });
      if (!probe.result?.value) continue;

      const { result } = await c.Runtime.evaluate({
        expression: `
          (function() {
            var active = document.querySelector('.tabs-container .tab.active');
            if (!active) return null;
            var nameEl = active.querySelector('[class*="layout-name"]');
            var text = nameEl ? nameEl.textContent : '';
            return text.replace(/^\\s*\\/\\s*/, '').trim() || null;
          })()
        `,
        returnByValue: true,
      });
      if (result?.value) return result.value;
    } catch {
      // This target wasn't the shell (or closed mid-probe) — try the next one.
    } finally {
      try { if (c) await c.close(); } catch { /* already gone */ }
    }
  }
  return null;
}

/** Find the open chart tab whose own rendered layout name matches `name`. */
async function findTargetByLayoutName(name) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const chartTargets = targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

  for (const t of chartTargets) {
    let c;
    try {
      c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: t.id });
      const layoutName = await readLayoutName(c);
      if (layoutName === name) return t;
    } catch {
      // Target may have closed mid-probe or not be ready yet — skip it.
    } finally {
      try { if (c) await c.close(); } catch { /* already gone */ }
    }
  }
  return null;
}

export async function connect(targetId = null) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = targetId ? await findTargetById(targetId) : await findChartTarget();
      if (!target) {
        throw new Error(targetId
          ? `CDP target ${targetId} not found — is the tab still open?`
          : 'No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
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
  const chartTargets = targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

  if (chartTargets.length > 1) {
    try {
      const shellActiveName = await getShellActiveLayoutName();
      if (shellActiveName) {
        const match = await findTargetByLayoutName(shellActiveName);
        if (match) return match;
      }
    } catch {
      // Fall through to "just pick the first one" below.
    }
  }

  return chartTargets[0]
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

async function findTargetById(id) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.find(t => t.id === id) || null;
}

export async function getTargetInfo() {
  // Always run getClient(), not just when nothing is cached yet — it's the
  // one that re-checks whether the cached target is still the tab actually
  // on screen and follows the user if it isn't. Skipping that check here
  // left tv_health_check reporting a stale target after a tab switch even
  // though evaluate()-based tools (which always call getClient()) had
  // already followed it correctly.
  await getClient();
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
