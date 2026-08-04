import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server, { evaluate, evaluateAsync } = {}) {
  const _deps = { evaluate, evaluateAsync };
  server.tool('alert_create', 'Create a price alert on the current chart symbol via TradingView\'s alert API', {
    condition: z.string().describe('Alert condition: "crossing", "greater_than", or "less_than"'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message, _deps })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list({ _deps })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', `Delete a specific alert by id, or ALL active alerts. Deleting all is irreversible and requires confirm: "${core.DELETE_ALL_CONFIRMATION}" — a bare delete_all is refused.`, {
    alert_id: z.coerce.number().optional().describe('Alert id to delete (from alert_list)'),
    delete_all: z.coerce.boolean().optional().describe('Delete all active alerts (requires the confirm token)'),
    confirm: z.string().optional().describe(`Must equal "${core.DELETE_ALL_CONFIRMATION}" when delete_all is set`),
  }, async ({ alert_id, delete_all, confirm }) => {
    try { return jsonResult(await core.deleteAlerts({ alert_id, delete_all, confirm, _deps })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
