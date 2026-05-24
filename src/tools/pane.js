import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pane.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. Runs this command against that TradingView window/tab.');

export function registerPaneTools(server) {
  server.tool('pane_list', 'List all chart panes in the current layout with their symbols and active state', {
    target_id: targetIdParam,
  }, async ({ target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.list())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pane_set_layout', 'Change the chart grid layout (e.g., single, 2x2, 2h, 3v)', {
    layout: z.string().describe('Layout code: s (single), 2h, 2v, 2-1, 1-2, 3h, 3v, 4 (2x2), 6, 8. Also accepts: single, 2x1, 1x2, 2x2, quad'),
    target_id: targetIdParam,
  }, async ({ layout, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.setLayout({ layout }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pane_focus', 'Focus a specific chart pane by index (0-based)', {
    index: z.coerce.number().describe('Pane index (0-based, from pane_list)'),
    target_id: targetIdParam,
  }, async ({ index, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.focus({ index }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pane_set_symbol', 'Set the symbol on a specific pane by index', {
    index: z.coerce.number().describe('Pane index (0-based)'),
    symbol: z.string().describe('Symbol to set (e.g., NQ1!, ES1!, AAPL)'),
    target_id: targetIdParam,
  }, async ({ index, symbol, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.setSymbol({ index, symbol }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
