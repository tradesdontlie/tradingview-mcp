import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/watchlist.js';
import { withTarget, getClient } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. Runs this command against that TradingView window/tab.');

export function registerWatchlistTools(server) {
  server.tool('watchlist_get', 'Get all symbols from the current TradingView watchlist with last price, change, and change%', {
    target_id: targetIdParam,
  }, async ({ target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.get())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_add', 'Add a symbol to the TradingView watchlist', {
    symbol: z.string().describe('Symbol to add (e.g., AAPL, BTCUSD, ES1!, NYMEX:CL1!)'),
    target_id: targetIdParam,
  }, async ({ symbol, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.add({ symbol }))); }
    catch (err) {
      // Try to close any open search/input on error
      try {
        const c = await withTarget(target_id, () => getClient());
        await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      } catch (_) {}
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
