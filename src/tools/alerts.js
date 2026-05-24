import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. Runs this command against that TradingView window/tab.');

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert via the TradingView alert dialog', {
    condition: z.string().describe('Alert condition (e.g., "crossing", "greater_than", "less_than")'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
    target_id: targetIdParam,
  }, async ({ condition, price, message, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.create({ condition, price, message }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {
    target_id: targetIdParam,
  }, async ({ target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.list())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete all alerts or open context menu for deletion', {
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
    target_id: targetIdParam,
  }, async ({ delete_all, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.deleteAlerts({ delete_all }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
