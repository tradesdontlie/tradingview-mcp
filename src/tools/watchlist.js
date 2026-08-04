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

  server.tool('watchlist_add_bulk', 'Add multiple symbols to the TradingView watchlist', {
    symbols: z.array(z.string()).describe('Symbols to add (e.g., ["AAPL", "ES1!", "NYMEX:CL1!"])'),
  }, async ({ symbols }) => {
    try { return jsonResult(await core.addBulk({ symbols })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_remove', 'Remove one or more symbols from the active TradingView watchlist', {
    symbols: z.array(z.string()).describe('Symbols to remove — bare (AAPL) or full (NASDAQ:AAPL)'),
  }, async ({ symbols }) => {
    try { return jsonResult(await core.remove({ symbols })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_manage', 'Manage entire watchlists (not just their symbols): list all lists, create a new named list, delete a list, or switch the active list', {
    action: z.enum(['list', 'create', 'delete', 'switch']).describe('list = show all watchlists; create = new named list; delete = remove a list; switch = make a list active'),
    name: z.string().optional().describe('Watchlist name. Required for create; used for delete/switch when id is not given.'),
    id: z.string().optional().describe('Watchlist id (from action:"list"). Preferred over name for delete/switch.'),
    symbols: z.array(z.string()).optional().describe('Initial symbols for create, e.g. ["NASDAQ:AAPL", "ES1!"]'),
  }, async ({ action, name, id, symbols }) => {
    try {
      switch (action) {
        case 'list':
          return jsonResult(await core.listLists());
        case 'create':
          if (!name) throw new Error('name is required for action "create".');
          return jsonResult(await core.createList({ name, symbols: symbols || [] }));
        case 'delete':
          if (!name && !id) throw new Error('Provide id or name for action "delete".');
          return jsonResult(await core.deleteList({ id, name }));
        case 'switch':
          if (!name && !id) throw new Error('Provide id or name for action "switch".');
          return jsonResult(await core.switchList({ id, name }));
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
