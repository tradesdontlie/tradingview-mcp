import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert via the TradingView pricealerts REST API', {
    condition: z.string().optional().describe('Alert condition: "crossing" (default), "crossing_up", "crossing_down", "greater_than", "less_than"'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message (defaults to "SYMBOL condition PRICE")'),
    symbol: z.string().optional().describe('Symbol to alert on (e.g. "BITSTAMP:BTCUSD"); defaults to the active chart symbol'),
    resolution: z.string().optional().describe('Resolution the condition is evaluated on (e.g. "1", "60", "D"); defaults to "1"'),
  }, async ({ condition, price, message, symbol, resolution }) => {
    try { return jsonResult(await core.create({ condition, price, message, symbol, resolution })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete alerts via the REST API. Provide one of: delete_all, alert_id, alert_ids, or price.', {
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
    alert_id: z.coerce.number().optional().describe('Delete a single alert by its alert_id (from alert_list)'),
    alert_ids: z.array(z.coerce.number()).optional().describe('Delete multiple alerts by alert_id'),
    price: z.coerce.number().optional().describe('Delete every alert whose price level equals this value'),
  }, async ({ delete_all, alert_id, alert_ids, price }) => {
    try { return jsonResult(await core.deleteAlerts({ delete_all, alert_id, alert_ids, price })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
