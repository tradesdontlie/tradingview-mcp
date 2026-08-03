/**
 * Core watchlist logic.
 * Reads the complete active watchlist through TradingView's authenticated
 * symbols_list REST API. Add/remove retain their established UI/API paths.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// Current builds use data-name="base" with this exact aria label. Keep the
// legacy selectors as fallbacks, but scope the otherwise-generic "base" name.
export const WATCHLIST_BUTTON_EXPRESSION = `(document.querySelector('button[data-name="base"][aria-label="Watchlist, details, and news"]')
  || document.querySelector('[data-name="base-watchlist-widget-button"]')
  || document.querySelector('button[aria-label="Watchlist, details, and news"]')
  || document.querySelector('button[aria-label="Watchlist"]'))`;
const WL_BUTTON_JS = WATCHLIST_BUTTON_EXPRESSION;

export const WATCHLIST_ACTIVE_READ_EXPRESSION = `(async function() {
  /* watchlist-reader:active-rest-v1 */
  async function readActive() {
    var response;
    try {
      response = await fetch('/api/v1/symbols_list/active/', {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' }
      });
    } catch (_) {
      return { ok: false, status: 0, error: 'network_error' };
    }
    if (!response.ok) {
      return { ok: false, status: Number(response.status) || 0, error: 'http_error' };
    }
    var contentType = '';
    try { contentType = response.headers && response.headers.get('content-type') || ''; } catch (_) {}
    if (contentType && contentType.toLowerCase().indexOf('application/json') === -1) {
      return { ok: false, status: Number(response.status) || 0, error: 'non_json_response' };
    }
    try {
      return { ok: true, status: Number(response.status) || 200, data: await response.json() };
    } catch (_) {
      return { ok: false, status: Number(response.status) || 0, error: 'invalid_json' };
    }
  }

  var first = await readActive();
  var second = await readActive();
  return { first: first, second: second };
})()`;

let watchlistMutexTail = Promise.resolve();

async function withWatchlistMutex(operation) {
  const previous = watchlistMutexTail;
  let release;
  watchlistMutexTail = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function dependencies(overrides = {}) {
  return {
    evaluate: overrides.evaluate || evaluate,
    evaluateAsync: overrides.evaluateAsync || evaluateAsync,
    getClient: overrides.getClient || getClient,
    wait: overrides.wait || (ms => new Promise(resolve => setTimeout(resolve, ms))),
  };
}

function cleanText(value, label, maxLength) {
  if (typeof value !== 'string') throw watchlistError(`Active watchlist ${label} must be a string`);
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) throw watchlistError(`Active watchlist ${label} is empty`);
  if (cleaned.length > maxLength) throw watchlistError(`Active watchlist ${label} is too long`);
  return cleaned;
}

function watchlistError(message) {
  const error = new Error(message);
  error.code = 'watchlist_active_read_failed';
  return error;
}

function cleanId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw watchlistError('Active watchlist id is invalid');
    return String(value);
  }
  return cleanText(value, 'id', 160);
}

function cleanSymbol(value, index) {
  if (typeof value !== 'string') {
    throw watchlistError(`Active watchlist symbol at index ${index} must be a string`);
  }
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) {
    throw watchlistError(`Active watchlist symbol at index ${index} contains control characters`);
  }
  const cleaned = value.trim();
  if (!cleaned) throw watchlistError(`Active watchlist symbol at index ${index} is empty`);
  if (cleaned.length > 256) throw watchlistError(`Active watchlist symbol at index ${index} is too long`);
  return cleaned;
}

function normalizeActiveList(raw, phase) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw watchlistError(`Active watchlist ${phase} response is not an object`);
  }
  if (!Array.isArray(raw.symbols)) {
    throw watchlistError(`Active watchlist ${phase} response has no symbols array`);
  }
  if (raw.symbols.length > 10_000
    || (raw.symbol_count != null
      && (!Number.isSafeInteger(raw.symbol_count)
        || raw.symbol_count < 0
        || raw.symbol_count > 10_000
        || raw.symbol_count !== raw.symbols.length))) {
    throw watchlistError(`Active watchlist ${phase} response has an invalid symbol count`);
  }

  const symbols = [];
  const seen = new Set();
  let sectionCount = 0;
  for (let index = 0; index < raw.symbols.length; index++) {
    const symbol = cleanSymbol(raw.symbols[index], index);
    if (symbol.startsWith('###')) {
      sectionCount++;
      continue;
    }
    if (!/^[^:\s]+:[^:\s]+$/.test(symbol)) {
      throw watchlistError(`Active watchlist symbol ${symbol} is not exchange-qualified`);
    }
    const identity = symbol.toUpperCase();
    if (seen.has(identity)) throw watchlistError(`Active watchlist contains duplicate symbol ${symbol}`);
    seen.add(identity);
    symbols.push(symbol);
  }

  return {
    id: cleanId(raw.id),
    name: cleanText(raw.name, 'name', 200),
    type: raw.type == null ? null : cleanText(raw.type, 'type', 80),
    symbols,
    section_count: sectionCount,
  };
}

function sameSymbols(left, right) {
  return left.length === right.length && left.every((symbol, index) => symbol === right[index]);
}

function validateRead(result, phase) {
  const status = Number(result?.status) || 0;
  const code = result?.error;
  if (result?.ok === true && status >= 200 && status < 300) return result.data;
  if (status === 401 || status === 403) {
    throw watchlistError(`Active watchlist REST ${phase} read was not authorized (HTTP ${status})`);
  }
  if (code === 'invalid_json' || code === 'non_json_response') {
    throw watchlistError(`Active watchlist REST ${phase} read returned invalid JSON`);
  }
  if (status) throw watchlistError(`Active watchlist REST ${phase} read failed (HTTP ${status})`);
  throw watchlistError(`Active watchlist REST ${phase} read was unavailable`);
}

async function getUnlocked(deps) {
  let result;
  try {
    result = await deps.evaluateAsync(WATCHLIST_ACTIVE_READ_EXPRESSION);
  } catch (error) {
    const detail = String(error?.message || error || 'unknown error')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 200);
    throw watchlistError(`Active watchlist REST read was unavailable: ${detail}`);
  }
  const first = normalizeActiveList(validateRead(result?.first, 'first'), 'first');
  const second = normalizeActiveList(validateRead(result?.second, 'second'), 'second');
  if (first.id !== second.id || first.name !== second.name || first.type !== second.type
    || !sameSymbols(first.symbols, second.symbols)) {
    const error = new Error('Active watchlist identity or membership changed between the two authoritative reads');
    error.code = 'watchlist_active_changed';
    throw error;
  }

  return {
    success: true,
    count: second.symbols.length,
    source: 'active_list_rest_api',
    list_id: second.id,
    list_name: second.name,
    symbols: second.symbols.map(symbol => ({
      symbol,
      last: null,
      change: null,
      change_percent: null,
      volume: null,
    })),
    traversal: {
      complete: true,
      metadata_verified: true,
      consistency_reads: 2,
      expected_count: second.symbols.length,
      filtered_section_count: second.section_count,
    },
    restoration: {
      ui_mutation: false,
      panel: {
        required: false,
        attempted: false,
        changed: false,
        verified: true,
        baseline_mode: 'not_touched',
        final_mode: 'not_touched',
      },
      scroll: {
        required: false,
        verified: true,
        initial_scroll_top: null,
        final_scroll_top: null,
      },
    },
  };
}

// The mutating add/remove paths still need the widget to be mounted.
async function ensureWatchlistOpen(deps, maxWaitMs = 5000) {
  const state = await deps.evaluate(`
    (function() {
      var btn = ${WL_BUTTON_JS};
      if (!btn) return { error: 'Watchlist button not found' };
      var pressed = btn.getAttribute('aria-pressed') === 'true';
      var widgetReady = !!(document.querySelector('[data-name="add-symbol-button"]')
        || document.querySelector('[class*="layout__area--right"] [data-symbol-full]'));
      if (!pressed || !widgetReady) { if (!pressed) btn.click(); return { opened: !pressed }; }
      return { opened: false, ready: true };
    })()
  `);
  if (state?.error) throw new Error(state.error);
  if (state?.ready) return { opened: false };

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const ready = await deps.evaluate(`
      !!(document.querySelector('[data-name="add-symbol-button"]')
        || document.querySelector('[class*="layout__area--right"] [data-symbol-full]'))
    `);
    if (ready) return { opened: !!state?.opened };
    await deps.wait(250);
  }
  throw new Error('Watchlist panel did not become ready. The right panel may be blank or unavailable.');
}

// Legacy React metadata is retained only for the established remove path.
async function getActiveListInfo(deps) {
  return deps.evaluate(`
    (function() {
      function visible(element) {
        if (!element) return false;
        var rect = element.getBoundingClientRect();
        return rect.width > 10 && rect.height > 10;
      }
      var roots = Array.from(document.querySelectorAll('[data-name="symbol-list-wrap"]')).filter(visible);
      if (roots.length !== 1) return null;
      var rows = roots[0].querySelectorAll('[data-symbol-full]');
      if (!rows.length) return null;
      var row = rows[0];
      var reactKey = Object.keys(row).find(function(k) { return k.indexOf('__reactFiber') === 0; });
      if (!reactKey) return null;
      var fiber = row[reactKey];
      var count = 0;
      while (fiber && count < 45) {
        if (fiber.memoizedProps && fiber.memoizedProps.current
          && fiber.memoizedProps.current.id
          && Array.isArray(fiber.memoizedProps.current.symbols)) {
          var cur = fiber.memoizedProps.current;
          return { id: cur.id, name: cur.name, symbols: cur.symbols };
        }
        fiber = fiber.return;
        count++;
      }
      return null;
    })()
  `);
}

async function addUnlocked({ symbol }, deps) {
  const client = await deps.getClient();
  await ensureWatchlistOpen(deps);

  const addClicked = await deps.evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="add-symbol-button"]')
        || document.querySelector('[aria-label="Add symbol"]')
        || document.querySelector('[aria-label*="Add symbol"]');
      if (!btn || btn.offsetParent === null) return { found: false };
      btn.click();
      return { found: true };
    })()
  `);
  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await deps.wait(400);

  await client.Input.insertText({ text: symbol });
  await deps.wait(700);
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await deps.wait(400);
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
  await deps.wait(400);

  const bare = symbol.split(':').pop().toUpperCase();
  const verified = await deps.evaluate(`
    (function() {
      var rows = document.querySelectorAll('[class*="layout__area--right"] [data-symbol-full]');
      for (var i = 0; i < rows.length; i++) {
        var s = rows[i].getAttribute('data-symbol-full') || '';
        if (s.toUpperCase() === ${JSON.stringify(symbol.toUpperCase())}
          || s.split(':').pop().toUpperCase() === ${JSON.stringify(bare)}) return s;
      }
      return null;
    })()
  `);
  return { success: !!verified, symbol, added_as: verified, action: verified ? 'added' : 'not_verified' };
}

async function addBulkUnlocked({ symbols }, deps) {
  const results = [];
  for (const symbol of symbols) {
    try {
      const result = await addUnlocked({ symbol }, deps);
      results.push({ symbol, success: result.success, added_as: result.added_as });
    } catch (error) {
      results.push({ symbol, success: false, error: error.message });
    }
  }
  const added = results.filter(result => result.success).length;
  return { success: added > 0, added, failed: results.length - added, results };
}

async function removeUnlocked({ symbols }, deps) {
  await ensureWatchlistOpen(deps);
  const listInfo = await getActiveListInfo(deps);
  if (!listInfo) throw new Error('Cannot read active watchlist metadata (React fiber probe failed)');

  const toRemove = [];
  const skipped = [];
  for (const symbol of symbols) {
    if (symbol.includes(':')) {
      if (listInfo.symbols.includes(symbol)) toRemove.push(symbol);
      else skipped.push(symbol);
    } else {
      const match = listInfo.symbols.find(item => item.split(':').pop().toUpperCase() === symbol.toUpperCase());
      if (match) toRemove.push(match);
      else skipped.push(symbol);
    }
  }
  if (!toRemove.length) {
    return { success: false, removed: [], skipped, error: 'No matching symbols in the active watchlist' };
  }

  const response = await deps.evaluateAsync(`
    fetch('https://www.tradingview.com/api/v1/symbols_list/custom/' + ${JSON.stringify(listInfo.id)} + '/remove/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(${JSON.stringify(toRemove)})
    })
      .then(function(r) { return r.text().then(function(t) { return { status: r.status, ok: r.ok, body: t.substring(0, 300) }; }); })
      .catch(function(e) { return { status: 0, ok: false, body: String(e) }; })
  `);
  if (!response?.ok) {
    throw new Error(`Watchlist remove REST call failed (HTTP ${response?.status}): ${response?.body}`);
  }

  await deps.evaluate(`(function() { var btn = ${WL_BUTTON_JS}; if (btn) btn.click(); })()`);
  await deps.wait(400);
  await deps.evaluate(`(function() { var btn = ${WL_BUTTON_JS}; if (btn) btn.click(); })()`);

  let stillPresent = toRemove;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await deps.wait(500);
    stillPresent = await deps.evaluate(`
      (function() {
        var rows = document.querySelectorAll('[class*="layout__area--right"] [data-symbol-full]');
        var present = {};
        for (var i = 0; i < rows.length; i++) present[rows[i].getAttribute('data-symbol-full')] = true;
        return ${JSON.stringify(toRemove)}.filter(function(s) { return present[s]; });
      })()
    `) || [];
    if (stillPresent.length === 0) break;
  }

  return {
    success: true,
    removed: toRemove,
    skipped,
    verified: stillPresent.length === 0,
    list_id: listInfo.id,
    list_name: listInfo.name,
    api: 'rest',
  };
}

export async function get({ _deps } = {}) {
  const deps = dependencies(_deps);
  return withWatchlistMutex(() => getUnlocked(deps));
}

export async function add({ symbol, _deps }) {
  const deps = dependencies(_deps);
  return withWatchlistMutex(() => addUnlocked({ symbol }, deps));
}

export async function addBulk({ symbols, _deps }) {
  const deps = dependencies(_deps);
  return withWatchlistMutex(() => addBulkUnlocked({ symbols }, deps));
}

export async function remove({ symbols, _deps }) {
  const deps = dependencies(_deps);
  return withWatchlistMutex(() => removeUnlocked({ symbols }, deps));
}
