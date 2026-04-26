/**
 * Core watchlist logic.
 *
 * Reads (get / list) use the DOM/internal-API for the active panel and TV's
 * REST API for cross-list data. Mutations (remove / switch / create / rename /
 * delete) all hit TV's internal REST endpoints on the same origin
 * (https://www.tradingview.com/api/v1/symbols_list/...), authenticated via
 * session cookies. No Content-Type header is set so the browser treats each
 * request as a CORS "simple" request and skips preflight — sending a custom
 * Content-Type breaks it (same pitfall as alerts.js).
 *
 * Wire formats captured 2026-04-21 on TV Desktop 3.1.0.7818:
 *   POST /api/v1/symbols_list/custom/{id}/remove/?source=web-tvd   body ["SYM",...]
 *   POST /api/v1/symbols_list/active/{id_or_color}/?source=web-tvd empty body
 *   POST /api/v1/symbols_list/custom/?source=web-tvd               body {"name":"...","symbols":[...]}
 *   POST /api/v1/symbols_list/custom/{id}/rename/?source=web-tvd   body {"name":"..."}
 *   DELETE /api/v1/symbols_list/custom/{id}/?source=web-tvd
 *   GET    /api/v1/symbols_list/all/?source=web-tvd                returns [{id,type,name,color,symbols,active,...}]
 */
import { evaluate, evaluateAsync, getClient, safeBacktickBody } from '../connection.js';

/**
 * Fire a TV REST request in the page context and parse the response.
 * Uses `fetch` with `credentials:'include'` (session cookies) and NO custom
 * Content-Type — TV rejects the CORS preflight otherwise.
 */
async function tvRest(path, { method = 'GET', body = null } = {}) {
  const hasBody = body != null;
  const bodyJson = hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
  // Escape for template-literal injection into the evaluated JS — single
  // source of truth lives in connection.js as safeBacktickBody().
  const escapedBody = hasBody ? safeBacktickBody(bodyJson) : '';
  const escapedPath = safeBacktickBody(path);

  // NOTE: These watchlist endpoints live on www.tradingview.com (same-origin as
  // the chart page) so setting Content-Type:application/json is SAFE — no CORS
  // preflight. The server actually REQUIRES application/json for the create/
  // rename endpoints (returns 415 Unsupported Media Type otherwise). This is
  // the inverse of the alerts REST code, which hits pricealerts.tradingview.com
  // (cross-origin) where Content-Type triggers a preflight TV rejects.
  const expr = `
    fetch(\`${escapedPath}\`, {
      method: '${method}',
      credentials: 'include'${hasBody ? ",\n      headers: { 'Content-Type': 'application/json' },\n      body: `" + escapedBody + "`" : ''}
    })
      .then(function(r) {
        return r.text().then(function(t) {
          var parsed = null;
          try { parsed = t ? JSON.parse(t) : null; } catch(e) {}
          return { status: r.status, ok: r.ok, body: t, json: parsed };
        });
      })
      .catch(function(e) { return { error: e.message }; })
  `;
  return await evaluateAsync(expr);
}

/**
 * Fetch all watchlists (custom + colored). Returns the parsed JSON array
 * unchanged from TV's wire format.
 * Each item: {id, type:"custom"|"colored", name, color|null, symbols:[...],
 *             active:boolean, shared, description, created, modified}
 * For colored lists the numeric `id` is present AND `color` is set
 * ("red"/"blue"/"green"/"yellow"/"purple"). Switching active needs the COLOR
 * string for colored lists and the numeric ID for custom lists.
 */
export async function listAll() {
  const resp = await tvRest('/api/v1/symbols_list/all/?source=web-tvd', { method: 'GET' });
  if (!resp || resp.error) return { success: false, error: resp?.error || 'no response', source: 'rest_api' };
  if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${String(resp.body).slice(0, 200)}`, source: 'rest_api' };
  return { success: true, lists: Array.isArray(resp.json) ? resp.json : [], source: 'rest_api' };
}

/**
 * Resolve a watchlist name to its record. Matches are case-insensitive and
 * allow either the `name` field (custom lists + renamed colored lists) or the
 * raw `color` field (unnamed colored lists: "red"/"blue"/...).
 *
 * Returns the full record from /all/, or throws if not found or ambiguous.
 */
async function resolveList(nameOrColor, listsCache = null) {
  if (!nameOrColor || typeof nameOrColor !== 'string') {
    throw new Error('watchlist name is required (string)');
  }
  const target = nameOrColor.trim().toLowerCase();
  let lists = listsCache;
  if (!lists) {
    const r = await listAll();
    if (!r.success) throw new Error('Could not fetch watchlists: ' + r.error);
    lists = r.lists;
  }
  const matches = lists.filter(l => {
    const n = (l.name || '').trim().toLowerCase();
    const c = (l.color || '').trim().toLowerCase();
    return n === target || c === target;
  });
  if (matches.length === 0) {
    const names = lists.map(l => l.name || l.color || `#${l.id}`).filter(Boolean);
    throw new Error(`Watchlist "${nameOrColor}" not found. Available: ${names.join(', ')}`);
  }
  if (matches.length > 1) {
    throw new Error(`Watchlist name "${nameOrColor}" is ambiguous (${matches.length} matches). Use the exact name.`);
  }
  return matches[0];
}

/**
 * Return a cleaned-up list of watchlists suitable for AI consumption.
 * By default omits the symbols array to keep the payload small; pass
 * include_symbols:true to include it.
 */
export async function list({ include_symbols = false } = {}) {
  const r = await listAll();
  if (!r.success) return { success: false, error: r.error, source: 'rest_api' };
  const cleaned = r.lists.map(l => {
    const row = {
      id: l.id,
      name: l.name || l.color || `#${l.id}`,
      type: l.type,
      color: l.color || null,
      symbol_count: Array.isArray(l.symbols) ? l.symbols.length : 0,
      active: !!l.active,
      modified: l.modified || null,
    };
    if (include_symbols) row.symbols = l.symbols || [];
    return row;
  });
  return { success: true, count: cleaned.length, lists: cleaned, source: 'rest_api' };
}

/**
 * Switch the active watchlist by name (or color for unnamed colored lists).
 *   POST /api/v1/symbols_list/active/{id_or_color}/?source=web-tvd
 *
 * For custom lists the numeric `id` is used in the path; for colored lists
 * the `color` string ("red"/"blue"/...) is used.
 */
export async function switchList({ name } = {}) {
  const record = await resolveList(name);
  const identifier = record.type === 'colored' ? (record.color || record.id) : record.id;
  const resp = await tvRest(`/api/v1/symbols_list/active/${identifier}/?source=web-tvd`, { method: 'POST' });
  if (!resp || resp.error) return { success: false, error: resp?.error || 'no response', source: 'rest_api' };
  // A 2xx (or empty body) means success. TV returns a small JSON or empty body.
  if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${String(resp.body).slice(0, 200)}`, source: 'rest_api' };
  return {
    success: true,
    switched_to: record.name || record.color || `#${record.id}`,
    id: record.id,
    type: record.type,
    source: 'rest_api',
  };
}

/**
 * Remove one or more symbols from a watchlist.
 *   POST /api/v1/symbols_list/custom/{id}/remove/?source=web-tvd   body ["SYM",...]
 *
 * `from` defaults to the currently-active watchlist. Works for custom lists;
 * colored lists use the same numeric-id endpoint and have been observed to
 * accept the same wire format (verified empirically during implementation).
 */
export async function removeSymbol({ symbol, symbols, from } = {}) {
  let toRemove = [];
  if (Array.isArray(symbols) && symbols.length > 0) {
    toRemove = symbols.map(s => String(s)).filter(Boolean);
  } else if (symbol) {
    toRemove = [String(symbol)];
  } else {
    throw new Error('Pass `symbol` (string) or `symbols` (array of strings).');
  }

  const all = await listAll();
  if (!all.success) return { success: false, error: all.error, source: 'rest_api' };
  let target;
  if (from) {
    target = await resolveList(from, all.lists);
  } else {
    target = all.lists.find(l => l.active);
    if (!target) return { success: false, error: 'No active watchlist found and `from` not provided', source: 'rest_api' };
  }

  const resp = await tvRest(`/api/v1/symbols_list/custom/${target.id}/remove/?source=web-tvd`, {
    method: 'POST',
    body: toRemove,
  });
  if (!resp || resp.error) return { success: false, error: resp?.error || 'no response', source: 'rest_api' };
  if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${String(resp.body).slice(0, 200)}`, http_status: resp.status, source: 'rest_api' };

  return {
    success: true,
    list_name: target.name || target.color || `#${target.id}`,
    list_id: target.id,
    removed_symbols: toRemove,
    removed_count: toRemove.length,
    source: 'rest_api',
  };
}

/**
 * Create a new custom watchlist.
 *   POST /api/v1/symbols_list/custom/?source=web-tvd   body {"name":"...","symbols":[...]}
 *
 * Response: {id, type, name, symbols, active, ...}
 */
export async function create({ name, symbols = [] } = {}) {
  if (!name || typeof name !== 'string') throw new Error('`name` is required (string)');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('`name` must be non-empty');

  const body = { name: trimmed, symbols: Array.isArray(symbols) ? symbols.map(String) : [] };
  const resp = await tvRest('/api/v1/symbols_list/custom/?source=web-tvd', {
    method: 'POST',
    body,
  });
  if (!resp || resp.error) return { success: false, error: resp?.error || 'no response', source: 'rest_api' };
  if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${String(resp.body).slice(0, 200)}`, http_status: resp.status, source: 'rest_api' };

  const created = resp.json || {};
  return {
    success: true,
    id: created.id,
    name: created.name || trimmed,
    symbol_count: Array.isArray(created.symbols) ? created.symbols.length : body.symbols.length,
    source: 'rest_api',
  };
}

/**
 * Rename an existing custom watchlist.
 *   POST /api/v1/symbols_list/custom/{id}/rename/?source=web-tvd   body {"name":"..."}
 *
 * Only custom lists are renameable via this path — colored lists are built-in
 * and this tool refuses them with a clear error (user would need to use TV's
 * UI to rename a colored slot).
 */
export async function rename({ current_name, new_name } = {}) {
  if (!current_name || !new_name) throw new Error('Pass both `current_name` and `new_name`.');
  const record = await resolveList(current_name);
  if (record.type !== 'custom') {
    return {
      success: false,
      error: `Cannot rename ${record.type} watchlist "${current_name}" via REST. Built-in colored lists must be renamed through TV's UI.`,
      source: 'rest_api',
    };
  }
  const trimmed = String(new_name).trim();
  if (!trimmed) throw new Error('`new_name` must be non-empty');

  const resp = await tvRest(`/api/v1/symbols_list/custom/${record.id}/rename/?source=web-tvd`, {
    method: 'POST',
    body: { name: trimmed },
  });
  if (!resp || resp.error) return { success: false, error: resp?.error || 'no response', source: 'rest_api' };
  if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${String(resp.body).slice(0, 200)}`, http_status: resp.status, source: 'rest_api' };

  return {
    success: true,
    id: record.id,
    old_name: record.name,
    new_name: trimmed,
    source: 'rest_api',
  };
}

/**
 * Delete a custom watchlist — DESTRUCTIVE, heavily guarded.
 *   DELETE /api/v1/symbols_list/custom/{id}/?source=web-tvd
 *
 * Refuses unless ALL of the following hold:
 *   - `confirm_name` is provided and equals the resolved list's actual name
 *     (case-sensitive). Forces the caller to type the list name twice, so a
 *     single-point typo or wrong-variable error doesn't destroy a real list.
 *     This is the main guard: AI agents and humans both can mis-target
 *     `name`, but typing the exact same string twice is deliberate.
 *   - List type is `custom` (colored lists are built-in, not deletable).
 *   - List is not currently active, OR `confirm_active:true` is passed.
 *
 * On the guarded refusals, the response includes the list's current
 * symbol_count so the caller can see what they'd lose.
 *
 * Added 2026-04-22 after an AI-driven mis-target deleted a 26-symbol live
 * watchlist during smoke-test. Do not remove this guard without a better
 * replacement.
 */
export async function deleteList({ name, confirm_name, confirm_active = false } = {}) {
  const record = await resolveList(name);

  // Guard 1: colored lists are not deletable
  if (record.type !== 'custom') {
    return {
      success: false,
      error: `Cannot delete ${record.type} watchlist "${name}". Only custom lists are deletable; built-in colored lists must be managed through TV's UI.`,
      source: 'rest_api',
    };
  }

  // Guard 2: require confirm_name to match the resolved list's actual name.
  // Case-sensitive, whitespace-trimmed — forces caller to type it twice.
  if (!confirm_name || String(confirm_name).trim() !== String(record.name).trim()) {
    return {
      success: false,
      error: `Delete refused: pass confirm_name equal to the list's exact name "${record.name}" to proceed. This list has ${Array.isArray(record.symbols) ? record.symbols.length : '?'} symbol(s); deletion is destructive and unrecoverable.`,
      list_name: record.name,
      list_id: record.id,
      symbol_count: Array.isArray(record.symbols) ? record.symbols.length : null,
      active: !!record.active,
      source: 'rest_api',
    };
  }

  // Guard 3: active list — TV's UI requires switching away first
  if (record.active && !confirm_active) {
    return {
      success: false,
      error: `"${record.name}" is the active watchlist. Switch to a different list first (watchlist_switch) or pass confirm_active:true.`,
      source: 'rest_api',
    };
  }

  const resp = await tvRest(`/api/v1/symbols_list/custom/${record.id}/?source=web-tvd`, { method: 'DELETE' });
  if (!resp || resp.error) return { success: false, error: resp?.error || 'no response', source: 'rest_api' };
  if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${String(resp.body).slice(0, 200)}`, http_status: resp.status, source: 'rest_api' };

  return {
    success: true,
    deleted_name: record.name,
    deleted_id: record.id,
    deleted_symbol_count: Array.isArray(record.symbols) ? record.symbols.length : null,
    source: 'rest_api',
  };
}

export async function get() {
  // Activate the watchlist tab first. TV lazy-renders sidebar widgets: when a different
  // tab (Alerts, Object Tree, etc.) is active, the watchlist widget exists in the DOM
  // but has empty innerHTML, so scraping returns count:0 even on installs with real data.
  // Fix: click the "Watchlist, details, and news" tab button if not pressed, then wait for render.
  const activated = await evaluate(`
    (function() {
      var tab = document.querySelector('[aria-label="Watchlist, details, and news"]')
        || document.querySelector('[data-name="base"][aria-label*="Watchlist"]');
      if (!tab) return { activated: false, reason: 'tab_not_found' };
      var wasPressed = tab.getAttribute('aria-pressed') === 'true';
      if (!wasPressed) tab.click();
      return { activated: true, was_pressed: wasPressed };
    })()
  `);
  if (activated?.activated && !activated.was_pressed) {
    // Allow widget to render — TV populates DOM asynchronously after tab switch
    await new Promise(r => setTimeout(r, 400));
  }

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
