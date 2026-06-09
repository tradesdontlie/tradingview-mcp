import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/watchlist.js';

export function registerWatchlistTools(server) {
  server.tool('watchlist_get', 'Get all symbols from the current TradingView watchlist with last price, change, and change%', {}, async () => {
    try { return jsonResult(await core.get()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_add', 'Add a symbol to the TradingView watchlist', {
    symbol: z.string().describe('Symbol to add (e.g., AAPL, BTCUSD, ES1!, NYMEX:CL1!)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.add({ symbol })); }
    catch (err) {
      // Try to close any open search/input on error
      try {
        const { getClient } = await import('../connection.js');
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      } catch (_) {}
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('watchlist_create',
    'Create a new named watchlist, optionally pre-populated with symbols, in a single call. Uses TradingView\'s internal REST API (not UI automation), so it is language-independent and does not change the currently active list. Returns the new list\'s id, name, and symbols.',
    {
      name: z.string().min(1).describe('Name for the new watchlist (e.g., "AI – GPU demand")'),
      symbols: z.array(z.string()).optional().describe('Optional initial symbols in EXCHANGE:TICKER form, e.g. ["NASDAQ:NVDA", "NYSE:ORCL"]'),
    },
    async ({ name, symbols }) => {
      try { return jsonResult(await core.create({ name, symbols: symbols || [] })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    });

  server.tool('watchlist_list',
    'List all named (custom) watchlists with their ids, names, symbol counts, and which one is active. Reads every list via the internal REST API, unlike watchlist_get which only reads the active list. Use this to look up a watchlist id before deleting, or to check whether a named list already exists.',
    {},
    async () => {
      try { return jsonResult(await core.list()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    });

  server.tool('watchlist_delete',
    'Delete a named watchlist by its numeric id (get the id from watchlist_list). Destructive and scoped strictly by id — never by name.',
    {
      id: z.number().int().positive().describe('Numeric watchlist id from watchlist_list (e.g., 335018981)'),
    },
    async ({ id }) => {
      try { return jsonResult(await core.remove({ id })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    });
}
