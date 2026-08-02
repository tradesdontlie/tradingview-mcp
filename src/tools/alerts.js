import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

const alertDefinitionShape = {
  symbol: z.string().describe('Exchange-qualified symbol, for example NASDAQ:NVDA'),
  timeframe: z.string().describe('Exact TradingView resolution, for example 1, 5, 60, or 1D'),
  kind: z.enum(['price', 'indicator']).describe('Price level or named Pine alertcondition'),
  condition: z.string().describe('crossing/greater_than/less_than for price, or exact Pine condition name'),
  price: z.number().positive().optional().describe('Required only for price alerts'),
  indicator: z.string().optional().describe('Exact live indicator title, required only for indicator alerts'),
  frequency: z.enum(['once', 'once_per_bar', 'once_per_bar_close']),
  expiration: z.string().describe('ISO-8601 timestamp with Z or an explicit offset'),
  message: z.string().describe('Exact deterministic alert message'),
};

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create one exact symbol/timeframe-specific price or live Pine-indicator alert. Indicator metadata is resolved from an already-open exact pane without changing chart state. Use dry_run first.', {
    ...alertDefinitionShape,
    dry_run: z.boolean().optional().describe('Validate and resolve the alert without creating it'),
  }, async (args) => {
    try {
      const result = await core.create(args);
      return jsonResult(result, !result.success);
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List TradingView alerts as normalized symbol/timeframe/kind/condition/frequency/expiration/message definitions', {}, async () => {
    try {
      const result = await core.list();
      return jsonResult(result, !result.success);
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete a specific alert by id, or all active alerts', {
    alert_id: z.coerce.number().optional().describe('Alert id to delete (from alert_list)'),
    delete_all: z.coerce.boolean().optional().describe('Delete all active alerts'),
  }, async ({ alert_id, delete_all }) => {
    try {
      const result = await core.deleteAlerts({ alert_id, delete_all });
      return jsonResult(result, !result.success);
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alerts_sync', 'Idempotently diff and synchronize a complete approved alert plan. Preserves unrelated alerts and replaces only explicitly approved conflicting IDs. Use dry_run before apply.', {
    alerts: z.array(z.object(alertDefinitionShape)).describe('Complete approved alert definitions'),
    replace_alert_ids: z.array(z.coerce.number().int().positive()).optional().describe('Exact conflicting alert IDs approved for replacement'),
    dry_run: z.boolean().optional().describe('Return the complete diff with zero mutations'),
  }, async (args) => {
    try {
      const result = await core.syncAlerts(args);
      return jsonResult(result, !result.success);
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
