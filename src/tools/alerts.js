import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert via TradingView REST API (uses current chart symbol if not specified)', {
    condition: z.string().describe('Alert condition: "crossing" (default), "greater_than", "less_than", "above", "below". All map to TV cross type.'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message (default: "<symbol> cross <price>")'),
    symbol: z.string().optional().describe('Symbol override (default: current chart symbol, e.g. BINANCE:BTCUSDT)'),
    resolution: z.string().optional().describe('Resolution to monitor (default: current chart resolution; e.g. "1", "5", "60", "D")'),
    expiration: z.string().optional().describe('ISO date string for expiration (default: 60 days from now)'),
  }, async ({ condition, price, message, symbol, resolution, expiration }) => {
    try { return jsonResult(await core.create({ condition, price, message, symbol, resolution, expiration })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete an alert by alert_id, or all alerts with delete_all=true', {
    alert_id: z.union([z.string(), z.number()]).optional().describe('Delete a single alert by id'),
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
  }, async ({ alert_id, delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ alert_id, delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
