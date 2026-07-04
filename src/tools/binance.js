import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/binance.js';

export function registerBinanceTools(server) {
  server.tool('binance_get_balance', 'Get account balances from the Binance Spot Testnet (sandbox — fake funds, requires BINANCE_TESTNET_KEY/SECRET env vars)', {}, async () => {
    try { return jsonResult(await core.accountInfo()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('binance_get_klines', 'Get OHLCV candles for a symbol from the Binance Spot Testnet', {
    symbol: z.string().describe('Trading pair symbol (e.g., "BTCUSDT")'),
    interval: z.string().optional().describe('Candle interval: 1m, 5m, 15m, 1h, 4h, 1d, etc. (default "1m")'),
    limit: z.coerce.number().optional().describe('Number of candles to return (default 100, max 1000)'),
  }, async ({ symbol, interval, limit }) => {
    try { return jsonResult(await core.getKlines({ symbol, interval, limit })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('binance_place_order', 'Place an order on the Binance Spot Testnet (sandbox — fake funds, requires BINANCE_TESTNET_KEY/SECRET env vars). Use dry_run to preview without sending.', {
    symbol: z.string().describe('Trading pair symbol (e.g., "BTCUSDT")'),
    side: z.enum(['buy', 'sell', 'BUY', 'SELL']).describe('Order side'),
    type: z.enum(['market', 'limit', 'MARKET', 'LIMIT']).optional().describe('Order type (default "market")'),
    quantity: z.coerce.number().positive().describe('Order quantity in base asset units'),
    price: z.coerce.number().positive().optional().describe('Limit price (required when type is "limit")'),
    dry_run: z.coerce.boolean().optional().describe('Preview the order without sending it to the exchange'),
  }, async ({ symbol, side, type, quantity, price, dry_run }) => {
    try { return jsonResult(await core.placeOrder({ symbol, side, type, quantity, price, dry_run })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('binance_cancel_order', 'Cancel an open order on the Binance Spot Testnet', {
    symbol: z.string().describe('Trading pair symbol (e.g., "BTCUSDT")'),
    order_id: z.coerce.number().describe('Order ID to cancel (from binance_get_open_orders)'),
  }, async ({ symbol, order_id }) => {
    try { return jsonResult(await core.cancelOrder({ symbol, order_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('binance_get_open_orders', 'List open orders on the Binance Spot Testnet, optionally filtered by symbol', {
    symbol: z.string().optional().describe('Trading pair symbol to filter by (e.g., "BTCUSDT"); omit for all symbols'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getOpenOrders({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
