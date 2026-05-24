import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert via the TradingView internal API (pricealerts.tradingview.com). Defaults to the current chart symbol + resolution unless overridden.', {
    condition: z.string().describe('Alert condition (accepted for compat; underlying API fires on any crossing in either direction)'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message (defaults to "<symbol> crossing <price>")'),
    symbol: z.string().optional().describe('Symbol like "BATS:RDDT" (default: current chart symbol)'),
    resolution: z.string().optional().describe('Resolution string like "1", "5", "60", "D" (default: current chart resolution)'),
    frequency: z.enum(['on_first_fire', 'once_per_bar', 'once_per_bar_close', 'once_per_minute']).optional().describe('Fire frequency (default: on_first_fire)'),
    expiration_days: z.coerce.number().optional().describe('Days until expiration (default: 30, capped at 60 — TradingView\'s hard limit)'),
  }, async (args) => {
    try { return jsonResult(await core.create(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete one alert, a list of alerts, or all alerts via TradingView\'s internal API (POST /delete_alerts).', {
    alert_id: z.coerce.number().optional().describe('Single alert ID to delete (use alert_list to discover IDs)'),
    alert_ids: z.array(z.coerce.number()).optional().describe('Bulk-delete multiple alerts by ID in one request'),
    delete_all: z.coerce.boolean().optional().describe('List then bulk-delete every alert on the account'),
  }, async (args) => {
    try { return jsonResult(await core.deleteAlerts(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
