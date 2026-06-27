/**
 * Core UI automation logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getClient as _getClient, safeString } from '../connection.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getClient: deps?.getClient || _getClient,
  };
}

/**
 * Page-side helper source: given a CSS attribute value, return it escaped for safe
 * embedding inside a double-quoted attribute selector ([attr="<value>"]). Backslashes
 * are doubled first, then double-quotes escaped. Defined as a string so it can be
 * inlined into evaluated payloads. The VALUE itself always reaches the page via
 * safeString() (a JS string literal), so it can never break out of the evaluate
 * payload; this only guards against the value terminating the CSS selector.
 */
const ATTR_ESCAPE_FN = `function __escAttr(v){return String(v).replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'\\\\"');}`;

/**
 * Map a keyboard key name to its DOM `code` and Windows virtual-key code.
 * Pure + exported for unit testing. Returns null for keys outside the supported
 * set (named keys in KEY_MAP, single letters a-z/A-Z, single digits 0-9) so the
 * caller can reject clearly-unsupported keys instead of dispatching a wrong code.
 */
const KEY_MAP = {
  'Enter': { code: 'Enter', vk: 13 }, 'Escape': { code: 'Escape', vk: 27 }, 'Tab': { code: 'Tab', vk: 9 },
  'Backspace': { code: 'Backspace', vk: 8 }, 'Delete': { code: 'Delete', vk: 46 },
  'ArrowUp': { code: 'ArrowUp', vk: 38 }, 'ArrowDown': { code: 'ArrowDown', vk: 40 },
  'ArrowLeft': { code: 'ArrowLeft', vk: 37 }, 'ArrowRight': { code: 'ArrowRight', vk: 39 },
  'Space': { code: 'Space', vk: 32 }, 'Home': { code: 'Home', vk: 36 }, 'End': { code: 'End', vk: 35 },
  'PageUp': { code: 'PageUp', vk: 33 }, 'PageDown': { code: 'PageDown', vk: 34 },
  'F1': { code: 'F1', vk: 112 }, 'F2': { code: 'F2', vk: 113 }, 'F3': { code: 'F3', vk: 114 },
  'F4': { code: 'F4', vk: 115 }, 'F5': { code: 'F5', vk: 116 }, 'F6': { code: 'F6', vk: 117 },
  'F7': { code: 'F7', vk: 118 }, 'F8': { code: 'F8', vk: 119 }, 'F9': { code: 'F9', vk: 120 },
  'F10': { code: 'F10', vk: 121 }, 'F11': { code: 'F11', vk: 122 }, 'F12': { code: 'F12', vk: 123 },
};

export function mapKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  if (KEY_MAP[key]) return KEY_MAP[key];
  if (/^[0-9]$/.test(key)) return { code: 'Digit' + key, vk: key.charCodeAt(0) };
  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    return { code: 'Key' + upper, vk: upper.charCodeAt(0) };
  }
  return null;
}

// Bound the getSavedCharts() callback wait so a never-firing callback can't hang
// the layout list/switch promise indefinitely.
const SAVED_CHARTS_TIMEOUT_MS = 5000;
// After loadChartFromServer(), wait before scanning for an "unsaved changes" dialog.
const LAYOUT_DIALOG_SETTLE_MS = 500;
// After dismissing the unsaved-changes dialog, wait for the layout to finish loading.
const LAYOUT_LOAD_SETTLE_MS = 1000;
// Gap between the two clicks of a synthesized double-click.
const DOUBLE_CLICK_GAP_MS = 50;

export async function click({ by, value, _deps }) {
  const { evaluate } = _resolve(_deps);
  // The value reaches the page only via safeString() (a JS string literal) — it
  // can never terminate the evaluate payload. __escAttr() then escapes it for the
  // CSS attribute selector so it can't break out of the selector either.
  const result = await evaluate(`
    (function() {
      ${ATTR_ESCAPE_FN}
      var by = ${safeString(by)};
      var value = ${safeString(value)};
      var el = null;
      if (by === 'aria-label') el = document.querySelector('[aria-label="' + __escAttr(value) + '"]');
      else if (by === 'data-name') el = document.querySelector('[data-name="' + __escAttr(value) + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"]');
        for (var i = 0; i < candidates.length; i++) {
          var text = candidates[i].textContent.trim();
          if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; }
        }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + __escAttr(value) + '"]');
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
    // Bottom panels (Pine Editor, Strategy Tester) live in bottomWidgetBar.
    // Current TV builds expose open/close/show/hide/toggleMinimize/
    // toggleMaximize on bwb, but the older showWidget/hideWidget/
    // activateScriptEditorTab methods this file used to call don't exist.
    // To switch tabs we click the toolbar button (same path the user takes);
    // to hide/show we minimize via _mode.setValue, which actually drives the
    // panel layout (bwb.hide() only un-shows already-active widgets and
    // doesn't collapse the panel).
    const btnSelector = panel === 'pine-editor'
      ? '[data-name="pine-dialog-button"]'
      : '[data-name="backtesting-button"]';
    const ariaLabel = panel === 'pine-editor' ? 'Pine' : 'Strategy Tester';
    const monacoSelector = panel === 'pine-editor'
      ? '.monaco-editor.pine-editor-monaco'
      : '[data-name="backtesting"]';
    const result = await evaluate(`
      (function() {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (!bwb) return { error: 'bottomWidgetBar not available' };
        var action = ${JSON.stringify(action)};
        var btn = document.querySelector(${JSON.stringify(btnSelector)})
          || document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(ariaLabel))} + ']');
        var mounted = !!document.querySelector(${JSON.stringify(monacoSelector)});
        var mode = bwb._mode && bwb._mode.value && bwb._mode.value();
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
        var visible = !!(bottomArea && bottomArea.offsetHeight > 50);
        var isOpen = mounted && visible && mode !== 'minimized';

        var performed = 'none';
        if (action === 'open' || (action === 'toggle' && !isOpen)) {
          if (!mounted && btn) btn.click();
          if (bwb._mode && bwb._mode.value && bwb._mode.value() === 'minimized' && bwb._mode.setValue) bwb._mode.setValue('normal');
          if (bwb._isHidden && bwb._isHidden.setValue) bwb._isHidden.setValue(false);
          performed = 'opened';
        } else if (action === 'close' || (action === 'toggle' && isOpen)) {
          if (bwb._mode && bwb._mode.setValue) bwb._mode.setValue('minimized');
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
  const layouts = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts returned no data'}); return; }
          var result = charts.map(function(c) { return { id: c.id || c.chartId || null, name: c.name || c.title || 'Untitled', symbol: c.symbol || null, resolution: c.resolution || null, modified: c.timestamp || c.modified || null }; });
          resolve({layouts: result, source: 'internal_api'});
        });
        setTimeout(function() { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts timed out'}); }, ${SAVED_CHARTS_TIMEOUT_MS});
      } catch(e) { resolve({layouts: [], source: 'internal_api', error: e.message}); }
    })
  `);
  if (layouts?.error) throw new Error(layouts.error);
  return { success: true, layout_count: layouts?.layouts?.length || 0, source: layouts?.source, layouts: layouts?.layouts || [] };
}

export async function layoutSwitch({ name, _deps }) {
  const { evaluate, evaluateAsync } = _resolve(_deps);
  const escaped = JSON.stringify(name);
  const result = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        var target = ${escaped};
        if (/^\\d+$/.test(target)) { window.TradingViewApi.loadChartFromServer(target); resolve({success: true, method: 'loadChartFromServer', id: target, source: 'internal_api'}); return; }
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({success: false, error: 'getSavedCharts returned no data', source: 'internal_api'}); return; }
          var match = null;
          for (var i = 0; i < charts.length; i++) { var cname = charts[i].name || charts[i].title || ''; if (cname === target || cname.toLowerCase() === target.toLowerCase()) { match = charts[i]; break; } }
          if (!match) { for (var j = 0; j < charts.length; j++) { var cn = (charts[j].name || charts[j].title || '').toLowerCase(); if (cn.indexOf(target.toLowerCase()) !== -1) { match = charts[j]; break; } } }
          if (!match) { resolve({success: false, error: 'Layout "' + target + '" not found.', source: 'internal_api'}); return; }
          var chartId = match.id || match.chartId;
          window.TradingViewApi.loadChartFromServer(chartId);
          resolve({success: true, method: 'loadChartFromServer', id: chartId, name: match.name || match.title, source: 'internal_api'});
        });
        setTimeout(function() { resolve({success: false, error: 'getSavedCharts timed out', source: 'internal_api'}); }, ${SAVED_CHARTS_TIMEOUT_MS});
      } catch(e) { resolve({success: false, error: e.message, source: 'internal_api'}); }
    })
  `);
  if (!result?.success) throw new Error(result?.error || 'Unknown error switching layout');

  // Handle "unsaved changes" confirmation dialog
  await new Promise(r => setTimeout(r, LAYOUT_DIALOG_SETTLE_MS));
  const dismissed = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/open anyway|don't save|discard/i.test(text)) {
          btns[i].click();
          return true;
        }
      }
      return false;
    })()
  `);

  if (dismissed) await new Promise(r => setTimeout(r, LAYOUT_LOAD_SETTLE_MS));
  return { success: true, layout: result.name || name, layout_id: result.id, source: result.source, action: 'switched', unsaved_dialog_dismissed: dismissed };
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
  const mapped = mapKey(key);
  if (!mapped) {
    throw new Error(
      `Unsupported key: "${key}". Use a named key (Enter, Escape, Tab, Arrow*, F1-F12, etc.), ` +
      `a single letter (a-z), or a single digit (0-9).`
    );
  }
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
      ${ATTR_ESCAPE_FN}
      var by = ${safeString(by)};
      var value = ${safeString(value)};
      var el = null;
      if (by === 'aria-label') {
        el = document.querySelector('[aria-label="' + __escAttr(value) + '"]');
        if (!el) el = document.querySelector('[aria-label*="' + __escAttr(value) + '"]');
      }
      else if (by === 'data-name') el = document.querySelector('[data-name="' + __escAttr(value) + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], span, div');
        for (var i = 0; i < candidates.length; i++) { var text = candidates[i].textContent.trim(); if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; } }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + __escAttr(value) + '"]');
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
    await new Promise(r => setTimeout(r, DOUBLE_CLICK_GAP_MS));
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
      ${ATTR_ESCAPE_FN}
      var query = ${safeString(query)};
      var strategy = ${safeString(strat)};
      var results = [];
      if (strategy === 'css') {
        // 'css' strategy intentionally treats query as a raw CSS selector. The
        // value still reaches the page only via safeString() so it cannot break
        // out of the evaluate payload; an invalid selector simply throws below.
        var els = document.querySelectorAll(query);
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else if (strategy === 'aria-label') {
        var els = document.querySelectorAll('[aria-label*="' + __escAttr(query) + '"]');
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
