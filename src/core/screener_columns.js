/**
 * Core Screener Columns management.
 *
 * Column headers live in `[class*="screenerContainer"] table thead th`.
 * Column setup (add/reorder/hide/reset) happens via the "Column setup" button
 * `[data-qa-id="screener-add-column-button"]` which opens a catalog panel.
 *
 * MVP actions: list.
 * Stretch actions: reset, remove, add, reorder — catalog-navigation flow
 * isn't automated yet; these return `not_implemented_yet`.
 *
 * Per CONTRIBUTING.md: UI automation only.
 */
import {
  resolveDeps,
  notOpenResult,
  notImplemented,
} from './_screener_shared.js';

const LIST_EXPR = `
  (function() {
    var container = document.querySelector('[class*="screenerContainer"]');
    if (!container || container.offsetParent === null) return null;
    var table = container.querySelector('table');
    if (!table) return { error: 'table_not_found' };
    var ths = table.querySelectorAll('thead th, tr:first-child th');
    var cols = [];
    for (var i = 0; i < ths.length; i++) {
      var t = (ths[i].textContent || '').trim();
      // Skip the trailing sticky-scroll spacer column (no text)
      if (!t) continue;
      cols.push(t);
    }
    return { columns: cols };
  })()
`;

export async function list({ _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const result = await evaluate(LIST_EXPR);
  if (result === null) return notOpenResult('list');
  if (result.error) return { success: false, action: 'list', open: true, error: result.error };
  return {
    success: true,
    action: 'list',
    open: true,
    count: result.columns.length,
    columns: result.columns,
  };
}

// ── Stretch actions ──────────────────────────────────────────────────────

export async function reset({ _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const probe = await evaluate(LIST_EXPR);
  if (probe === null) return notOpenResult('reset');
  return notImplemented(
    'reset',
    'Resetting columns requires the Column setup catalog ([data-qa-id="screener-add-column-button"]) → "Reset to default" action. Not yet automated.',
  );
}

export async function remove({ column, _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const probe = await evaluate(LIST_EXPR);
  if (probe === null) return notOpenResult('remove');
  return notImplemented(
    'remove',
    'Removing a column requires the Column setup catalog or a per-header context menu. Not yet automated — hide the column in TradingView UI.',
  );
}

export async function add({ column, _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const probe = await evaluate(LIST_EXPR);
  if (probe === null) return notOpenResult('add');
  return notImplemented(
    'add',
    'Adding a column requires navigating the Column setup catalog. Not yet automated — add the column in TradingView UI.',
  );
}

export async function reorder({ columns, _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const probe = await evaluate(LIST_EXPR);
  if (probe === null) return notOpenResult('reorder');
  return notImplemented(
    'reorder',
    'Reordering columns requires drag-and-drop in the Column setup panel. Not yet automated.',
  );
}
