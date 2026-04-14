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

/**
 * Helper: dispatch real mouse events (mousedown → mouseup → click).
 * TradingView Desktop ignores synthetic .click() calls — React event
 * handlers only fire on MouseEvent dispatches with proper coordinates.
 */
function _realClick(btnSelector) {
  return `
    (function() {
      var btn = document.querySelector('${btnSelector}');
      if (!btn || btn.offsetParent === null) return { found: false };
      var r = btn.getBoundingClientRect();
      var x = r.x + r.width/2, y = r.y + r.height/2;
      ['mousedown','mouseup','click'].forEach(function(t) {
        btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y }));
      });
      return { found: true };
    })()
  `;
}

export async function add({ symbol }) {
  const c = await getClient();

  // Ensure watchlist panel is open
  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1
        || btn.classList.toString().indexOf('active') !== -1;
      if (!isActive) {
        var r = btn.getBoundingClientRect();
        var x = r.x + r.width/2, y = r.y + r.height/2;
        ['mousedown','mouseup','click'].forEach(function(t) {
          btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y }));
        });
        return { opened: true };
      }
      return { opened: false };
    })()
  `);

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  // Click "Add symbol" button with real mouse events
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
        if (btn && btn.offsetParent !== null) {
          var r = btn.getBoundingClientRect();
          var x = r.x + r.width/2, y = r.y + r.height/2;
          ['mousedown','mouseup','click'].forEach(function(t) {
            btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y }));
          });
          return { found: true, selector: selectors[s] };
        }
      }
      return { found: false };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await new Promise(r => setTimeout(r, 500));

  // Type the symbol
  await c.Input.insertText({ text: symbol });
  await new Promise(r => setTimeout(r, 800));

  // Press Enter to select first result
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise(r => setTimeout(r, 500));

  // Press Escape to close search dialog
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, symbol, action: 'added' };
}

/**
 * Remove symbols from the active watchlist via TradingView REST API.
 * Strategy: read watchlist metadata from React fiber, extract HttpOnly
 * session cookies via CDP Network.getCookies, then call the /remove/
 * endpoint from Node.js (server-side) with proper authentication.
 * Falls back to UI-based delete (click row + Delete key) if REST fails.
 */
export async function remove({ symbols }) {
  const c = await getClient();

  // Get the active watchlist metadata from the React fiber tree
  const listInfo = await evaluate(`
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
          return { id: cur.id, name: cur.name, symbols: cur.symbols };
        }
        fiber = fiber.return;
        count++;
      }
      return null;
    })()
  `);

  if (!listInfo) throw new Error('Cannot read active watchlist — is the watchlist panel open?');

  // Normalise input symbols to EXCHANGE:SYMBOL format
  const toRemove = [];
  const skipped = [];
  for (const sym of symbols) {
    if (sym.includes(':')) {
      if (listInfo.symbols.includes(sym)) toRemove.push(sym);
      else skipped.push(sym);
    } else {
      const match = listInfo.symbols.find(s => s.split(':')[1] === sym.toUpperCase());
      if (match) toRemove.push(match);
      else skipped.push(sym);
    }
  }

  if (toRemove.length === 0) {
    return { success: true, removed: [], skipped, message: 'No matching symbols in watchlist' };
  }

  // --- Strategy 1: Node.js-side REST API call with CDP-extracted cookies ---
  try {
    await c.Network.enable();
    const { cookies } = await c.Network.getCookies({ urls: ['https://www.tradingview.com'] });
    const cookieHeader = cookies.map(ck => `${ck.name}=${ck.value}`).join('; ');

    const resp = await fetch(`https://www.tradingview.com/api/v1/symbols_list/custom/${listInfo.id}/remove/?source=web-tvd`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Language': 'en',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://www.tradingview.com',
        'Referer': 'https://www.tradingview.com/',
        'Cookie': cookieHeader,
      },
      body: JSON.stringify(toRemove),
    });

    if (resp.ok) {
      // Refresh the watchlist UI so it reflects the removal
      await evaluate(`
        (function() {
          // Trigger a re-render by toggling the panel
          var evt = new Event('resize');
          window.dispatchEvent(evt);
        })()
      `);
      return { success: true, removed: toRemove, skipped, api: 'rest', listId: listInfo.id, listName: listInfo.name };
    }

    // If REST failed, log and fall through to UI method
    const errBody = await resp.text().catch(() => '');
    console.error(`REST remove failed (${resp.status}): ${errBody}`);
  } catch (err) {
    console.error(`REST remove error: ${err.message}`);
  }

  // --- Strategy 2: UI-based delete (click row + Delete key) ---
  return _removeViaUI({ symbols: toRemove, skipped });
}

/**
 * Fallback: remove symbols by selecting each row and pressing Delete.
 * Slower but reliable — uses CDP native Input events.
 */
async function _removeViaUI({ symbols, skipped = [] }) {
  const c = await getClient();
  const results = [];

  for (const sym of symbols) {
    // Find the row in the DOM and get its coordinates
    const rowInfo = await evaluate(`
      (function() {
        var panel = document.querySelector('[class*="layout__area--right"]');
        if (!panel) return null;
        var rows = panel.querySelectorAll('[data-symbol-full]');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].getAttribute('data-symbol-full') === ${JSON.stringify(sym)}) {
            var el = rows[i].closest('[class*="row"]') || rows[i];
            var r = el.getBoundingClientRect();
            return { x: r.x + r.width/2, y: r.y + r.height/2, found: true };
          }
        }
        return { found: false };
      })()
    `);

    if (!rowInfo || !rowInfo.found) {
      results.push({ symbol: sym, removed: false, reason: 'not_visible_in_scroll' });
      continue;
    }

    // Click the row using CDP native mouse events (not JS dispatchEvent)
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: rowInfo.x, y: rowInfo.y, button: 'left', clickCount: 1 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: rowInfo.x, y: rowInfo.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 200));

    // Press Delete key
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Delete', code: 'Delete' });
    await new Promise(r => setTimeout(r, 300));

    results.push({ symbol: sym, removed: true });
  }

  return {
    success: true,
    removed: results.filter(r => r.removed).map(r => r.symbol),
    skipped,
    results,
    api: 'ui',
  };
}

export async function addBulk({ symbols }) {
  // Add multiple symbols in one "Add symbol" dialog session.
  // TradingView keeps the dialog open between adds — just clear and retype.
  const c = await getClient();

  // Ensure watchlist panel is open
  await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return;
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1;
      if (!isActive) {
        var r = btn.getBoundingClientRect();
        ['mousedown','mouseup','click'].forEach(function(t) {
          btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:r.x+r.width/2, clientY:r.y+r.height/2 }));
        });
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 500));

  // Open the Add symbol dialog once
  const addClicked = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Add symbol"]')
        || document.querySelector('[data-name="add-symbol-button"]');
      if (!btn || btn.offsetParent === null) return { found: false };
      var r = btn.getBoundingClientRect();
      ['mousedown','mouseup','click'].forEach(function(t) {
        btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:r.x+r.width/2, clientY:r.y+r.height/2 }));
      });
      return { found: true };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found');
  await new Promise(r => setTimeout(r, 500));

  const results = [];
  for (const sym of symbols) {
    // Select all text in input and replace with new symbol
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }); // Cmd+A
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
    await new Promise(r => setTimeout(r, 100));

    await c.Input.insertText({ text: sym });
    await new Promise(r => setTimeout(r, 800));

    // Enter to select first result
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
    await new Promise(r => setTimeout(r, 500));

    results.push({ symbol: sym, added: true });
  }

  // Close dialog
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, count: results.length, symbols: results };
}
