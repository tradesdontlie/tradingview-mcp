import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/trading.js';

export function registerTradingTools(server) {
  server.tool('trading_get_account', 'Get trading account summary (balance, equity, profit, margin, net liquidation) from the broker panel', {}, async () => {
    try { return jsonResult(await core.getAccount()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Ensure the trading panel is open and a broker is connected.' }, true); }
  });

  server.tool('trading_get_positions', 'Get open positions from the broker trading panel (symbol, side, qty, avg price, P&L)', {}, async () => {
    try { return jsonResult(await core.getPositions()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Ensure the trading panel is open and a broker is connected.' }, true); }
  });

  server.tool('trading_get_orders', 'Get open/pending orders from the broker trading panel (symbol, side, type, qty, limit/stop price, status)', {}, async () => {
    try { return jsonResult(await core.getOrders()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Ensure the trading panel is open and a broker is connected.' }, true); }
  });

  server.tool('trading_get_notifications', 'Get notification log entries from the broker trading panel (fills, errors, status messages)', {
    limit: z.coerce.number().optional().describe('Max notifications to return (default 50)'),
  }, async ({ limit }) => {
    try { return jsonResult(await core.getNotifications({ limit })); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Ensure the trading panel is open and a broker is connected.' }, true); }
  });

  server.tool('trading_get_risk_reward', 'Get all Risk/Reward drawing tools from the chart with entry, stop, target prices and R:R ratio. Auto-matches to open positions and pending orders.', {
    match: z.coerce.boolean().optional().describe('Match R:R tools against positions/orders (default true)'),
  }, async ({ match }) => {
    try { return jsonResult(await core.getRiskReward({ match })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
