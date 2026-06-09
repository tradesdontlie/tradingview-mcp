/**
 * Core watchlist logic.
 * Uses TradingView's internal widget API with DOM fallback.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

export async function get() {
  // Try internal API first — reads from the active watchlist widget
  const symbols = await evaluate(`
    (function() {
      // Method 1: Try the watchlist widget's internal data
      try {
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        if (!rightArea || rightArea.offsetWidth < 50) return { symbols: [], source: 'panel_closed' };
      } catch(e) {}

      // Method 2: Read data-symbol-full attributes from watchlist rows
      var results = [];
      var seen = {};
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };

      // Find all elements with symbol data attributes
      var symbolEls = container.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < symbolEls.length; i++) {
        var sym = symbolEls[i].getAttribute('data-symbol-full');
        if (!sym || seen[sym]) continue;
        seen[sym] = true;

        // Find the row and extract price data
        var row = symbolEls[i].closest('[class*="row"]') || symbolEls[i].parentElement;
        var cells = row ? row.querySelectorAll('[class*="cell"], [class*="column"]') : [];
        var nums = [];
        for (var j = 0; j < cells.length; j++) {
          var t = cells[j].textContent.trim();
          if (t && /^[\\-+]?[\\d,]+\\.?\\d*%?$/.test(t.replace(/[\\s,]/g, ''))) nums.push(t);
        }
        results.push({ symbol: sym, last: nums[0] || null, change: nums[1] || null, change_percent: nums[2] || null });
      }

      if (results.length > 0) return { symbols: results, source: 'data_attributes' };

      // Method 3: Scan for ticker-like text in the right panel
      var items = container.querySelectorAll('[class*="symbolName"], [class*="tickerName"], [class*="symbol-"]');
      for (var k = 0; k < items.length; k++) {
        var text = items[k].textContent.trim();
        if (text && /^[A-Z][A-Z0-9.:!]{0,20}$/.test(text) && !seen[text]) {
          seen[text] = true;
          results.push({ symbol: text, last: null, change: null, change_percent: null });
        }
      }

      return { symbols: results, source: results.length > 0 ? 'text_scan' : 'empty' };
    })()
  `);

  return {
    success: true,
    count: symbols?.symbols?.length || 0,
    source: symbols?.source || 'unknown',
    symbols: symbols?.symbols || [],
  };
}

export async function add({ symbol }) {
  // Use keyboard shortcut to open symbol search in watchlist, type symbol, press Enter
  const c = await getClient();

  // First ensure watchlist panel is open
  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1
        || btn.classList.toString().indexOf('active') !== -1;
      if (!isActive) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  // Click the "Add symbol" button (various selectors)
  const addClicked = await evaluate(`
    (function() {
      var selectors = [
        '[data-name="add-symbol-button"]',
        '[aria-label="Add symbol"]',
        '[aria-label*="Add symbol"]',
        'button[class*="addSymbol"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var btn = document.querySelector(selectors[s]);
        if (btn && btn.offsetParent !== null) { btn.click(); return { found: true, selector: selectors[s] }; }
      }
      // Fallback: find + button in right panel
      var container = document.querySelector('[class*="layout__area--right"]');
      if (container) {
        var buttons = container.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var ariaLabel = buttons[i].getAttribute('aria-label') || '';
          if (/add.*symbol/i.test(ariaLabel) || buttons[i].textContent.trim() === '+') {
            buttons[i].click();
            return { found: true, method: 'fallback' };
          }
        }
      }
      return { found: false };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await new Promise(r => setTimeout(r, 300));

  // Type the symbol into the search input
  await c.Input.insertText({ text: symbol });
  await new Promise(r => setTimeout(r, 500));

  // Press Enter to select the first result
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise(r => setTimeout(r, 300));

  // Press Escape to close search
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, symbol, action: 'added' };
}

// ─── Named-watchlist management via TradingView's internal REST API ──────────
//
// TradingView exposes a same-origin REST endpoint for custom (named) watchlists:
//   GET    {origin}/api/v1/symbols_list/all/          → all custom lists
//   POST   {origin}/api/v1/symbols_list/custom/       → create  (body {name, symbols})
//   DELETE {origin}/api/v1/symbols_list/custom/{id}/  → delete
//
// These run in-page via CDP, so the logged-in session cookie authenticates the
// request and no CSRF token is required (verified against a live desktop client).
// This is the same approach alerts.list() uses against pricealerts.tradingview.com,
// and is far more robust than driving the localized watchlist UI:
//   • language-independent (no German/English selector strings)
//   • no DOM timing/race conditions
//   • atomic — create a fully-populated named list in a single call
//   • does NOT change the user's active list (REST create leaves active=false)

/**
 * Create a named watchlist, optionally pre-populated with symbols, in one call.
 * @param {{ name: string, symbols?: string[] }} args
 *   name    — display name for the new list (required, non-empty)
 *   symbols — optional initial symbols, e.g. ["NASDAQ:NVDA", "NYSE:ORCL"]
 */
export async function create({ name, symbols = [] } = {}) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Watchlist name is required (non-empty string)');
  }
  const cleanName = name.trim();
  const cleanSymbols = (Array.isArray(symbols) ? symbols : [])
    .map(s => String(s).trim())
    .filter(Boolean);

  // Inject the request body as a JSON literal parsed in-page — avoids any
  // string-interpolation/injection risk from the name or symbols.
  const payloadLiteral = safeString(JSON.stringify({ name: cleanName, symbols: cleanSymbols }));

  const result = await evaluateAsync(`
    (function() {
      var payload = JSON.parse(${payloadLiteral});
      var url = location.origin + '/api/v1/symbols_list/custom/';
      return fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(payload)
      })
        .then(function(r) { return r.text().then(function(t) {
          var data = null; try { data = JSON.parse(t); } catch (e) {}
          return { ok: r.ok, status: r.status, data: data, raw: data ? null : String(t).slice(0, 300) };
        }); })
        .catch(function(e) { return { ok: false, status: 0, error: String((e && e.message) || e) }; });
    })()
  `);

  if (!result || !result.ok || !result.data) {
    const detail = result?.error || result?.raw || ('HTTP ' + (result?.status ?? '??'));
    throw new Error(`Watchlist create failed: ${detail}`);
  }

  const created = result.data;
  return {
    success: true,
    id: created.id,
    name: created.name,
    symbols: created.symbols || cleanSymbols,
    count: (created.symbols || cleanSymbols).length,
    active: !!created.active,
    source: 'rest_api',
  };
}

/**
 * List all custom (named) watchlists with their ids, names, and symbol counts.
 * REST-based — reads every list, unlike get() which reads only the active one.
 */
export async function list() {
  const result = await evaluateAsync(`
    fetch(location.origin + '/api/v1/symbols_list/all/', { credentials: 'include', headers: { 'Accept': 'application/json' } })
      .then(function(r) { return r.text().then(function(t) {
        var data = null; try { data = JSON.parse(t); } catch (e) {}
        return { ok: r.ok, status: r.status, data: data, raw: data ? null : String(t).slice(0, 300) };
      }); })
      .catch(function(e) { return { ok: false, status: 0, error: String((e && e.message) || e) }; })
  `);

  if (!result || !result.ok || !Array.isArray(result.data)) {
    const detail = result?.error || result?.raw || ('HTTP ' + (result?.status ?? '??'));
    throw new Error(`Watchlist list failed: ${detail}`);
  }

  const lists = result.data.map(l => ({
    id: l.id,
    name: l.name,
    type: l.type,
    count: Array.isArray(l.symbols) ? l.symbols.length : 0,
    active: !!l.active,
    symbols: l.symbols || [],
  }));
  return { success: true, count: lists.length, source: 'rest_api', lists };
}

/**
 * Delete a custom watchlist by its numeric id (obtain ids from list()).
 * Deletion is scoped strictly by id — never by name — to avoid ambiguous matches.
 * @param {{ id: number }} args
 */
export async function remove({ id } = {}) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    throw new Error('A positive numeric watchlist id is required (get it from watchlist_list)');
  }

  const result = await evaluateAsync(`
    fetch(location.origin + '/api/v1/symbols_list/custom/' + ${numId} + '/', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    })
      .then(function(r) { return { ok: r.ok, status: r.status }; })
      .catch(function(e) { return { ok: false, status: 0, error: String((e && e.message) || e) }; })
  `);

  if (!result || !result.ok) {
    const detail = result?.error || ('HTTP ' + (result?.status ?? '??'));
    throw new Error(`Watchlist delete failed: ${detail}`);
  }
  return { success: true, id: numId, deleted: true, source: 'rest_api' };
}
