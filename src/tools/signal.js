// Signal engine MCP tools.

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as engine from '../core/signals/engine.js';

const METRIC_ENUM = z.enum(['close', 'price', 'rsi', 'ema', 'sma', 'atr']);
const OP_ENUM = z.enum(['<', '>', '<=', '>=', '==', '!=']);

const Operand = z.union([
  z.object({ const: z.number() }).strict(),
  z.object({ metric: METRIC_ENUM, period: z.number().int().min(1).max(500).optional() }).strict(),
]);

const Condition = z.object({
  left: Operand,
  op: OP_ENUM,
  right: Operand,
}).strict();

export function registerSignalTools(server) {
  server.tool(
    'signal_register',
    'Register a JSON DSL rule that evaluates against a streaming subscription buffer (created via subscribe_ticker). Engine polls every 2s; fires when conditions match. Operand: { const: number } OR { metric: close|price|rsi|ema|sma|atr, period?: int }. Op: < > <= >= == !=.',
    {
      rule: z.object({
        name: z.string().min(1),
        sub_id: z.string().min(1),
        conditions: z.array(Condition).min(1),
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
