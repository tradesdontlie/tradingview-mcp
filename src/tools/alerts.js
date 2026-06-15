import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', "Create a price alert on the ACTIVE chart symbol via TradingView's REST API (headless; verifies the alert was actually created). Set the chart symbol first with chart_set_symbol.", {
    condition: z.string().describe('Alert condition: "crossing", "greater_than" (above), or "less_than" (below). Also accepts crossing_up/crossing_down.'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message (defaults to "SYMBOL <condition> PRICE")'),
    expiration_days: z.coerce.number().optional().describe('Days until expiry (default 60; TradingView caps ~88 and disallows never-expire on most plans)'),
  }, async ({ condition, price, message, expiration_days }) => {
    try { return jsonResult(await core.create({ condition, price, message, expiration_days })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete alerts via TradingView REST API. Pass alert_id (single id or array, from alert_list) to delete specific alerts, or delete_all:true to remove every alert.', {
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
    alert_id: z.union([z.coerce.number(), z.array(z.coerce.number())]).optional().describe('Specific alert id(s) to delete (from alert_list)'),
  }, async ({ delete_all, alert_id }) => {
    try { return jsonResult(await core.deleteAlerts({ delete_all, alert_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
