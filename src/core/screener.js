/**
 * Core Stock Screener logic.
 *
 * The TradingView Screener is a floating dialog (not a docked side panel),
 * toggled via the right-toolbar button [data-name="screener-dialog-button"].
 *
 * Open state: .js-dialog.visible-RY6N1NHl contains [class*="screenerContainer"]
 * When open, the dialog covers the toolbar button, so close via the dialog's
 * own "Close" button rather than the toolbar toggle.
 *
 * Per CONTRIBUTING.md: UI automation only (no direct REST/server access).
 */
import {
  evaluate as _evaluate,
  getClient as _getClient,
  requireFinite,
} from '../connection.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getClient: deps?.getClient || _getClient,
  };
}

const IS_OPEN_EXPR = `
  (function() {
    var container = document.querySelector('[class*="screenerContainer"]');
    if (!container) return { open: false };
    var dialog = container.closest('[class*="js-dialog"]');
    var visible = dialog && /visible-/.test(dialog.className) && container.offsetParent !== null;
    if (!visible) return { open: false };
    var rect = container.getBoundingClientRect();
    // Check whether rows have loaded (first symbol cell has real text).
    var firstRow = container.querySelector('tbody tr');
    var firstCell = firstRow ? firstRow.querySelector('td') : null;
    var firstCellText = firstCell ? (firstCell.textContent || '').trim() : '';
    return {
      open: true,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      data_loaded: firstCellText.length > 0,
    };
  })()
`;

export async function status({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const state = await evaluate(IS_OPEN_EXPR);
  return { success: true, open: !!state?.open, width: state?.width ?? null, height: state?.height ?? null };
}

export async function open({ _deps } = {}) {
  const { evaluate, getClient } = _resolve(_deps);

  const initial = await evaluate(IS_OPEN_EXPR);
  if (initial?.open) {
    return { success: true, action: 'already_open', open: true, width: initial.width, height: initial.height };
  }

  // Toolbar button is in the right-toolbar. Programmatic .click() doesn't fire
  // the app's handler, so we need a real CDP mouse click.
  const btnRect = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="screener-dialog-button"]');
      if (!btn) return null;
      var r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()
  `);
  if (!btnRect) throw new Error('Screener toolbar button not found (is the chart toolbar visible?)');

  const cx = requireFinite(btnRect.x, 'button.x');
  const cy = requireFinite(btnRect.y, 'button.y');

  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: cx, y: cy });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left' });

  // Wait for dialog to appear AND data to load (poll up to ~6s). First open
  // can be slow while TradingView fetches screener rows from its servers.
  let lastSeen = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200));
    const s = await evaluate(IS_OPEN_EXPR);
    if (s?.open && s?.data_loaded) {
      return { success: true, action: 'opened', open: true, width: s.width, height: s.height };
    }
    if (s?.open) lastSeen = s;
  }
  if (lastSeen) {
    // Dialog opened but rows never populated. Return success with a warning
    // rather than failing — the caller can still see columns, and the next
    // screener_get will pick up rows when they arrive.
    return {
      success: true,
      action: 'opened',
      open: true,
      width: lastSeen.width,
      height: lastSeen.height,
      warning: 'Dialog opened but rows did not populate within 6s; call screener_get again shortly.',
    };
  }
  throw new Error('Screener did not open within 6s (dialog not found)');
}

export async function close({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);

  const state = await evaluate(IS_OPEN_EXPR);
  if (!state?.open) return { success: true, action: 'already_closed', open: false };

  // Click the Close button scoped to the screener dialog.
  const result = await evaluate(`
    (function() {
      var container = document.querySelector('[class*="screenerContainer"]');
      if (!container) return { found: false, reason: 'no_container' };
      var dialog = container.closest('[class*="js-dialog"]');
      if (!dialog) return { found: false, reason: 'no_dialog' };
      var closeBtn = dialog.querySelector('button[aria-label="Close"]');
      if (!closeBtn) return { found: false, reason: 'no_close_button' };
      closeBtn.click();
      return { found: true };
    })()
  `);
  if (!result?.found) throw new Error('Close button not found: ' + (result?.reason || 'unknown'));

  // Wait for dialog to disappear (poll up to 2s)
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 200));
    const s = await evaluate(IS_OPEN_EXPR);
    if (!s?.open) return { success: true, action: 'closed', open: false };
  }
  throw new Error('Screener did not close within 2s');
}

export async function get({ limit, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const cap = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit))) : 100;

  const data = await evaluate(`
    (function() {
      var container = document.querySelector('[class*="screenerContainer"]');
      if (!container || container.offsetParent === null) {
        return { open: false };
      }

      // Current screen/preset name (e.g., "All stocks")
      var titleEl = document.querySelector('[data-name="screener-topbar-screen-title"]');
      var title = titleEl ? (titleEl.textContent || '').trim() : null;

      // Markets / source tabs visible above the filter row (e.g., "US", "Watchlist")
      // These live outside the table. We collect visible text from the known tab row.
      var table = container.querySelector('table');
      if (!table) return { open: true, error: 'table_not_found', title: title, columns: [], rows: [], row_count: 0 };

      var ths = table.querySelectorAll('thead th, tr:first-child th');
      var columns = [];
      for (var i = 0; i < ths.length; i++) {
        var txt = (ths[i].textContent || '').trim();
        if (txt) columns.push(txt);
      }

      var trs = table.querySelectorAll('tbody tr');
      var rows = [];
      var max = Math.min(trs.length, ${cap});
      for (var r = 0; r < max; r++) {
        var tds = trs[r].querySelectorAll('td');
        var cells = [];
        for (var j = 0; j < tds.length; j++) {
          var t = (tds[j].textContent || '').trim();
          cells.push(t);
        }
        // Build a { column: value } object mapped to column headers
        var obj = { symbol: cells[0] || null };
        for (var k = 1; k < columns.length && k < cells.length; k++) {
          obj[columns[k]] = cells[k];
        }
        rows.push(obj);
      }

      // Capture visible filter pill labels for discoverability
      var pills = [];
      var pillEls = container.querySelectorAll('[data-name^="screener-filter-pill-"]');
      for (var p = 0; p < pillEls.length; p++) {
        var label = (pillEls[p].textContent || '').trim();
        if (label) pills.push(label);
      }

      return {
        open: true,
        title: title,
        columns: columns,
        row_count: trs.length,
        returned: rows.length,
        rows: rows,
        filters: pills,
      };
    })()
  `);

  if (!data?.open) {
    return { success: false, open: false, error: 'Screener is not open. Call screener_open first.' };
  }
  if (data?.error) {
    return { success: false, open: true, error: data.error };
  }

  return {
    success: true,
    open: true,
    screen: data.title,
    columns: data.columns || [],
    row_count: data.row_count || 0,
    returned: data.returned || 0,
    rows: data.rows || [],
    filters: data.filters || [],
  };
}
