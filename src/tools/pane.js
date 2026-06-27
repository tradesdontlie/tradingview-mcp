import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pane.js';

export function registerPaneTools(server) {
  server.tool('pane_list', 'List all chart panes in the current layout with their symbols and active state', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pane_set_layout', 'Change the chart grid layout (e.g., single, 2x2, 2h, 3v)', {
    // Enumerates the canonical layout codes (LAYOUT_NAMES in core/pane.js) plus the
    // friendly aliases core.setLayout resolves (single, 2x1, 1x2, 2x2, grid, quad,
    // 1x1, 3x1, 1x3). Core lowercases + strips whitespace, so case is not enforced
    // here — but typos like "2x3" are now rejected at the boundary.
    layout: z.enum([
      's', '2h', '2v', '2-1', '1-2', '3h', '3v', '3s', '4', '4h', '4v', '4s', '6', '8', '10', '12', '14', '16',
      'single', '1', '1x1', '2x1', '1x2', '2x2', 'grid', 'quad', '3x1', '1x3',
    ]).describe('Layout code: s (single), 2h, 2v, 2-1, 1-2, 3h, 3v, 4 (2x2), 6, 8. Also accepts: single, 2x1, 1x2, 2x2, quad'),
  }, async ({ layout }) => {
    try { return jsonResult(await core.setLayout({ layout })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pane_focus', 'Focus a specific chart pane by index (0-based)', {
    index: z.coerce.number().int().nonnegative().describe('Pane index (0-based, from pane_list)'),
  }, async ({ index }) => {
    try { return jsonResult(await core.focus({ index })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pane_set_symbol', 'Set the symbol on a specific pane by index', {
    index: z.coerce.number().int().nonnegative().describe('Pane index (0-based)'),
    symbol: z.string().describe('Symbol to set (e.g., NQ1!, ES1!, AAPL)'),
  }, async ({ index, symbol }) => {
    try { return jsonResult(await core.setSymbol({ index, symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
