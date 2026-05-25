// Signal engine MCP tools.

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as engine from '../core/signals/engine.js';

export function registerSignalTools(server) {
  server.tool(
    'signal_register',
    'Register a JSON DSL rule that evaluates against a streaming subscription buffer (created via subscribe_ticker). Engine polls every 2s; fires when conditions match. See PLAN.md for DSL examples.',
    {
      rule: z.object({
        name: z.string(),
        sub_id: z.string(),
        conditions: z.array(z.object({
          left: z.record(z.any()),
          op: z.string(),
          right: z.record(z.any()),
        })).min(1),
        require: z.enum(['all', 'any']).optional(),
        cooldown_ms: z.number().int().min(0).optional(),
      }),
    },
    async ({ rule }) => jsonResult(engine.registerRule(rule))
  );

  server.tool(
    'signal_remove',
    'Remove a registered signal rule by name.',
    { name: z.string() },
    async ({ name }) => jsonResult(engine.removeRule(name))
  );

  server.tool(
    'signal_list',
    'List all registered signal rules.',
    {},
    async () => jsonResult({ rules: engine.listRules() })
  );

  server.tool(
    'signal_active',
    'List signals that have fired but not been acknowledged. Most recent first.',
    { limit: z.number().int().min(1).max(200).default(50) },
    async ({ limit }) => jsonResult(engine.active({ limit }))
  );

  server.tool(
    'signal_ack',
    'Acknowledge (remove) a signal by index in the active list (0 = most recent).',
    { index: z.number().int().min(0) },
    async ({ index }) => jsonResult(engine.ack(index))
  );
}
