// WS streaming MCP tools. Subscribe-and-poll pattern. Today: Hyperliquid only.

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as mgr from '../core/streaming/manager.js';

const SOURCES = z.enum(['hyperliquid', 'delta_india']);

export function registerStreamTools(server) {
  server.tool(
    'subscribe_ticker',
    'Start a background WS subscription. Supports hyperliquid (trades stream, public) and delta_india (v2/ticker, public). Returns sub_id for polling. Signal engine evaluates rules against any subscription. Indian crypto F&O perps come via delta_india.',
    {
      source: SOURCES.default('hyperliquid'),
      coin: z.string().describe('e.g. BTC, ETH, SOL'),
    },
    async (args) => {
      try { return jsonResult(mgr.subscribe(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'unsubscribe',
    'Stop and remove a subscription.',
    { sub_id: z.string() },
    async ({ sub_id }) => jsonResult(mgr.unsubscribe(sub_id))
  );

  server.tool(
    'list_subscriptions',
    'List all active subscriptions with source, coin, alive flag, buffer size.',
    {},
    async () => jsonResult({ subscriptions: mgr.list() })
  );

  server.tool(
    'get_latest_tick',
    'Get the most recent tick from a subscription buffer.',
    { sub_id: z.string() },
    async ({ sub_id }) => jsonResult(mgr.latest(sub_id))
  );

  server.tool(
    'get_recent_ticks',
    'Get the last N ticks from a subscription buffer.',
    {
      sub_id: z.string(),
      n: z.number().int().min(1).max(500).default(20),
    },
    async ({ sub_id, n }) => jsonResult(mgr.recent(sub_id, n))
  );
}
