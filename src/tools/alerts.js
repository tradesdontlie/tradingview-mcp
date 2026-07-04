import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';
import { DEFAULT_EXPIRATION_DAYS, MAX_EXPIRATION_DAYS } from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert on the active chart symbol via TradingView\'s internal REST API (pricealerts.tradingview.com/create_alert). No UI dialog involved — fires and forgets. Returns alert_id on success.', {
    condition: z.string().describe('Alert condition: "crossing" (default, any direction), "greater_than"/"above"/"cross_up", or "less_than"/"below"/"cross_down"'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message (auto-generated from symbol + condition + price if omitted)'),
    expiration_days: z.coerce.number().int().min(1).max(MAX_EXPIRATION_DAYS).optional().describe(`Days until the alert auto-expires (default ${DEFAULT_EXPIRATION_DAYS}, capped at ${MAX_EXPIRATION_DAYS}). Use a higher value for weekly/monthly setups; the default matches TV's UI default.`),
  }, async ({ condition, price, message, expiration_days }) => {
    try { return jsonResult(await core.create({ condition, price, message, expiration_days })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete one or more alerts via TradingView\'s internal REST API (pricealerts.tradingview.com/delete_alerts). Pass alert_id for a single alert, alert_ids for bulk, or delete_all:true to clear everything.', {
    alert_id: z.coerce.number().optional().describe('Single alert ID to delete (get from alert_list)'),
    alert_ids: z.array(z.coerce.number()).optional().describe('Array of alert IDs to delete in one request (TV supports bulk natively)'),
    delete_all: z.coerce.boolean().optional().describe('Delete every alert on the account. Irreversible.'),
  }, async ({ alert_id, alert_ids, delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ alert_id, alert_ids, delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
