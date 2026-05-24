import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/tab.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. Runs this command against that TradingView window/tab.');

export function registerTabTools(server) {
  server.tool('tab_list', 'List all open TradingView chart tabs', {
    target_id: targetIdParam,
  }, async ({ target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.list())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_new', 'Open a new chart tab. By default lands on TradingView\'s "new-tab" page (is_chart=false). Pass symbol or as_chart=true to navigate the new tab to /chart/ so it becomes a viable chart target. Returns target_id of the new tab.', {
    symbol: z.string().optional().describe('Optional symbol to load (e.g., "NSE:NIFTY", "AAPL"). When set, the new tab is navigated to a chart for this symbol and waits until is_chart becomes true.'),
    as_chart: z.coerce.boolean().optional().describe('If true (and no symbol given), navigate the new tab to /chart/ with TradingView\'s default symbol so it becomes a chart target.'),
    target_id: targetIdParam,
  }, async ({ symbol, as_chart, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.newTab({ symbol, as_chart }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_close', 'Close the current chart tab', {
    target_id: targetIdParam,
  }, async ({ target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.closeTab())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_switch', 'Switch to a chart tab by index', {
    index: z.coerce.number().describe('Tab index (0-based, from tab_list)'),
    target_id: targetIdParam,
  }, async ({ index, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.switchTab({ index }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
