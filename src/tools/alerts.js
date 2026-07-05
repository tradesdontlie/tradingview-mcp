import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'DEPRECATED — drives the alert dialog via DOM and often fails to commit the price. Use alert_create_webhook instead.', {
    condition: z.string().describe('Alert condition (e.g., "crossing", "greater_than", "less_than")'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_create_webhook', 'Create a price-crossing alert (once-only, open-ended) with an optional webhook URL in ONE call via TradingView\'s alert REST API — no dialog, returns the post-write alert with its committed trigger value. Set message_from_clipboard: true to use the system clipboard as the message so secret-bearing payloads never appear in tool parameters.', {
    symbol: z.string().describe('Exchange-prefixed symbol, e.g. "NASDAQ:LUNR" or "BATS:F" (US equities, USD)'),
    price: z.coerce.number().describe('Trigger price (crossing)'),
    message: z.string().optional().describe('Alert message body. Omit and set message_from_clipboard for secret payloads.'),
    message_from_clipboard: z.coerce.boolean().optional().describe('Read the alert message from the system clipboard in page context (keeps webhook secrets out of tool params)'),
    webhook_url: z.string().optional().describe('Webhook URL to POST the message to when the alert fires'),
    once_only: z.coerce.boolean().optional().describe('Trigger only once then deactivate (default true)'),
    popup: z.coerce.boolean().optional().describe('Show TradingView popup on fire (default true)'),
  }, async (args) => {
    try { return jsonResult(await core.createWebhook(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_modify_price', 'Change the trigger price of an existing price alert. Implemented as recreate-then-delete via the REST API (the returned alert has a NEW alert_id); message, webhook, and settings are preserved. On recreate failure the original alert is left untouched.', {
    alert_id: z.coerce.number().describe('alert_id of the price alert to change (from alert_list)'),
    price: z.coerce.number().describe('New trigger price'),
  }, async ({ alert_id, price }) => {
    try { return jsonResult(await core.modifyPrice({ alert_id, price })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete_one', 'Delete a SINGLE alert by alert_id via the REST API, then verify it is gone. Safe alternative to alert_delete/delete_all.', {
    alert_id: z.coerce.number().describe('alert_id to delete (from alert_list)'),
  }, async ({ alert_id }) => {
    try { return jsonResult(await core.deleteOne({ alert_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'DANGER: deletes ALL alerts (or opens the context menu). Prefer alert_delete_one for a single alert.', {
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
  }, async ({ delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
