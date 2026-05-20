import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/webhook.js';

export function registerWebhookTools(server) {
  server.tool(
    'webhook_start',
    'Start the TradingView alert webhook receiver. Requires a shared-secret header on incoming POSTs.',
    {
      port: z.coerce.number().int().optional().describe('TCP port to listen on (default 9223)'),
      host: z.string().optional().describe('Bind address (default 127.0.0.1; use 0.0.0.0 to expose externally)'),
      secret: z.string().min(8).optional().describe('Shared secret (>=8 chars). Falls back to TV_WEBHOOK_SECRET env var.'),
      max_alerts: z.coerce.number().int().positive().optional().describe('Ring buffer size (default 500)'),
      rate_limit_per_min: z.coerce.number().int().nonnegative().optional().describe('Per-IP requests per minute (default 60; 0 disables)'),
    },
    async ({ port, host, secret, max_alerts, rate_limit_per_min }) => {
      try { return jsonResult(await core.start({ port, host, secret, max_alerts, rate_limit_per_min })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('webhook_stop', 'Stop the webhook receiver and release the port', {}, async () => {
    try { return jsonResult(await core.stop()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('webhook_status', 'Get receiver status: running, port, counts, buffer size', {}, async () => {
    try { return jsonResult(core.status()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool(
    'webhook_list_alerts',
    'List buffered webhook alerts in receive order (oldest first)',
    {
      limit: z.coerce.number().int().positive().optional().describe('Return at most N most recent alerts'),
      since: z.string().optional().describe('ISO timestamp; return only alerts received at or after this time'),
    },
    async ({ limit, since }) => {
      try { return jsonResult(core.list({ limit, since })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('webhook_clear_alerts', 'Drop all buffered alerts (counters unchanged)', {}, async () => {
    try { return jsonResult(core.clear()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
