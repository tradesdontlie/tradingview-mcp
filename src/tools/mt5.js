import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/mt5.js';

export function registerMt5Tools(server) {
  server.tool('mt5_health_check', 'Check connection to the MT5 bridge (scripts/mt5_bridge.py) and the MT5 terminal it wraps', {}, async () => {
    try { return jsonResult(await core.health()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Start the bridge with: python scripts/mt5_bridge.py — see SETUP_GUIDE.md' }, true); }
  });

  server.tool('mt5_get_account', 'Get MT5 account info: balance, equity, margin, leverage, and whether it is a demo or live account', {}, async () => {
    try { return jsonResult(await core.getAccount()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('mt5_get_positions', 'Get open MT5 positions, optionally filtered by symbol', {
    symbol: z.string().optional().describe('Filter to a single symbol, e.g. "EURUSD"'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getPositions({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('mt5_get_quote', 'Get the current bid/ask quote for an MT5 symbol', {
    symbol: z.string().describe('MT5 symbol, e.g. "EURUSD", "XAUUSD"'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getQuote({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('mt5_place_order', 'Place a real market order on MT5 (buy or sell). Executes against whatever account the bridge is logged into — demo or live; check mt5_get_account.is_demo first if unsure. Requires confirm: true.', {
    symbol: z.string().describe('MT5 symbol, e.g. "EURUSD"'),
    side: z.enum(['buy', 'sell']).describe('Order direction'),
    volume: z.coerce.number().positive().describe('Lot size, e.g. 0.01'),
    sl: z.coerce.number().optional().describe('Stop loss price'),
    tp: z.coerce.number().optional().describe('Take profit price'),
    comment: z.string().max(31).optional().describe('Order comment (max 31 chars)'),
    confirm: z.literal(true).describe('Must be true — this places a real order'),
  }, async ({ symbol, side, volume, sl, tp, comment, confirm }) => {
    try { return jsonResult(await core.placeOrder({ symbol, side, volume, sl, tp, comment, confirm })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('mt5_close_order', 'Close an open MT5 position by ticket (fully or partially). Requires confirm: true.', {
    ticket: z.coerce.number().describe('Position ticket id (from mt5_get_positions)'),
    volume: z.coerce.number().positive().optional().describe('Partial close volume; omit to close the full position'),
    confirm: z.literal(true).describe('Must be true — this closes a real position'),
  }, async ({ ticket, volume, confirm }) => {
    try { return jsonResult(await core.closeOrder({ ticket, volume, confirm })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('mt5_modify_order', 'Modify stop loss / take profit on an open MT5 position by ticket', {
    ticket: z.coerce.number().describe('Position ticket id (from mt5_get_positions)'),
    sl: z.coerce.number().optional().describe('New stop loss price'),
    tp: z.coerce.number().optional().describe('New take profit price'),
  }, async ({ ticket, sl, tp }) => {
    try { return jsonResult(await core.modifyOrder({ ticket, sl, tp })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
