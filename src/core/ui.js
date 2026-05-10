/**
 * Core UI automation logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getClient as _getClient } from '../connection.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getClient: deps?.getClient || _getClient,
  };
}

function _normalizeLayout(layout, currentSlug, currentName) {
  const id = layout?.id ?? layout?.chartId ?? null;
  const name = layout?.name || layout?.title || 'Untitled';
  const url = layout?.url || layout?.chartUrl || null;
  const symbol = layout?.symbol || null;
  const resolution = layout?.interval || layout?.resolution || null;
  const modified = layout?.timestamp || layout?.modified || null;
  const active = currentName
    ? _normalizeLayoutQuery(name) === _normalizeLayoutQuery(currentName)
    : !!(url && currentSlug && url === currentSlug);

  return {
    id,
    name,
    url,
    symbol,
    resolution,
    modified,
    active,
  };
}

function _normalizeLayoutQuery(value) {
  return String(value || '').trim().toLowerCase();
}

function _resolveLayoutMatch(layouts, query) {
  const normalized = _normalizeLayoutQuery(query);
  const rawQuery = String(query || '').trim();
  if (!normalized) throw new Error('Layout name or ID is required');

  const exactById = layouts.find(l => String(l.id) === rawQuery);
  if (exactById) return exactById;

  const exactByUrl = layouts.find(l => _normalizeLayoutQuery(l.url) === normalized);
  if (exactByUrl) return exactByUrl;

  const exactByName = layouts.find(l => _normalizeLayoutQuery(l.name) === normalized);
  if (exactByName) return exactByName;

  const partialMatches = layouts.filter(l => _normalizeLayoutQuery(l.name).includes(normalized));
  if (partialMatches.length === 1) return partialMatches[0];
  if (partialMatches.length > 1) {
    const names = partialMatches.slice(0, 5).map(l => l.name).join(', ');
    throw new Error(`Layout "${query}" is ambiguous. Matches: ${names}`);
  }

  throw new Error(`Layout "${query}" not found.`);
}

async function _getLayoutSnapshot({ evaluateAsync }) {
  const snapshot = await evaluateAsync(`
    new Promise(function(resolve) {
      var done = false;
      function finish(payload) {
        if (done) return;
        done = true;
        resolve(payload);
      }
      function currentSlug() {
        var match = location.pathname.match(/\\/chart\\/([^/?#]+)/i);
        return match ? match[1] : null;
      }
      function currentName() {
        try {
          var attr = document.querySelector('[aria-label*="Aktives Layout:"], [aria-label*="Active layout:"]');
          if (!attr) return null;
          var label = attr.getAttribute('aria-label') || '';
          var match = label.match(/(?:Aktives Layout|Active layout):\\s*([^\\n]+)/i);
          return match ? match[1].trim() : null;
        } catch (e) {
          return null;
        }
      }
      function build(rows, source, error) {
        finish({
          source: source,
          error: error || null,
          current_slug: currentSlug(),
          current_name: currentName(),
          current_href: location.href,
          layouts: Array.isArray(rows) ? rows : [],
        });
      }

      try {
        var api = window.TradingViewApi || {};
        try {
          var stateWV = api._loadChartService && api._loadChartService._state;
          var state = stateWV && typeof stateWV.value === 'function' ? stateWV.value() : null;
          if (state && Array.isArray(state.chartList) && state.chartList.length > 0) {
            build(state.chartList, 'load_chart_service');
            return;
          }
        } catch (stateErr) {}

        if (typeof api.getSavedCharts === 'function') {
          api.getSavedCharts(function(charts) {
            build(charts, 'getSavedCharts');
          });
          setTimeout(function() {
            build([], 'getSavedCharts', 'getSavedCharts timed out');
          }, 5000);
          return;
        }

        build([], 'internal_api', 'No layout API available');
      } catch (e) {
        build([], 'internal_api', e.message);
      }
    })
  `);

  const currentSlug = snapshot?.current_slug || null;
  const currentName = snapshot?.current_name || null;
  const layouts = (snapshot?.layouts || []).map(layout => _normalizeLayout(layout, currentSlug, currentName));
  return {
    source: snapshot?.source || 'unknown',
    error: snapshot?.error || null,
    current_slug: currentSlug,
    current_name: currentName,
    current_href: snapshot?.current_href || null,
    layouts,
  };
}

function _findActiveLayout(layouts) {
  return layouts.find(layout => layout.active) || null;
}

async function _dismissUnsavedLayoutDialog({ evaluate }) {
  return evaluate(`
    (function() {
      var dialogPattern = /unsaved changes|last changes will be lost|nicht gespeicherte[nr]? änderungen|änderungen verloren gehen|neues layout öffnen/i;
      var confirmPattern = /open anyway|don't save|do not save|discard|continue without saving|trotzdem öffnen|ohne speichern|nicht speichern|verwerfen|änderungen verwerfen|ja,? öffnen/i;

      function tryButtons(root) {
        var btns = root.querySelectorAll('button, [role="button"]');
        for (var i = 0; i < btns.length; i++) {
          var text = (btns[i].textContent || '').trim();
          var aria = (btns[i].getAttribute('aria-label') || '').trim();
          if (confirmPattern.test(text) || confirmPattern.test(aria)) {
            btns[i].click();
            return { dismissed: true, label: text || aria || null };
          }
        }
        return null;
      }

      var dialogs = document.querySelectorAll('[role="dialog"], [data-dialog-name], [class*="dialog"]');
      for (var j = 0; j < dialogs.length; j++) {
        var text = (dialogs[j].textContent || '').trim();
        if (!dialogPattern.test(text)) continue;
        var scoped = tryButtons(dialogs[j]);
        if (scoped) return scoped;
      }

      var fallback = tryButtons(document);
      if (fallback) return fallback;
      return { dismissed: false, label: null };
    })()
  `);
}

async function _waitForLayoutActivation(target, { evaluate, evaluateAsync, timeoutMs = 10000, intervalMs = 250 }) {
  const started = Date.now();
  let dismissed = false;
  let attempts = 0;

  while (Date.now() - started < timeoutMs) {
    attempts += 1;
    const dialog = await _dismissUnsavedLayoutDialog({ evaluate });
    dismissed = dismissed || !!dialog?.dismissed;

    const snapshot = await _getLayoutSnapshot({ evaluateAsync });
    const active = _findActiveLayout(snapshot.layouts);
    const slugMatches = target.url && snapshot.current_slug === target.url;
    const idMatches = active && String(active.id) === String(target.id);
    const nameMatches = active && _normalizeLayoutQuery(active.name) === _normalizeLayoutQuery(target.name);

    if (slugMatches || idMatches || nameMatches) {
      return {
        success: true,
        verified: true,
        attempts,
        source: snapshot.source,
        current_slug: snapshot.current_slug,
        current_name: snapshot.current_name,
        current_href: snapshot.current_href,
        active_layout: active,
        unsaved_dialog_dismissed: dismissed,
      };
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  const finalSnapshot = await _getLayoutSnapshot({ evaluateAsync });
  return {
    success: false,
    verified: false,
    attempts,
    source: finalSnapshot.source,
    current_slug: finalSnapshot.current_slug,
    current_name: finalSnapshot.current_name,
    current_href: finalSnapshot.current_href,
    active_layout: _findActiveLayout(finalSnapshot.layouts),
    unsaved_dialog_dismissed: dismissed,
  };
}

export async function click({ by, value, _deps }) {
  const { evaluate } = _resolve(_deps);
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

export async function openPanel({ panel, action, _deps }) {
  const { evaluate } = _resolve(_deps);
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

export async function fullscreen({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
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
  const { evaluateAsync } = _resolve(_deps);
  const snapshot = await _getLayoutSnapshot({ evaluateAsync });
  const active = _findActiveLayout(snapshot.layouts);
  return {
    success: true,
    layout_count: snapshot.layouts.length,
    source: snapshot.source,
    current_slug: snapshot.current_slug,
    current_name: snapshot.current_name,
    current_href: snapshot.current_href,
    active_layout: active,
    layouts: snapshot.layouts,
    error: snapshot.error,
  };
}

export async function layoutSwitch({ name, _deps }) {
  const { evaluate, evaluateAsync } = _resolve(_deps);
  const before = await _getLayoutSnapshot({ evaluateAsync });
  if (before.error && before.layouts.length === 0) {
    throw new Error(before.error);
  }

  const target = _resolveLayoutMatch(before.layouts, name);
  if (target.active) {
    return {
      success: true,
      action: 'already_active',
      verified: true,
      layout: target.name,
      layout_id: target.id,
      layout_url: target.url,
      source: before.source,
      current_slug: before.current_slug,
      current_name: before.current_name,
      current_href: before.current_href,
      unsaved_dialog_dismissed: false,
    };
  }

  const escaped = JSON.stringify(String(target.id));
  const result = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        var targetId = ${escaped};
        if (!window.TradingViewApi || typeof window.TradingViewApi.loadChartFromServer !== 'function') {
          resolve({success: false, error: 'loadChartFromServer is not available', source: 'internal_api'});
          return;
        }
        window.TradingViewApi.loadChartFromServer(targetId);
        resolve({success: true, method: 'loadChartFromServer', id: targetId, source: 'internal_api'});
      } catch(e) { resolve({success: false, error: e.message, source: 'internal_api'}); }
    })
  `);
  if (!result?.success) throw new Error(result?.error || 'Unknown error switching layout');

  const verification = await _waitForLayoutActivation(target, { evaluate, evaluateAsync });
  if (!verification.success) {
    const current = verification.current_name || verification.active_layout?.name || verification.current_slug || 'unknown';
    throw new Error(`Layout switch to "${target.name}" was not verified. Current layout appears to be "${current}".`);
  }

  return {
    success: true,
    action: 'switched',
    verified: true,
    layout: target.name,
    layout_id: target.id,
    layout_url: target.url,
    source: verification.source || result.source,
    current_slug: verification.current_slug,
    current_name: verification.current_name,
    current_href: verification.current_href,
    active_layout: verification.active_layout,
    verification_attempts: verification.attempts,
    unsaved_dialog_dismissed: verification.unsaved_dialog_dismissed,
  };
}

export async function keyboard({ key, modifiers, _deps }) {
  const { getClient } = _resolve(_deps);
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

export async function typeText({ text, _deps }) {
  const { getClient } = _resolve(_deps);
  const c = await getClient();
  await c.Input.insertText({ text });
  return { success: true, typed: text.substring(0, 100), length: text.length };
}

export async function hover({ by, value, _deps }) {
  const { evaluate, getClient } = _resolve(_deps);
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

export async function scroll({ direction, amount, _deps }) {
  const { evaluate, getClient } = _resolve(_deps);
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

export async function mouseClick({ x, y, button, double_click, _deps }) {
  const { getClient } = _resolve(_deps);
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

export async function findElement({ query, strategy, _deps }) {
  const { evaluate } = _resolve(_deps);
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

export async function uiEvaluate({ expression, _deps }) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(expression);
  return { success: true, result };
}
