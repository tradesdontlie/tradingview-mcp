/**
 * Core UI automation logic.
 */
import { disconnect as disconnectClient, evaluate, evaluateAsync, getClient, getTargetInfo, reconnect as reconnectClient, safeString } from '../connection.js';

const LAYOUT_SWITCH_TIMEOUT_MS = 20000;
const LAYOUT_SNAPSHOT_TIMEOUT_MS = 5000;
const LAYOUT_POLL_INTERVAL_MS = 250;
const LAYOUT_STABLE_POLLS = 2;
const NATIVE_STEP_TIMEOUT_MS = 2500;

function resolveLayoutDeps(deps) {
  return {
    evaluate: deps?.evaluate || evaluate,
    evaluateAsync: deps?.evaluateAsync || evaluateAsync,
    getTargetInfo: deps?.getTargetInfo || getTargetInfo,
    reconnect: deps?.reconnect || reconnectClient,
    disconnect: deps?.disconnect || disconnectClient,
    now: deps?.now || Date.now,
    sleep: deps?.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))),
  };
}

function layoutFailure(reason, error, details = {}) {
  return { success: false, reason, error, verified: false, ...details };
}

function createLayoutDeadline(deps, timeoutMs) {
  const expiresAt = deps.now() + timeoutMs;
  let expired = false;

  function navigationTimeout(label) {
    const err = new Error(`${label} exceeded the overall layout deadline`);
    err.reason = 'navigation_timeout';
    return err;
  }

  function fence(label) {
    if (!expired) {
      expired = true;
      // disconnect() advances the shared transport teardown generation before
      // closing the client, fencing late evaluations/reconnects from this switch.
      void Promise.resolve().then(() => deps.disconnect()).catch(() => {});
    }
    throw navigationTimeout(label);
  }

  async function run(label, operation) {
    if (expired) throw navigationTimeout(label);
    const remaining = Math.floor(expiresAt - deps.now());
    if (remaining <= 0) return fence(label);

    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => operation(remaining)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { fence(label); } catch (err) { reject(err); }
          }, remaining);
        }),
      ]);
      if (deps.now() >= expiresAt) return fence(label);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    expiresAt,
    remaining: () => Math.max(0, Math.floor(expiresAt - deps.now())),
    run,
  };
}

function evaluateBeforeDeadline(deadline, deps, label, expression, options = {}) {
  const targetOptions = deps.expectedTargetId ? { expectedTargetId: deps.expectedTargetId } : {};
  return deadline.run(label, remaining => deps.evaluate(expression, { ...options, ...targetOptions, timeoutMs: remaining }));
}

function evaluateAsyncBeforeDeadline(deadline, deps, label, expression, options = {}) {
  const targetOptions = deps.expectedTargetId ? { expectedTargetId: deps.expectedTargetId } : {};
  return deadline.run(label, remaining => deps.evaluateAsync(expression, { ...options, ...targetOptions, timeoutMs: remaining }));
}

function sleepBeforeDeadline(deadline, deps, label, requestedMs) {
  return deadline.run(label, remaining => deps.sleep(Math.min(requestedMs, remaining)));
}

export async function click({ by, value }) {
  const escaped = JSON.stringify(value);
  const result = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${escaped};
      var el = null;
      if (by === 'aria-label') el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"]');
        for (var i = 0; i < candidates.length; i++) {
          var text = candidates[i].textContent.trim();
          if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; }
        }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return { found: false };
      el.click();
      return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 80), aria_label: el.getAttribute('aria-label') || null, data_name: el.getAttribute('data-name') || null };
    })()
  `);
  if (!result || !result.found) throw new Error('No matching element found for ' + by + '="' + value + '"');
  return { success: true, clicked: result };
}

export async function openPanel({ panel, action }) {
  const isBottomPanel = panel === 'pine-editor' || panel === 'strategy-tester';
  if (isBottomPanel) {
    const widgetName = panel === 'pine-editor' ? 'pine-editor' : 'backtesting';
    const result = await evaluate(`
      (function() {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (!bwb) return { error: 'bottomWidgetBar not available' };
        var panel = ${JSON.stringify(panel)};
        var widgetName = ${JSON.stringify(widgetName)};
        var action = ${JSON.stringify(action)};
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
        var isOpen = !!(bottomArea && bottomArea.offsetHeight > 50);
        if (panel === 'pine-editor') { var monacoEl = document.querySelector('.monaco-editor.pine-editor-monaco'); isOpen = isOpen && !!monacoEl; }
        if (panel === 'strategy-tester') { var stratPanel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]'); isOpen = isOpen && !!(stratPanel && stratPanel.offsetParent); }
        var performed = 'none';
        if (action === 'open' || (action === 'toggle' && !isOpen)) {
          if (panel === 'pine-editor') { if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab(); else if (typeof bwb.showWidget === 'function') bwb.showWidget(widgetName); }
          else { if (typeof bwb.showWidget === 'function') bwb.showWidget(widgetName); }
          performed = 'opened';
        } else if (action === 'close' || (action === 'toggle' && isOpen)) {
          if (typeof bwb.hideWidget === 'function') bwb.hideWidget(widgetName);
          performed = 'closed';
        }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    return { success: true, panel, action, was_open: result?.was_open ?? false, performed: result?.performed ?? 'unknown' };
  } else {
    const selectorMap = {
      'watchlist': { dataName: 'base-watchlist-widget-button', ariaLabel: 'Watchlist' },
      'alerts': { dataName: 'alerts-button', ariaLabel: 'Alerts' },
      'trading': { dataName: 'trading-button', ariaLabel: 'Trading Panel' },
    };
    const sel = selectorMap[panel];
    const result = await evaluate(`
      (function() {
        var dataName = ${JSON.stringify(sel.dataName)};
        var ariaLabel = ${JSON.stringify(sel.ariaLabel)};
        var action = ${JSON.stringify(action)};
        var btn = document.querySelector('[data-name="' + dataName + '"]') || document.querySelector('[aria-label="' + ariaLabel + '"]');
        if (!btn) return { error: 'Button not found for panel: ' + ${JSON.stringify(panel)} };
        var isActive = btn.getAttribute('aria-pressed') === 'true' || btn.classList.contains('isActive') || btn.classList.toString().indexOf('active') !== -1 || btn.classList.toString().indexOf('Active') !== -1;
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        var sidebarOpen = !!(rightArea && rightArea.offsetWidth > 50);
        var isOpen = isActive && sidebarOpen;
        var performed = 'none';
        if (action === 'open' && !isOpen) { btn.click(); performed = 'opened'; }
        else if (action === 'close' && isOpen) { btn.click(); performed = 'closed'; }
        else if (action === 'toggle') { btn.click(); performed = isOpen ? 'closed' : 'opened'; }
        else { performed = isOpen ? 'already_open' : 'already_closed'; }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    return { success: true, panel, action, was_open: result?.was_open ?? false, performed: result?.performed ?? 'unknown' };
  }
}

export async function fullscreen() {
  const result = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="header-toolbar-fullscreen"]');
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    })()
  `);
  if (!result || !result.found) throw new Error('Fullscreen button not found');
  return { success: true, action: 'fullscreen_toggled' };
}

export async function layoutList({ _deps } = {}) {
  const { evaluateAsync: evaluateLayoutAsync } = resolveLayoutDeps(_deps);
  const layouts = await evaluateLayoutAsync(`
    new Promise(function(resolve) {
      try {
        if (!window.TradingViewApi || typeof window.TradingViewApi.getSavedCharts !== 'function') {
          resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts unavailable'});
          return;
        }
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts returned no data'}); return; }
          var result = charts.map(function(c) { return { id: c.id || c.chartId || null, name: c.name || c.title || 'Untitled', symbol: c.symbol || null, resolution: c.resolution || null, modified: c.timestamp || c.modified || null }; });
          resolve({layouts: result, source: 'internal_api'});
        });
        setTimeout(function() { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts timed out'}); }, 3000);
      } catch(e) { resolve({layouts: [], source: 'internal_api', error: e.message}); }
    })
  `, { retry: true });
  return { success: true, layout_count: layouts?.layouts?.length || 0, source: layouts?.source, layouts: layouts?.layouts || [], error: layouts?.error };
}

async function resolveInternalLayout(name, deps, deadline) {
  return evaluateAsyncBeforeDeadline(deadline, deps, 'saved layout resolution', `
    new Promise(function(resolve) {
      /* __TV_MCP_RESOLVE_LAYOUT__ */
      try {
        var api = window.TradingViewApi;
        if (!api || typeof api.getSavedCharts !== 'function' || typeof api.loadChartFromServer !== 'function') {
          resolve({ status: 'unavailable', source: 'internal_api' });
          return;
        }
        var target = ${safeString(name)};
        var timer = setTimeout(function() { resolve({ status: 'unavailable', source: 'internal_api', error: 'getSavedCharts timed out' }); }, 3000);
        api.getSavedCharts(function(charts) {
          clearTimeout(timer);
          if (!Array.isArray(charts)) { resolve({ status: 'unavailable', source: 'internal_api', error: 'getSavedCharts returned no data' }); return; }
          function urlLayoutId(value) {
            if (value == null) return '';
            var url = String(value);
            var match = url.match(/\\/chart\\/([^/?#]+)/i);
            return match ? decodeURIComponent(match[1]) : url.replace(/^\\/+|\\/+$/g, '');
          }
          var normalized = charts.map(function(chart) {
            var id = chart.id != null ? chart.id : chart.chartId != null ? chart.chartId : null;
            return { id: id, url_layout_id: urlLayoutId(chart.url), name: String(chart.name || chart.title || 'Untitled') };
          });
          var exactId = normalized.filter(function(chart) { return String(chart.id == null ? '' : chart.id) === target || chart.url_layout_id === target; });
          var exactName = normalized.filter(function(chart) { return chart.name === target; });
          var insensitive = normalized.filter(function(chart) { return chart.name.toLowerCase() === target.toLowerCase(); });
          var partial = normalized.filter(function(chart) { return chart.name.toLowerCase().indexOf(target.toLowerCase()) !== -1; });
          var matches = exactId.length ? exactId : exactName.length ? exactName : insensitive.length ? insensitive : partial;
          if (matches.length === 0) { resolve({ status: 'not_found', source: 'internal_api' }); return; }
          if (matches.length > 1) { resolve({ status: 'ambiguous', source: 'internal_api', matches: matches.map(function(chart) { return chart.name; }) }); return; }
          resolve({ status: 'resolved', source: 'internal_api', id: matches[0].id, url_layout_id: matches[0].url_layout_id || null, name: matches[0].name });
        });
      } catch(e) { resolve({ status: 'unavailable', source: 'internal_api', error: e.message }); }
    })
  `, { retry: true });
}

async function initiateInternalLayout(layout, deps, deadline) {
  return evaluateBeforeDeadline(deadline, deps, 'internal layout load', `
    (function() {
      /* __TV_MCP_LOAD_LAYOUT__ */
      var api = window.TradingViewApi;
      if (!api || typeof api.loadChartFromServer !== 'function') return { initiated: false };
      api.loadChartFromServer(${safeString(layout.id)});
      return { initiated: true };
    })()
  `, { retry: false });
}

function layoutSnapshotExpression() {
  return `
    (function() {
      /* __TV_MCP_LAYOUT_SNAPSHOT__ */
      function unwrap(value) {
        try { return value && typeof value.value === 'function' ? value.value() : value; }
        catch(e) { return null; }
      }
      function visible(element) {
        if (!element) return false;
        var rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        for (var node = element; node && node.nodeType === 1; node = node.parentElement) {
          var style = window.getComputedStyle(node);
          var opacity = parseFloat(style.opacity);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || (!isNaN(opacity) && opacity <= 0)) return false;
        }
        return true;
      }
      function dialogContainer(element) {
        if (!element || element.matches('button, [role="button"], a, input, select, textarea')) return false;
        return element.getAttribute('role') === 'dialog'
          || element.getAttribute('aria-modal') === 'true'
          || /(^|[-_])(dialog|modal)([-_]|$)/i.test(element.getAttribute('data-name') || '');
      }
      function text(value) { return value == null ? '' : String(value).trim(); }
      function elementValue(value) {
        value = unwrap(value);
        if (value && value.nodeType === 1) return value;
        if (value && value[0] && value[0].nodeType === 1) return value[0];
        return null;
      }
      function meaningfulSurface(element) {
        if (!visible(element)) return false;
        var rect = element.getBoundingClientRect();
        return rect.width > 20 && rect.height > 20;
      }
      function paneSurfaceReady(element) {
        if (!element) return false;
        if (element.matches('[data-name="pane-canvas"], canvas') && meaningfulSurface(element)) return true;
        var surfaces = element.querySelectorAll('[data-name="pane-canvas"], canvas');
        for (var s = 0; s < surfaces.length; s++) {
          if (meaningfulSurface(surfaces[s])) return true;
        }
        return false;
      }
      var api = window.TradingViewApi;
      var collection = api && api._chartWidgetCollection;
      var active = null;
      try { active = api && api._activeChartWidgetWV && api._activeChartWidgetWV.value(); } catch(e) {}
      var all = [];
      try { all = collection && typeof collection.getAll === 'function' ? collection.getAll() : []; } catch(e) {}
      var fallbackPaneContainers = Array.prototype.filter.call(
        document.querySelectorAll('[data-name="chart-container"]'),
        function(element) {
          if (!visible(element)) return false;
          return !element.querySelector('[data-name="chart-container"]');
        }
      );
      var hasSafeFallback = fallbackPaneContainers.length === all.length;
      var panes = [];
      for (var i = 0; i < all.length; i++) {
        try {
          var widget = all[i];
          var model = widget && typeof widget.model === 'function' ? widget.model() : null;
          var series = model && typeof model.mainSeries === 'function' ? model.mainSeries() : null;
          var symbol = series && typeof series.symbol === 'function' ? text(series.symbol()) : '';
          var resolution = series && typeof series.interval === 'function' ? text(series.interval()) : '';
          var element = elementValue(widget && widget._mainDiv) || (hasSafeFallback ? fallbackPaneContainers[i] : null);
          var rect = element && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
          panes.push({
            index: i,
            symbol: symbol,
            resolution: resolution,
            surface_ready: paneSurfaceReady(element),
            x: rect ? Math.round(rect.x) : 0,
            y: rect ? Math.round(rect.y) : 0,
            width: rect ? Math.round(rect.width) : 0,
            height: rect ? Math.round(rect.height) : 0
          });
        } catch(e) { panes.push({ index: i, symbol: '', resolution: '', surface_ready: false, error: e.message, x: 0, y: 0, width: 0, height: 0 }); }
      }
      var layoutType = text(unwrap(collection && collection._layoutType));
      var metaInfo = unwrap(collection && collection.metaInfo);
      var layoutId = unwrap(metaInfo && metaInfo.id);
      var layoutUid = text(unwrap(metaInfo && metaInfo.uid));
      var layoutName = text(unwrap(metaInfo && metaInfo.name));
      var nameCandidates = [api && api._savedChartName, api && api._chartName, collection && collection._layoutName];
      for (var n = 0; n < nameCandidates.length && !layoutName; n++) layoutName = text(unwrap(nameCandidates[n]));
      var layoutControl = document.querySelector('[data-name="save-load-menu"]') || document.querySelector('[aria-label="Manage layouts"]');
      if (!layoutName && layoutControl) {
        layoutName = text(layoutControl.getAttribute('data-layout-name'));
        var controlText = text(layoutControl.textContent);
        if (!layoutName && controlText && !/^(save|saved|manage layouts?)$/i.test(controlText)) layoutName = controlText;
      }
      var url = window.location.href;
      var idMatch = url.match(/\\/chart\\/([^/?#]+)/i);
      var invalidElements = document.querySelectorAll('[data-name*="invalid-symbol"], [class*="invalidSymbol"], [role="alert"]');
      var invalidSymbol = false;
      for (var j = 0; j < invalidElements.length; j++) {
        if (visible(invalidElements[j]) && /invalid symbol|symbol not found|no data/i.test(text(invalidElements[j].textContent))) { invalidSymbol = true; break; }
      }
      var modal = null;
      var dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-name*="dialog"], [data-name*="modal"]');
      for (var d = 0; d < dialogs.length; d++) { if (dialogContainer(dialogs[d]) && visible(dialogs[d])) { modal = dialogs[d]; break; } }
      var loader = null;
      var loaders = document.querySelectorAll('[data-name="loading"], [class*="loader"], [class*="loading"]');
      for (var l = 0; l < loaders.length; l++) { if (visible(loaders[l])) { loader = loaders[l]; break; } }
      var chartApiReady = !!(active && typeof active.symbol === 'function' && typeof active.resolution === 'function' && collection && all.length > 0);
      var geometryValid = panes.length > 0 && panes.every(function(pane) { return pane.width > 20 && pane.height > 20; });
      var symbolsValid = panes.length > 0 && panes.every(function(pane) { return pane.symbol && pane.symbol.toLowerCase() !== 'unknown'; });
      var resolutionsValid = panes.length > 0 && panes.every(function(pane) { return !!pane.resolution; });
      var paneSignature = layoutType + '|' + panes.map(function(pane) { return pane.resolution; }).join(',');
      var geometrySignature = panes.map(function(pane) { return [pane.x, pane.y, pane.width, pane.height].join(':'); }).join('|');
      return {
        url: url,
        url_layout_id: idMatch ? decodeURIComponent(idMatch[1]) : null,
        layout_id: layoutId == null || layoutId === '' ? null : layoutId,
        layout_name: layoutName || null,
        layout_uid: layoutUid || null,
        meta_info_available: !!metaInfo,
        layout_type: layoutType || null,
        chart_api_ready: chartApiReady,
        pane_count: panes.length,
        panes: panes,
        pane_signature: paneSignature,
        geometry_signature: geometrySignature,
        pane_geometry_valid: geometryValid,
        symbols_valid: symbolsValid,
        resolutions_valid: resolutionsValid,
        invalid_symbol: invalidSymbol,
        visible_modal: !!modal,
        loading: !!loader,
        blank_chart: panes.some(function(pane) { return !pane.surface_ready; })
      };
    })()
  `;
}

export function layoutIdentityMatches(expected, observed) {
  const numericId = value => value != null && /^\d+$/.test(String(value)) ? String(value) : null;
  const normalizedId = value => value == null || value === '' ? null : String(value).toLowerCase();
  const expectedNumericId = numericId(expected?.id);
  const observedNumericId = numericId(observed?.layout_id);
  if (expectedNumericId && observedNumericId) return observedNumericId === expectedNumericId;

  const expectedUid = normalizedId(expected?.url_layout_id || (!expectedNumericId ? expected?.id : null));
  const observedUid = normalizedId(observed?.layout_uid);
  if (expectedUid && observedUid) return observedUid === expectedUid;

  const observedUrlId = normalizedId(observed?.url_layout_id);
  if (expectedUid && observedUrlId) return observedUrlId === expectedUid;

  // Once the requested layout has any authoritative identifier, a matching
  // display name cannot compensate for that identifier disappearing.
  if (expectedNumericId || expectedUid) return false;

  return expected?.name != null
    && observed?.layout_name != null
    && String(observed.layout_name) === String(expected.name);
}

function symbolMatches(expected, actual) {
  const wanted = String(expected || '').toUpperCase();
  const found = String(actual || '').toUpperCase();
  if (wanted.includes(':')) return found === wanted;
  return found === wanted || found.split(':').pop() === wanted;
}

async function readLayoutSnapshot(deps, deadline, expectedTargetId = deps.expectedTargetId) {
  const observed = await evaluateBeforeDeadline(
    deadline,
    deps,
    'layout snapshot',
    layoutSnapshotExpression(),
    { retry: true },
  );
  const target = await deadline.run('layout target resolution', remaining => deps.getTargetInfo({
    ...(expectedTargetId ? { expectedTargetId } : {}),
    timeoutMs: remaining,
  }));
  observed.target_id = target?.id == null ? null : String(target.id);
  return observed;
}

export async function getLayoutSnapshot({ timeout_ms, expected_target_id, expectedTargetId, _deps } = {}) {
  const deps = resolveLayoutDeps(_deps);
  deps.expectedTargetId = expectedTargetId || expected_target_id || null;
  const timeout = Math.max(50, Number(timeout_ms) || LAYOUT_SNAPSHOT_TIMEOUT_MS);
  const deadline = createLayoutDeadline(deps, timeout);
  return readLayoutSnapshot(deps, deadline);
}

async function verifyLayout(expected, options, deps, deadline) {
  let lastObserved = null;
  let lastStableKey = null;
  let stablePolls = 0;

  while (deadline.remaining() > 0) {
    try {
      const observed = await readLayoutSnapshot(deps, deadline);
      lastObserved = observed;

      if (options.expectedTargetId && observed.target_id !== options.expectedTargetId) {
        return layoutFailure('target_replaced', 'Layout verification moved to a different TradingView chart target', { observed });
      }

      const identityOk = layoutIdentityMatches(expected, observed);
      const paneSignatureOk = !options.expected_pane_signature || observed.pane_signature === options.expected_pane_signature;
      const symbolOk = !options.expected_symbol || observed.panes.every(pane => symbolMatches(options.expected_symbol, pane.symbol));
      const apiStableCandidate = identityOk
        && observed.chart_api_ready
        && observed.pane_geometry_valid
        && observed.symbols_valid
        && observed.resolutions_valid
        && !observed.invalid_symbol
        && !observed.visible_modal
        && !observed.loading
        && !observed.blank_chart
        && paneSignatureOk
        && symbolOk;

      if (apiStableCandidate) {
        const stableKey = JSON.stringify({
          target_id: observed.target_id,
          url: observed.url,
          layout_id: observed.layout_id,
          layout_uid: observed.layout_uid,
          url_layout_id: observed.url_layout_id,
          layout_name: observed.layout_name,
          pane_signature: observed.pane_signature,
          geometry_signature: observed.geometry_signature,
          symbols: observed.panes.map(pane => pane.symbol),
        });
        stablePolls = stableKey === lastStableKey ? stablePolls + 1 : 1;
        lastStableKey = stableKey;
        if (stablePolls >= LAYOUT_STABLE_POLLS) {
          return { success: true, observed, stable_polls: stablePolls };
        }
      } else {
        stablePolls = 0;
        lastStableKey = null;
      }
    } catch (err) {
      if (err?.reason === 'navigation_timeout') {
        err.observed = lastObserved;
        throw err;
      }
      if (err?.reason === 'target_replaced') {
        return layoutFailure('target_replaced', err.message, {
          observed: { error: err.message, reason: err.reason },
        });
      } else if (err?.reason === 'cdp_timeout' || err?.reason === 'execution_context_lost' || err?.reason === 'navigation_invalidated') {
        lastObserved = { error: err.message, reason: err.reason };
      } else {
        return layoutFailure('chart_api_not_ready', err.message, { observed: lastObserved });
      }
    }
    const remaining = deadline.remaining();
    if (remaining > 0) {
      try {
        await sleepBeforeDeadline(deadline, deps, 'layout verification poll', Math.min(LAYOUT_POLL_INTERVAL_MS, remaining));
      } catch (err) {
        if (err?.reason === 'navigation_timeout') err.observed = lastObserved;
        throw err;
      }
    }
  }

  // Expiry is a transport fence, not an opportunity to reinterpret the last
  // observation as a different failure class.
  await deadline.run('layout verification', () => Promise.resolve());

  if (!lastObserved?.chart_api_ready) {
    return layoutFailure('chart_api_not_ready', 'TradingView chart API did not become stable before the deadline', { observed: lastObserved });
  }
  if (options.expected_pane_signature && lastObserved.pane_signature !== options.expected_pane_signature) {
    return layoutFailure('pane_signature_mismatch', `Expected pane signature ${options.expected_pane_signature}, observed ${lastObserved.pane_signature}`, { observed: lastObserved });
  }
  if (options.expected_symbol && !lastObserved.panes?.every(pane => symbolMatches(options.expected_symbol, pane.symbol))) {
    return layoutFailure('symbol_mismatch', `Expected symbol ${options.expected_symbol} in every pane`, { observed: lastObserved });
  }
  return layoutFailure('navigation_timeout', `Layout ${expected.name || expected.id} did not reach verified postconditions before the deadline`, { observed: lastObserved });
}

async function dismissUnsavedDialog(deps, deadline, stopAt) {
  while (deadline.remaining() > 0 && deps.now() < stopAt) {
    const result = await evaluateBeforeDeadline(deadline, deps, 'unsaved dialog check', `
      (function() {
        /* __TV_MCP_UNSAVED_DIALOG__ */
        function visible(element) {
          if (!element) return false;
          var r = element.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          for (var node = element; node && node.nodeType === 1; node = node.parentElement) {
            var style = window.getComputedStyle(node);
            var opacity = parseFloat(style.opacity);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || (!isNaN(opacity) && opacity <= 0)) return false;
          }
          return true;
        }
        function dialogContainer(element) {
          if (!element || element.matches('button, [role="button"], a, input, select, textarea')) return false;
          return element.getAttribute('role') === 'dialog'
            || element.getAttribute('aria-modal') === 'true'
            || /(^|[-_])(dialog|modal)([-_]|$)/i.test(element.getAttribute('data-name') || '');
        }
        var dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-name*="dialog"], [data-name*="modal"]');
        for (var i = 0; i < dialogs.length; i++) {
          if (!dialogContainer(dialogs[i]) || !visible(dialogs[i])) continue;
          var buttons = dialogs[i].querySelectorAll('button, [role="button"]');
          for (var j = 0; j < buttons.length; j++) {
            var label = (buttons[j].textContent || '').trim();
            if (/^(open anyway|don't save|discard)$/i.test(label)) { buttons[j].click(); return { dismissed: true }; }
          }
        }
        return { dismissed: false };
      })()
    `, { retry: false });
    if (result?.dismissed) return true;
    const remaining = Math.min(deadline.remaining(), Math.max(0, stopAt - deps.now()));
    if (remaining > 0) await sleepBeforeDeadline(deadline, deps, 'unsaved dialog poll', Math.min(150, remaining));
  }
  return false;
}

async function nativeOpenLayout(name, deps, deadline) {
  let menu;
  try {
    menu = await evaluateBeforeDeadline(deadline, deps, 'native layout menu', `
      (function() {
        /* __TV_MCP_NATIVE_OPEN_MENU__ */
        function visible(element) { if (!element) return false; var r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
        var controls = document.querySelectorAll('[data-name="save-load-menu"], [aria-label="Manage layouts"], [aria-label*="Manage layouts"]');
        for (var i = 0; i < controls.length; i++) {
          if (visible(controls[i])) { controls[i].click(); return { clicked: true }; }
        }
        return { clicked: false };
      })()
    `, { retry: false });
  } catch (err) {
    if (err?.reason === 'navigation_timeout') throw err;
    return layoutFailure(err?.reason === 'target_replaced' ? 'target_replaced' : 'chart_api_not_ready', err.message, { source: 'native_ui' });
  }
  if (!menu?.clicked) return layoutFailure('chart_api_not_ready', 'Native Manage layouts control was not available', { source: 'native_ui', selection_initiated: false });

  let actionOpened = false;
  const actionDeadline = Math.min(deadline.expiresAt, deps.now() + NATIVE_STEP_TIMEOUT_MS);
  while (deps.now() < actionDeadline && !actionOpened) {
    const action = await evaluateBeforeDeadline(deadline, deps, 'native Open layout action', `
      (function() {
        /* __TV_MCP_NATIVE_OPEN_ACTION__ */
        function visible(element) { if (!element) return false; var r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
        function normalized(value) { return (value || '').trim().replace(/…/g, '...').replace(/\\s+/g, ' ').toLowerCase(); }
        function openLayoutTitle(value) { var label = normalized(value); return label === 'open layout...' || label === 'open layout'; }
        var items = document.querySelectorAll('button, [role="button"], [role="menuitem"], a, [role="row"]');
        for (var i = 0; i < items.length; i++) {
          var label = normalized(items[i].textContent || items[i].getAttribute('aria-label'));
          var title = items[i].querySelector('[data-name="list-item-title"], [role="gridcell"]');
          var titleMatches = title && openLayoutTitle(title.textContent || title.getAttribute('aria-label'));
          var rowPrefixMatches = items[i].getAttribute('role') === 'row'
            && (label.indexOf('open layout...') === 0 || label === 'open layout');
          if (visible(items[i]) && (openLayoutTitle(label) || titleMatches || rowPrefixMatches)) { items[i].click(); return { clicked: true }; }
        }
        return { clicked: false };
      })()
    `, { retry: false });
    actionOpened = !!action?.clicked;
    if (!actionOpened) await sleepBeforeDeadline(deadline, deps, 'native Open layout action poll', Math.min(150, Math.max(0, actionDeadline - deps.now())));
  }
  if (!actionOpened) return layoutFailure('chart_api_not_ready', 'Native Open layout action was not available', { source: 'native_ui', selection_initiated: false });

  const rowDeadline = Math.min(deadline.expiresAt, deps.now() + NATIVE_STEP_TIMEOUT_MS);
  while (deps.now() < rowDeadline) {
    let selected;
    try {
      selected = await evaluateBeforeDeadline(deadline, deps, 'native layout row selection', `
        (function() {
        /* __TV_MCP_NATIVE_SELECT_LAYOUT__ */
        function visible(element) { if (!element) return false; var r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
        function text(element) { return (element.textContent || '').trim().replace(/\\s+/g, ' '); }
        var target = ${safeString(name)};
        var dialog = document.querySelector('[role="dialog"][data-name="load-layout-dialog"]') || document.querySelector('[role="dialog"]');
        var search = dialog && dialog.querySelector('[role="searchbox"][placeholder="Search"], input[type="search"], input[placeholder*="Search"]');
        if (search && visible(search) && search.value !== target) {
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(search, target);
          search.dispatchEvent(new Event('input', { bubbles: true }));
        }
        var nodes = dialog ? dialog.querySelectorAll('[data-name="list-item-title"]') : [];
        var matches = [];
        for (var i = 0; i < nodes.length; i++) {
          var row = nodes[i].closest('[data-name="load-chart-dialog-item"][data-role="list-item"], [data-name="load-chart-dialog-item"], [role="row"][data-role="list-item"]');
          if (row && visible(row) && visible(nodes[i]) && text(nodes[i]).toLowerCase() === target.toLowerCase()) matches.push({ title: nodes[i], row: row });
        }
        if (matches.length > 1) return { selected: false, ambiguous: true };
        if (matches.length === 0) return { selected: false };
        var title = matches[0].title;
        var item = matches[0].row;
        var href = item.getAttribute('href') || '';
        var id = item.getAttribute('data-chart-id') || item.getAttribute('data-layout-id') || '';
        var currentUrl = new URL(window.location.href);
        var safeUrl = null;
        try { safeUrl = new URL(href, currentUrl.href); } catch(e) {}
        var tradingViewOrigin = currentUrl.protocol === 'https:' && /(^|\\.)tradingview\\.com$/i.test(currentUrl.hostname);
        var pathMatch = safeUrl && safeUrl.pathname.match(/^\\/chart\\/([A-Za-z0-9_-]+)\\/$/);
        if (!tradingViewOrigin
          || !safeUrl
          || safeUrl.protocol !== 'https:'
          || safeUrl.origin !== currentUrl.origin
          || !pathMatch
          || safeUrl.search
          || safeUrl.hash) {
          return { selected: false, unsafe_href: true };
        }
        var urlLayoutId = pathMatch[1];
        window.location.assign(safeUrl.href);
        return { selected: true, id: id || null, url_layout_id: urlLayoutId, name: text(title), direct_navigation: true };
        })()
      `, { retry: false });
    } catch (err) {
      if (err?.outcome_unknown) {
        const uncertain = new Error(err.message, { cause: err });
        uncertain.reason = err.reason;
        uncertain.outcome_unknown = true;
        uncertain.native_selection_outcome_unknown = true;
        uncertain.selection_initiated = true;
        uncertain.transport_reconnect_attempted = err.transport_reconnect_attempted;
        uncertain.transport_reconnected = err.transport_reconnected;
        uncertain.reconnect_error = err.reconnect_error;
        throw uncertain;
      }
      if (err?.reason === 'navigation_timeout') {
        err.selection_initiated = true;
        throw err;
      }
      err.selection_initiated = true;
      throw err;
    }
    if (selected?.ambiguous) return layoutFailure('layout_ambiguous', `Multiple native layout rows matched "${name}"`, { source: 'native_ui', selection_initiated: false });
    if (selected?.unsafe_href) return layoutFailure('chart_api_not_ready', 'Native layout row had an unsafe or off-origin href', { source: 'native_ui', selection_initiated: false });
    if (selected?.selected) return { success: true, source: 'native_ui', id: selected.id, url_layout_id: selected.url_layout_id, name: selected.name || name, selection_initiated: true };
    await sleepBeforeDeadline(deadline, deps, 'native layout row poll', Math.min(200, Math.max(0, rowDeadline - deps.now())));
  }
  return layoutFailure('layout_not_found', `Layout "${name}" was not found in the native Open layout dialog`, { source: 'native_ui', selection_initiated: false });
}

export async function layoutSwitch({ name, expected_pane_signature, expected_symbol, timeout_ms, _deps }) {
  const deps = resolveLayoutDeps(_deps);
  const timeout = Math.max(50, Number(timeout_ms) || LAYOUT_SWITCH_TIMEOUT_MS);
  const deadline = createLayoutDeadline(deps, timeout);
  const options = { expected_pane_signature, expected_symbol, expectedTargetId: null };
  let internal = null;
  let dismissed = false;
  let deadlineContext = {};

  const reconnectForVerification = async () => {
    try {
      await deadline.run('layout navigation reconnect', remaining => deps.reconnect('layout_navigation', {
        expectedTargetId: options.expectedTargetId,
        timeoutMs: remaining,
      }));
      return null;
    } catch (err) {
      if (err?.reason === 'navigation_timeout') throw err;
      return err;
    }
  };

  const dismissBeforeVerification = async () => {
    const stopAt = Math.min(deadline.expiresAt, deps.now() + 1500);
    try {
      dismissed = (await dismissUnsavedDialog(deps, deadline, stopAt)) || dismissed;
    } catch (err) {
      if (err?.reason === 'navigation_timeout') throw err;
    }
  };

  const verifiedSuccess = (expected, verified, source, method, details = {}) => ({
    success: true,
    layout: expected.name,
    layout_id: expected.id ?? verified.observed.layout_id ?? null,
    url_layout_id: expected.url_layout_id || verified.observed.url_layout_id || verified.observed.layout_uid || null,
    source,
    method,
    action: 'switched',
    verified: true,
    stable_polls: verified.stable_polls,
    observed: verified.observed,
    unsaved_dialog_dismissed: dismissed,
    ...details,
  });

  try {
    const originalTarget = await deadline.run('layout target capture', remaining => deps.getTargetInfo({ timeoutMs: remaining }));
    const originalTargetId = originalTarget?.id == null ? null : String(originalTarget.id);
    if (!originalTargetId) {
      return layoutFailure('target_replaced', 'Could not capture the original TradingView chart target before layout mutation');
    }
    options.expectedTargetId = originalTargetId;
    deps.expectedTargetId = originalTargetId;

    // This internal call is identity resolution only. No saved chart is loaded.
    try {
      internal = await resolveInternalLayout(name, deps, deadline);
    } catch (err) {
      if (err?.reason === 'navigation_timeout') throw err;
      internal = { status: 'unavailable', source: 'internal_api', error: err.message };
    }

    let native;
    let nativeSelectionUnknown = null;
    try {
      native = await nativeOpenLayout(name, deps, deadline);
    } catch (err) {
      if (err?.reason === 'navigation_timeout') throw err;
      if (err?.outcome_unknown && err?.native_selection_outcome_unknown) nativeSelectionUnknown = err;
      else {
        // Once the row-selection expression was sent, its outcome is treated as
        // uncertain and no second layout mutation is permitted.
        if (err?.selection_initiated) nativeSelectionUnknown = err;
        else native = layoutFailure(err?.reason === 'target_replaced' ? 'target_replaced' : 'chart_api_not_ready', err.message, {
          source: 'native_ui',
          selection_initiated: false,
        });
      }
    }

    if (nativeSelectionUnknown || native?.success) {
      const nativeNumericId = native?.id != null && /^\d+$/.test(String(native.id)) ? native.id : null;
      const retainedInternalId = internal?.status === 'resolved' && /^\d+$/.test(String(internal.id)) ? internal.id : null;
      const expected = native?.success ? {
        id: nativeNumericId ?? retainedInternalId ?? native.id,
        url_layout_id: native.url_layout_id || internal?.url_layout_id || null,
        name: native.name || internal?.name || name,
      } : internal?.status === 'resolved' ? {
        id: internal.id,
        url_layout_id: internal.url_layout_id,
        name: internal.name,
      } : { id: null, url_layout_id: null, name };

      deadlineContext = {
        source: 'native_ui',
        fallback_used: false,
        outcome_unknown: !!nativeSelectionUnknown,
      };

      const reconnectError = await reconnectForVerification();
      await dismissBeforeVerification();
      const verified = await verifyLayout(expected, options, deps, deadline);
      if (verified.success) {
        return verifiedSuccess(expected, verified, 'native_ui', 'open_layout_ui', {
          fallback_used: false,
          ...(nativeSelectionUnknown ? { outcome_unknown_recovered: true } : {}),
        });
      }
      return layoutFailure(verified.reason, nativeSelectionUnknown
        ? `Native layout selection outcome remained unknown: ${verified.error}`
        : verified.error, {
        layout: expected.name,
        layout_id: expected.id,
        url_layout_id: expected.url_layout_id,
        source: 'native_ui',
        fallback_used: false,
        outcome_unknown: !!nativeSelectionUnknown,
        verification_reason: verified.reason,
        reconnect_error: reconnectError?.message,
        observed: verified.observed,
        unsaved_dialog_dismissed: dismissed,
      });
    }

    // Native failed before any row selection/navigation. This is the sole point
    // at which the internal mutation is allowed as a one-shot fallback.
    if (internal?.status === 'ambiguous') {
      return layoutFailure('layout_ambiguous', `Layout "${name}" matched multiple saved layouts`, {
        layout: name,
        matches: internal.matches,
        source: 'internal_api',
        fallback_used: false,
        fallback_failure: native?.reason,
      });
    }
    if (internal?.status !== 'resolved') {
      return { ...native, layout: name, fallback_used: false };
    }

    let initiation = null;
    let internalOutcomeUnknown = null;
    try {
      initiation = await initiateInternalLayout(internal, deps, deadline);
    } catch (err) {
      if (err?.reason === 'navigation_timeout') throw err;
      internalOutcomeUnknown = err;
    }

    if (!internalOutcomeUnknown && !initiation?.initiated) {
      return layoutFailure('chart_api_not_ready', 'Internal layout API did not initiate a load', {
        layout: internal.name,
        layout_id: internal.id,
        url_layout_id: internal.url_layout_id,
        source: 'internal_api',
        fallback_used: true,
        fallback_failure: native?.reason,
      });
    }

    deadlineContext = {
      source: 'internal_api',
      fallback_used: true,
      fallback_failure: native?.reason,
      outcome_unknown: !!internalOutcomeUnknown,
    };
    const reconnectError = await reconnectForVerification();
    await dismissBeforeVerification();
    const verified = await verifyLayout(internal, options, deps, deadline);
    if (verified.success) {
      return verifiedSuccess(internal, verified, 'internal_api', 'loadChartFromServer', {
        fallback_used: true,
        fallback_failure: native?.reason,
        ...(internalOutcomeUnknown ? { outcome_unknown_recovered: true } : {}),
      });
    }
    return layoutFailure(verified.reason, internalOutcomeUnknown
      ? `Internal layout load outcome remained unknown: ${verified.error}`
      : verified.error, {
      layout: internal.name,
      layout_id: internal.id,
      url_layout_id: internal.url_layout_id,
      source: 'internal_api',
      fallback_used: true,
      fallback_failure: native?.reason,
      outcome_unknown: !!internalOutcomeUnknown,
      verification_reason: verified.reason,
      reconnect_error: reconnectError?.message,
      observed: verified.observed,
      unsaved_dialog_dismissed: dismissed,
    });
  } catch (err) {
    if (err?.reason === 'target_replaced') {
      return layoutFailure('target_replaced', err.message, {
        layout: internal?.name || name,
        layout_id: internal?.status === 'resolved' ? internal.id : null,
        url_layout_id: internal?.status === 'resolved' ? internal.url_layout_id : null,
        source: deadlineContext.source || 'target_lineage',
        fallback_used: deadlineContext.fallback_used || false,
        fallback_failure: deadlineContext.fallback_failure,
        outcome_unknown: deadlineContext.outcome_unknown || undefined,
      });
    }
    if (err?.reason !== 'navigation_timeout') throw err;
    return layoutFailure('navigation_timeout', err.message, {
      layout: internal?.name || name,
      layout_id: internal?.status === 'resolved' ? internal.id : null,
      url_layout_id: internal?.status === 'resolved' ? internal.url_layout_id : null,
      source: deadlineContext.source || 'deadline',
      fallback_used: deadlineContext.fallback_used || false,
      fallback_failure: deadlineContext.fallback_failure,
      outcome_unknown: deadlineContext.outcome_unknown || undefined,
      observed: err.observed,
    });
  }
}

export async function keyboard({ key, modifiers }) {
  const c = await getClient();
  let mod = 0;
  if (modifiers) {
    if (modifiers.includes('alt')) mod |= 1;
    if (modifiers.includes('ctrl')) mod |= 2;
    if (modifiers.includes('meta')) mod |= 4;
    if (modifiers.includes('shift')) mod |= 8;
  }
  const keyMap = {
    'Enter': { code: 'Enter', vk: 13 }, 'Escape': { code: 'Escape', vk: 27 }, 'Tab': { code: 'Tab', vk: 9 },
    'Backspace': { code: 'Backspace', vk: 8 }, 'Delete': { code: 'Delete', vk: 46 },
    'ArrowUp': { code: 'ArrowUp', vk: 38 }, 'ArrowDown': { code: 'ArrowDown', vk: 40 },
    'ArrowLeft': { code: 'ArrowLeft', vk: 37 }, 'ArrowRight': { code: 'ArrowRight', vk: 39 },
    'Space': { code: 'Space', vk: 32 }, 'Home': { code: 'Home', vk: 36 }, 'End': { code: 'End', vk: 35 },
    'PageUp': { code: 'PageUp', vk: 33 }, 'PageDown': { code: 'PageDown', vk: 34 },
    'F1': { code: 'F1', vk: 112 }, 'F2': { code: 'F2', vk: 113 }, 'F5': { code: 'F5', vk: 116 },
  };
  const mapped = keyMap[key] || { code: 'Key' + key.toUpperCase(), vk: key.toUpperCase().charCodeAt(0) };
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: mod, key, code: mapped.code, windowsVirtualKeyCode: mapped.vk });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key, code: mapped.code });
  return { success: true, key, modifiers: modifiers || [] };
}

export async function typeText({ text }) {
  const c = await getClient();
  await c.Input.insertText({ text });
  return { success: true, typed: text.substring(0, 100), length: text.length };
}

export async function hover({ by, value }) {
  const coords = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${JSON.stringify(value)};
      var el = null;
      if (by === 'aria-label') {
        el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
        if (!el) el = document.querySelector('[aria-label*="' + value.replace(/"/g, '\\\\"') + '"]');
      }
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], span, div');
        for (var i = 0; i < candidates.length; i++) { var text = candidates[i].textContent.trim(); if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; } }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName.toLowerCase() };
    })()
  `);
  if (!coords) throw new Error('Element not found for ' + by + '="' + value + '"');
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: coords.x, y: coords.y });
  return { success: true, hovered: { by, value, tag: coords.tag, x: coords.x, y: coords.y } };
}

export async function scroll({ direction, amount }) {
  const c = await getClient();
  const px = amount || 300;
  const center = await evaluate(`
    (function() {
      var el = document.querySelector('[data-name="pane-canvas"]') || document.querySelector('[class*="chart-container"]') || document.querySelector('canvas');
      if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `);
  let deltaX = 0, deltaY = 0;
  if (direction === 'up') deltaY = -px; else if (direction === 'down') deltaY = px;
  else if (direction === 'left') deltaX = -px; else if (direction === 'right') deltaX = px;
  await c.Input.dispatchMouseEvent({ type: 'mouseWheel', x: center.x, y: center.y, deltaX, deltaY });
  return { success: true, direction, amount: px };
}

export async function mouseClick({ x, y, button, double_click }) {
  const c = await getClient();
  const btn = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
  const btnNum = btn === 'right' ? 2 : btn === 'middle' ? 1 : 0;
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons: btnNum, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn });
  if (double_click) {
    await new Promise(r => setTimeout(r, 50));
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons: btnNum, clickCount: 2 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn });
  }
  return { success: true, x, y, button: btn, double_click: !!double_click };
}

export async function findElement({ query, strategy }) {
  const strat = strategy || 'text';
  const results = await evaluate(`
    (function() {
      var query = ${JSON.stringify(query)};
      var strategy = ${JSON.stringify(strat)};
      var results = [];
      if (strategy === 'css') {
        var els = document.querySelectorAll(query);
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else if (strategy === 'aria-label') {
        var els = document.querySelectorAll('[aria-label*="' + query.replace(/"/g, '\\\\"') + '"]');
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else {
        var all = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], input, select, label, span, div, h1, h2, h3, h4');
        for (var i = 0; i < all.length; i++) {
          var text = all[i].textContent.trim();
          if (text.toLowerCase().indexOf(query.toLowerCase()) !== -1 && text.length < 200) {
            var rect = all[i].getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              results.push({ tag: all[i].tagName.toLowerCase(), text: text.substring(0, 80), aria_label: all[i].getAttribute('aria-label') || null, data_name: all[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: all[i].offsetParent !== null });
              if (results.length >= 20) break;
            }
          }
        }
      }
      return results;
    })()
  `);
  return { success: true, query, strategy: strat, count: results?.length || 0, elements: results || [] };
}

export async function uiEvaluate({ expression }) {
  const result = await evaluate(expression);
  return { success: true, result };
}
