import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool(
    'alert_create',
    'Create a price alert via the TradingView alert dialog. Supports webhook URL, alert condition, message body, and expiration.',
    {
      condition: z
        .string()
        .describe('Alert condition. Accepts: "crossing", "crossing_up", "crossing_down", "greater_than", "less_than", "entering_channel", "exiting_channel", or the exact TV label (e.g. "Crossing").'),
      price: z.coerce.number().describe('Trigger price level for the alert.'),
      message: z
        .string()
        .optional()
        .describe('Alert message body. If sending to a webhook, this is the POST body — usually a JSON string with {{ticker}} / {{close}} / {{time}} placeholders.'),
      webhook_url: z
        .string()
        .optional()
        .describe('Webhook URL to POST the alert to. Enables the "Webhook URL" notification toggle in the dialog when provided.'),
      expiration_minutes: z
        .coerce.number()
        .optional()
        .describe('Alert expiration in minutes from now. Omit to keep TV default (~1 month).'),
    },
    async ({ condition, price, message, webhook_url, expiration_minutes }) => {
      try {
        return jsonResult(await core.create({ condition, price, message, webhook_url, expiration_minutes }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool(
    'alert_delete',
    'Delete alerts. Pass alert_id to remove one alert, name to remove all alerts whose message contains the substring, or delete_all to open the bulk-delete context menu.',
    {
      delete_all: z
        .coerce.boolean()
        .optional()
        .describe('Open the alerts-panel context menu for bulk delete (still requires a manual confirmation click).'),
      name: z
        .string()
        .optional()
        .describe('Case-insensitive substring match against alert.message. Deletes every alert whose message contains this string via the pricealerts REST API.'),
      alert_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Exact alert_id (from alert_list) of the single alert to delete.'),
    },
    async ({ delete_all, name, alert_id }) => {
      try {
        return jsonResult(await core.deleteAlerts({ delete_all, name, alert_id: alert_id != null ? String(alert_id) : undefined }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
