import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert on the active chart symbol via TradingView\'s internal REST API (pricealerts.tradingview.com/create_alert). No UI dialog involved — fires and forgets. Returns alert_id on success.', {
    condition: z.string().describe('Alert condition: "crossing" (default, any direction), "greater_than"/"above"/"cross_up", or "less_than"/"below"/"cross_down"'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message (auto-generated from symbol + condition + price if omitted)'),
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message })); }
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
