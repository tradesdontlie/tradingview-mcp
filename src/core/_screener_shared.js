/**
 * Shared helpers used by screener_screens, screener_filters, screener_columns.
 * Only internal to the screener submodules — not exported from src/core/index.js.
 *
 * Per CONTRIBUTING.md: UI automation only (no direct REST/server access).
 */
import { evaluate as _evaluate, getClient as _getClient } from '../connection.js';

export function resolveDeps(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getClient: deps?.getClient || _getClient,
  };
}

// Probe expression — detects "open + data_loaded" like the main screener module.
// Kept in a separate expr because the main module's IS_OPEN_EXPR also returns
// width/height which these submodules don't need.
const IS_OPEN_EXPR = `
  (function() {
    var container = document.querySelector('[class*="screenerContainer"]');
    if (!container) return false;
    var dialog = container.closest('[class*="js-dialog"]');
    var visible = dialog && /visible-/.test(dialog.className) && container.offsetParent !== null;
    return !!visible;
  })()
`;

/**
 * Throws a structured error if the screener dialog isn't currently open.
 * Returns true when open.
 */
export async function assertScreenerOpen(evaluate) {
  const open = await evaluate(IS_OPEN_EXPR);
  if (!open) {
    const err = new Error('Screener is not open. Call screener_open first.');
    err.code = 'not_open';
    throw err;
  }
  return true;
}

/**
 * Returns a result object for "screener is not open" without throwing —
 * used for `list` actions that shouldn't hard-fail when closed.
 */
export function notOpenResult(action) {
  return {
    success: false,
    action,
    open: false,
    error: 'Screener is not open. Call screener_open first.',
  };
}

/**
 * Standard "stretch" / not-yet-implemented response.
 * Returned by actions that are declared in the schema but whose DOM flow
 * hasn't been wired yet.
 */
export function notImplemented(action, hint) {
  return {
    success: false,
    action,
    error: 'not_implemented_yet',
    hint: hint || 'Use the TradingView UI directly for now.',
  };
}

/**
 * Small sleep utility — consistent with rest of codebase pattern.
 */
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
