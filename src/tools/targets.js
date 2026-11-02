import { z } from 'zod';
import { jsonResult } from './_format.js';
import { listTargets, selectTarget } from '../connection.js';

export function registerTargetTools(server) {
  server.tool('target_list', 'List actual TradingView chart targets across Desktop windows. Returns opaque target IDs and this MCP session\'s selected target. Shells and helper pages are excluded. Listing does not change window focus or chart state.', {}, async () => {
    try { return jsonResult(await listTargets()); }
    catch (error) { return jsonResult({ success: false, error: error.message }, true); }
  });

  server.tool('target_select', 'Bind subsequent calls in this MCP session to one exact target_id from target_list. Other sessions retain their own targets. Does not activate a window or change a chart. A lost target never falls back silently to another chart.', {
    target_id: z.string().min(1).max(256).describe('Exact opaque target ID from target_list; do not pass a numeric tab index or guess an ID.'),
  }, async ({ target_id }) => {
    try { return jsonResult(await selectTarget(target_id)); }
    catch (error) { return jsonResult({ success: false, error: error.message }, true); }
  });
}
