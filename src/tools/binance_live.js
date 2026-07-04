import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/binance_live.js';

/**
 * LIVE Binance (mainnet) tools — these trade with REAL funds.
 * Kept as a separate registration from tools/binance.js (testnet) so the
 * sandbox and real-money tool sets are never confused with one another.
 *
 * binance_live_place_order defaults to dry_run: true and additionally
 * requires confirm: true before it will send a real order — two explicit
 * opt-ins are needed before any real money moves.
 */
export function registerBinanceLiveTools(server) {
  server.tool('binance_live_get_balance', 'Get account balances from LIVE Binance (real funds, requires BINANCE_API_KEY/SECRET env vars)', {}, async () => {
    try { return jsonResult(await core.accountInfo()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('binance_live_get_klines', 'Get OHLCV candles for a symbol from LIVE Binance', {
    symbol: z.string().describe('Trading pair symbol (e.g., "BTCUSDT")'),
    interval: z.string().optional().describe('Candle interval: 1m, 5m, 15m, 1h, 4h, 1d, etc. (default "1m")'),
    limit: z.coerce.number().optional().describe('Number of candles to return (default 100, max 1000)'),
  }, async ({ symbol, interval, limit }) => {
    try { return jsonResult(await core.getKlines({ symbol, interval, limit })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool(
    'binance_live_place_order',
    'Place an order on LIVE Binance with REAL FUNDS (requires BINANCE_API_KEY/SECRET env vars). ' +
    'SAFETY: defaults to dry_run: true (preview only). To actually place a real order you must ' +
    'EXPLICITLY pass BOTH dry_run: false AND confirm: true — this double opt-in exists so a real ' +
    'trade can never fire from an ambiguous instruction. Always show the user the dry-run preview ' +
    'and get their explicit go-ahead before setting dry_run: false.',
    {
      symbol: z.string().describe('Trading pair symbol (e.g., "BTCUSDT")'),
      side: z.enum(['buy', 'sell', 'BUY', 'SELL']).describe('Order side'),
      type: z.enum(['market', 'limit', 'MARKET', 'LIMIT']).optional().describe('Order type (default "market")'),
      quantity: z.coerce.number().positive().describe('Order quantity in base asset units'),
      price: z.coerce.number().positive().optional().describe('Limit price (required when type is "limit")'),
      dry_run: z.coerce.boolean().optional().describe('Preview only, do not send (default true — must be explicitly set to false to trade)'),
      confirm: z.coerce.boolean().optional().describe('Must be explicitly true alongside dry_run: false to confirm intent to risk real funds'),
    },
    async ({ symbol, side, type, quantity, price, dry_run, confirm }) => {
      try { return jsonResult(await core.placeOrder({ symbol, side, type, quantity, price, dry_run, confirm })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('binance_live_cancel_order', 'Cancel an open order on LIVE Binance', {
    symbol: z.string().describe('Trading pair symbol (e.g., "BTCUSDT")'),
    order_id: z.coerce.number().describe('Order ID to cancel (from binance_live_get_open_orders)'),
  }, async ({ symbol, order_id }) => {
    try { return jsonResult(await core.cancelOrder({ symbol, order_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('binance_live_get_open_orders', 'List open orders on LIVE Binance, optionally filtered by symbol', {
    symbol: z.string().optional().describe('Trading pair symbol to filter by (e.g., "BTCUSDT"); omit for all symbols'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getOpenOrders({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
