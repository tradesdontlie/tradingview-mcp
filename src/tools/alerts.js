import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert via the TradingView internal API (pricealerts.tradingview.com). Uses the current chart symbol + resolution unless overridden.', {
    condition: z.string().describe('Alert condition (accepted for compat; underlying API fires on any crossing in either direction)'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message (defaults to "<symbol> crossing <price>")'),
    symbol: z.string().optional().describe('Symbol like "BATS:RDDT" (default: current chart symbol)'),
    resolution: z.string().optional().describe('Resolution string like "1", "5", "60", "D" (default: current chart resolution)'),
    frequency: z.enum(['on_first_fire', 'once_per_bar', 'once_per_bar_close', 'once_per_minute']).optional().describe('Fire frequency (default: on_first_fire)'),
    expiration_days: z.coerce.number().optional().describe('Days until expiration (default: 30)'),
  }, async (args) => {
    try { return jsonResult(await core.create(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete all alerts or open context menu for deletion', {
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
  }, async ({ delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
