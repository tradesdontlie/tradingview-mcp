import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/watchlist.js';

export function registerWatchlistTools(server) {
  // ── Existing read/add tools (unchanged) ──────────────────────────────────
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

  // ── REST-based management tools (fork patch 2026-04-21) ──────────────────

  server.tool(
    'watchlist_list',
    'List all TradingView watchlists (custom + colored). Returns id, name, type, color, symbol_count, active flag. Pass include_symbols:true to also return the full symbols array for each list.',
    {
      include_symbols: z.coerce.boolean().optional().describe('If true, include the full symbols[] array per list (default false — just counts).'),
    },
    async ({ include_symbols }) => {
      try { return jsonResult(await core.list({ include_symbols: !!include_symbols })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'watchlist_switch',
    'Switch the active watchlist by name (or color for unnamed colored lists). Resolves name via /all/ then POSTs /active/{id_or_color}/. Case-insensitive.',
    {
      name: z.string().describe('Watchlist name (e.g., "FOCUS", "02 MASTER") or color ("red"/"blue"/...) for unnamed colored lists.'),
    },
    async ({ name }) => {
      try { return jsonResult(await core.switchList({ name })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'watchlist_remove',
    'Remove one or more symbols from a watchlist. Defaults to the active list; pass `from` to target a specific list by name. Works with both custom and colored lists.',
    {
      symbol: z.string().optional().describe('Single symbol to remove (e.g., "NASDAQ:AAPL" or "AAPL").'),
      symbols: z.array(z.string()).optional().describe('Array of symbols to remove in one call. Takes precedence over `symbol`.'),
      from: z.string().optional().describe('Target watchlist name (optional — defaults to the currently-active watchlist).'),
    },
    async ({ symbol, symbols, from }) => {
      try { return jsonResult(await core.removeSymbol({ symbol, symbols, from })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'watchlist_insert',
    'Add one or more symbols to a watchlist via TV REST. Race-free alternative to the DOM-based `watchlist_add` — targets the list by numeric id instead of typing into the sidebar search box, so adds always land on the requested list regardless of which tab the user has open in the UI. Defaults to the active list; pass `to` to target a specific list by name. Works with both custom and colored lists.',
    {
      symbol: z.string().optional().describe('Single symbol to add (e.g., "NASDAQ:AAPL" or "AAPL").'),
      symbols: z.array(z.string()).optional().describe('Array of symbols to add in one call. Takes precedence over `symbol`.'),
      to: z.string().optional().describe('Target watchlist name (optional — defaults to the currently-active watchlist).'),
    },
    async ({ symbol, symbols, to }) => {
      try { return jsonResult(await core.appendSymbols({ symbol, symbols, to })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'watchlist_create',
    'Create a new custom watchlist with an optional starting set of symbols. Returns the new list id and name.',
    {
      name: z.string().describe('Name for the new watchlist.'),
      symbols: z.array(z.string()).optional().describe('Optional initial symbols (e.g., ["NASDAQ:AAPL", "NYSE:GME"]).'),
    },
    async ({ name, symbols }) => {
      try { return jsonResult(await core.create({ name, symbols })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'watchlist_rename',
    'Rename a custom watchlist. Built-in colored lists are not renameable via REST (use TV UI).',
    {
      current_name: z.string().describe('Current name of the list.'),
      new_name: z.string().describe('New name to assign.'),
    },
    async ({ current_name, new_name }) => {
      try { return jsonResult(await core.rename({ current_name, new_name })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'watchlist_delete',
    'Delete a custom watchlist by name. DESTRUCTIVE — requires confirm_name to match the target list name exactly (case-sensitive). Refuses colored (built-in) lists and refuses the currently-active list unless confirm_active:true is passed. Returns the symbol_count of what was deleted.',
    {
      name: z.string().describe('Name of the watchlist to delete.'),
      confirm_name: z.string().describe('Must equal `name` exactly (case-sensitive). Forces you to type the list name twice as a write-protect against mis-targeting.'),
      confirm_active: z.coerce.boolean().optional().describe('Set true to allow deleting the currently-active list (TV normally requires switching away first).'),
    },
    async ({ name, confirm_name, confirm_active }) => {
      try { return jsonResult(await core.deleteList({ name, confirm_name, confirm_active: !!confirm_active })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
