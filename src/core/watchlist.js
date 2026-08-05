/**
 * Core watchlist logic.
 * Reads via DOM rows (panel auto-opened when needed). Removal uses
 * TradingView's symbols_list REST API from the page context (cookie auth),
 * mirroring the proven alerts REST pattern. Add drives the Add-symbol
 * search UI so bare tickers resolve the same way they do for a human.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// TV renamed the right-rail button: current builds use data-name="base" with
// aria-label "Watchlist, details, and news"; older builds used
// data-name="base-watchlist-widget-button" / aria-label "Watchlist".
const WL_BUTTON_JS = `(document.querySelector('[data-name="base-watchlist-widget-button"]')
  || document.querySelector('[aria-label="Watchlist, details, and news"]')
  || document.querySelector('[aria-label^="Watchlist"]'))`;

// The watchlist widget lazy-loads after the panel opens; a fixed 500ms wait
// raced it (issue #164). Poll until its Add-symbol button or rows exist.
async function ensureWatchlistOpen(maxWaitMs = 5000) {
  const state = await evaluate(`
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
    const ready = await evaluate(`
      !!(document.querySelector('[data-name="add-symbol-button"]')
        || document.querySelector('[class*="layout__area--right"] [data-symbol-full]'))
    `);
    if (ready) return { opened: !!state?.opened };
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Watchlist panel did not become ready. Is a watchlist widget configured in the right panel?');
}

// Active watchlist metadata (id, name, symbols) read from the React fiber
// tree — needed for the REST endpoints. Approach from PR #65.
async function getActiveListInfo() {
  return evaluate(`
    (function() {
      var panel = document.querySelector('[class*="layout__area--right"]');
      if (!panel) return null;
      var rows = panel.querySelectorAll('[data-symbol-full]');
      if (!rows.length) return null;
      var row = rows[0];
      var reactKey = Object.keys(row).find(function(k) { return k.indexOf('__reactFiber') === 0; });
      if (!reactKey) return null;
      var fiber = row[reactKey];
      var count = 0;
      while (fiber && count < 45) {
        if (fiber.memoizedProps && fiber.memoizedProps.current && fiber.memoizedProps.current.id) {
          var cur = fiber.memoizedProps.current;
          return { id: cur.id, name: cur.name, symbols: cur.symbols || [] };
        }
        fiber = fiber.return;
        count++;
      }
      return null;
    })()
  `);
}

export async function get() {
  await ensureWatchlistOpen();

  // Positional cell mapping (name, last, change, change%, volume) with
  // Unicode-minus normalization. The old regex classifier dropped every
  // negative value (TV renders U+2212, not ASCII '-') and all tick-notation
  // prices like 106'28'7 — issue #111.
  const data = await evaluate(`
    (function() {
      function norm(t) { return t.replace(/\\u2212/g, '-').trim(); }
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };
      var results = [];
      var seen = {};
      var symbolEls = container.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < symbolEls.length; i++) {
        var sym = symbolEls[i].getAttribute('data-symbol-full');
        if (!sym || seen[sym]) continue;
        seen[sym] = true;
        var row = symbolEls[i].closest('[class*="row"]') || symbolEls[i].parentElement;
        var cells = row ? row.querySelectorAll('[class*="cell"], [class*="column"]') : [];
        var texts = [];
        for (var j = 0; j < cells.length; j++) texts.push(norm(cells[j].textContent));
        results.push({
          symbol: sym,
          last: texts[1] || null,
          change: texts[2] || null,
          change_percent: texts[3] || null,
          volume: texts[4] || null,
        });
      }
      return { symbols: results, source: results.length ? 'dom_rows' : 'empty' };
    })()
  `);

  const listInfo = await getActiveListInfo();
  return {
    success: true,
    count: data?.symbols?.length || 0,
    source: data?.source || 'unknown',
    ...(listInfo && { list_id: listInfo.id, list_name: listInfo.name }),
    symbols: data?.symbols || [],
  };
}

export async function add({ symbol }) {
  const c = await getClient();
  await ensureWatchlistOpen();

  const addClicked = await evaluate(`
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
  await new Promise(r => setTimeout(r, 400));

  await c.Input.insertText({ text: symbol });
  await new Promise(r => setTimeout(r, 700));
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise(r => setTimeout(r, 400));
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
  await new Promise(r => setTimeout(r, 400));

  // Verify the row actually appeared instead of reporting blind success.
  const bare = symbol.split(':').pop().toUpperCase();
  const verified = await evaluate(`
    (function() {
      var rows = document.querySelectorAll('[class*="layout__area--right"] [data-symbol-full]');
      for (var i = 0; i < rows.length; i++) {
        var s = rows[i].getAttribute('data-symbol-full') || '';
        if (s.toUpperCase() === ${JSON.stringify(symbol.toUpperCase())} || s.split(':').pop().toUpperCase() === ${JSON.stringify(bare)}) return s;
      }
      return null;
    })()
  `);

  return { success: !!verified, symbol, added_as: verified, action: verified ? 'added' : 'not_verified' };
}

export async function addBulk({ symbols }) {
  const results = [];
  for (const symbol of symbols) {
    try {
      const r = await add({ symbol });
      results.push({ symbol, success: r.success, added_as: r.added_as });
    } catch (err) {
      results.push({ symbol, success: false, error: err.message });
    }
  }
  const added = results.filter(r => r.success).length;
  return { success: added > 0, added, failed: results.length - added, results };
}

export async function remove({ symbols }) {
  await ensureWatchlistOpen();
  const listInfo = await getActiveListInfo();
  if (!listInfo) throw new Error('Cannot read active watchlist metadata (React fiber probe failed)');

  // Match requested symbols (bare or EXCHANGE:SYMBOL) against the list.
  const toRemove = [];
  const skipped = [];
  for (const sym of symbols) {
    if (sym.includes(':')) {
      if (listInfo.symbols.includes(sym)) toRemove.push(sym);
      else skipped.push(sym);
    } else {
      const match = listInfo.symbols.find(s => s.split(':').pop().toUpperCase() === sym.toUpperCase());
      if (match) toRemove.push(match);
      else skipped.push(sym);
    }
  }
  if (!toRemove.length) {
    return { success: false, removed: [], skipped, error: 'No matching symbols in the active watchlist' };
  }

  // Page-context fetch — browser attaches session cookies automatically.
  const resp = await evaluateAsync(`
    fetch('https://www.tradingview.com/api/v1/symbols_list/custom/' + ${JSON.stringify(listInfo.id)} + '/remove/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(${JSON.stringify(toRemove)}),
    })
      .then(function(r) { return r.text().then(function(t) { return { status: r.status, ok: r.ok, body: t.substring(0, 300) }; }); })
      .catch(function(e) { return { status: 0, ok: false, body: String(e) }; })
  `);

  if (!resp?.ok) {
    throw new Error(`Watchlist remove REST call failed (HTTP ${resp?.status}): ${resp?.body}`);
  }

  // The desktop widget doesn't live-sync API removals — remount it by
  // toggling the panel, then verify the rows are actually gone.
  await evaluate(`(function() { var btn = ${WL_BUTTON_JS}; if (btn) btn.click(); })()`);
  await new Promise(r => setTimeout(r, 400));
  await evaluate(`(function() { var btn = ${WL_BUTTON_JS}; if (btn) btn.click(); })()`);

  let stillPresent = toRemove;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    stillPresent = await evaluate(`
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
    success: true, removed: toRemove, skipped,
    verified: stillPresent.length === 0,
    list_id: listInfo.id, list_name: listInfo.name, api: 'rest',
  };
}

// ---- Whole-watchlist management (list / create / delete / switch) ----
// Extends the proven symbols_list REST pattern from remove(). The base path and
// the /custom/ segment are proven; the list-level verbs are the natural
// extension of that same API and surface HTTP status/body on failure so a
// wrong guess is diagnosable rather than silent.
const SYMBOLS_LIST_BASE = 'https://www.tradingview.com/api/v1/symbols_list';

// After any REST mutation the desktop widget does not live-sync — toggle the
// right-rail panel closed+open to force it to refetch. Extracted from remove(),
// which opens the panel first; without that precondition the bare toggle would
// leave a panel that started closed still closed (open->close->open only holds
// when it started open), so a later getActiveListInfo() DOM read finds no rows.
async function remountWatchlist() {
  await ensureWatchlistOpen();
  await evaluate(`(function() { var btn = ${WL_BUTTON_JS}; if (btn) btn.click(); })()`);
  await new Promise(r => setTimeout(r, 400));
  await evaluate(`(function() { var btn = ${WL_BUTTON_JS}; if (btn) btn.click(); })()`);
  await new Promise(r => setTimeout(r, 400));
}

// Resolve a caller-supplied {id|name} to a concrete list id via listLists().
async function resolveListId({ id, name, _deps } = {}) {
  if (id) return String(id);
  if (!name) throw new Error('Provide a watchlist id or name.');
  const { lists } = await listLists({ _deps });
  const match = lists.find(l => l.name === name)
    || lists.find(l => (l.name || '').toLowerCase() === String(name).toLowerCase());
  if (!match) {
    throw new Error(`No watchlist named "${name}". Available: ${lists.map(l => l.name).join(', ') || '(none)'}`);
  }
  return String(match.id);
}

// List every custom watchlist (id, name, symbol count, active flag).
export async function listLists({ _deps } = {}) {
  const evalAsync = _deps?.evaluateAsync || evaluateAsync;
  const activeInfo = _deps?.getActiveListInfo || getActiveListInfo;
  const result = await evalAsync(`
    fetch('${SYMBOLS_LIST_BASE}/custom/', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then(function(r) { return r.text().then(function(t) {
        var d = null; try { d = JSON.parse(t); } catch (e) {}
        return { status: r.status, ok: r.ok, data: d, body: t.substring(0, 300) };
      }); })
      .catch(function(e) { return { status: 0, ok: false, data: null, body: String(e) }; })
  `);
  // Some builds return a bare array; others wrap as { lists: [...] } or { r: [...] }.
  const raw = Array.isArray(result?.data) ? result.data
    : (result?.data?.lists || result?.data?.r || null);
  if (!result?.ok || !Array.isArray(raw)) {
    throw new Error(`Could not list watchlists (HTTP ${result?.status ?? '?'}): ${result?.body || 'unexpected response'}`);
  }

  // Best-effort: mark which list is active using the proven fiber probe.
  let activeId = null;
  try { const info = await activeInfo(); activeId = info?.id ?? null; } catch {}

  const lists = raw.map(l => ({
    id: l.id,
    name: l.name,
    symbol_count: Array.isArray(l.symbols) ? l.symbols.length : (l.symbols_count ?? null),
    type: l.type || 'custom',
    color: l.color ?? null,
    active: activeId != null ? (String(l.id) === String(activeId)) : (l.active ?? null),
  }));
  return { success: true, source: 'rest', count: lists.length, active_id: activeId, lists };
}

// Create a new named list, optionally seeded with symbols (EXCHANGE:SYMBOL preferred).
export async function createList({ name, symbols = [], _deps } = {}) {
  if (!name) throw new Error('name is required to create a watchlist.');
  const evalAsync = _deps?.evaluateAsync || evaluateAsync;
  const resp = await evalAsync(`
    fetch('${SYMBOLS_LIST_BASE}/custom/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ name: ${JSON.stringify(name)}, symbols: ${JSON.stringify(symbols)} }),
    })
      .then(function(r) { return r.text().then(function(t) {
        var d = null; try { d = JSON.parse(t); } catch (e) {}
        return { status: r.status, ok: r.ok, data: d, body: t.substring(0, 300) };
      }); })
      .catch(function(e) { return { status: 0, ok: false, data: null, body: String(e) }; })
  `);
  if (!resp?.ok) {
    throw new Error(`Create watchlist failed (HTTP ${resp?.status}): ${resp?.body}`);
  }
  if (!_deps) await remountWatchlist();
  return {
    success: true, source: 'rest',
    list_id: resp.data?.id ?? null,
    name: resp.data?.name ?? name,
    symbols,
  };
}

// Delete a list by id or name.
export async function deleteList({ id, name, _deps } = {}) {
  const listId = await resolveListId({ id, name, _deps });
  const evalAsync = _deps?.evaluateAsync || evaluateAsync;
  const resp = await evalAsync(`
    fetch('${SYMBOLS_LIST_BASE}/custom/' + ${JSON.stringify(listId)} + '/', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then(function(r) { return r.text().then(function(t) {
        return { status: r.status, ok: r.ok, body: t.substring(0, 300) };
      }); })
      .catch(function(e) { return { status: 0, ok: false, body: String(e) }; })
  `);
  if (!resp?.ok) {
    throw new Error(`Delete watchlist failed (HTTP ${resp?.status}): ${resp?.body}`);
  }
  if (!_deps) await remountWatchlist();
  return { success: true, source: 'rest', deleted_id: listId };
}

// Switch the active list. Tries the REST set-active verb first, then falls back
// to clicking the watchlist name dropdown in the widget (DOM). Verifies via the
// fiber probe that the active list actually changed.
export async function switchList({ id, name, _deps } = {}) {
  const listId = await resolveListId({ id, name, _deps });
  const evalAsync = _deps?.evaluateAsync || evaluateAsync;

  // Attempt 1: REST set-active (best-effort — the endpoint is inferred).
  const rest = await evalAsync(`
    fetch('${SYMBOLS_LIST_BASE}/custom/' + ${JSON.stringify(listId)} + '/set_active/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: '{}',
    })
      .then(function(r) { return { status: r.status, ok: r.ok }; })
      .catch(function(e) { return { status: 0, ok: false, error: String(e) }; })
  `);

  let method = 'rest';
  if (!rest?.ok) {
    // Attempt 2: DOM fallback — open panel, open the list dropdown, click target.
    // The dropdown exposes only visible text (no list-id handle), so resolve a
    // display name to match on. The caller may have passed only an id, in which
    // case look the name up from listLists() rather than matching on an empty
    // string (which would never match anything).
    method = 'dom';
    let targetName = name;
    if (!targetName) {
      try {
        const { lists } = await listLists({ _deps });
        targetName = (lists || []).find(l => String(l.id) === String(listId))?.name || '';
      } catch {}
    }
    if (!targetName) {
      throw new Error(`Cannot switch watchlist ${listId} via the DOM fallback: no list name available to match (REST set-active returned HTTP ${rest?.status}). Retry passing the watchlist name.`);
    }
    await ensureWatchlistOpen();
    await evaluate(`
      (function() {
        var btn = document.querySelector('[data-name="watchlists-button"]')
          || document.querySelector('[data-name="watchlist-select-dialog-button"]')
          || document.querySelector('[class*="layout__area--right"] [data-name*="watchlist"][aria-haspopup]');
        if (btn) btn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 400));
    const clicked = await evaluate(`
      (function() {
        var target = ${JSON.stringify(String(targetName))}.toLowerCase();
        var items = document.querySelectorAll('[role="menuitem"], [class*="item"] [class*="title"], [data-name="watchlists-dialog"] [class*="row"]');
        for (var i = 0; i < items.length; i++) {
          var t = (items[i].textContent || '').trim().toLowerCase();
          if (t && target && t.indexOf(target) !== -1) { items[i].click(); return true; }
        }
        return false;
      })()
    `);
    if (!clicked) {
      throw new Error(`Could not switch watchlist via REST (HTTP ${rest?.status}) or DOM (name "${targetName}" not found in list dropdown).`);
    }
    await new Promise(r => setTimeout(r, 400));
  } else {
    await remountWatchlist();
  }

  // Verify the active list is now the requested one.
  let verified = false;
  try { const info = await getActiveListInfo(); verified = String(info?.id) === String(listId); } catch {}
  return { success: true, source: method, active_id: listId, verified };
}
