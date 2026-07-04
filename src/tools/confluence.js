import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/confluence.js';

const planSchema = z.object({ side: z.enum(['long', 'short']) }).passthrough();
const signalSchema = z.object({
  strategy: z.string().min(1).describe('Name of the strategy that produced this signal, e.g. "sfp" or "divergence"'),
  plan: planSchema.describe('The trade plan from that strategy\'s build-plan tool (must include side: "long"|"short")'),
  confirmed_at: z.coerce.number().optional().describe('Timestamp (e.g. confirming candle\'s open_time) — used to break ties in favor of the freshest signal when multiple agree'),
}).passthrough();

/**
 * Multi-strategy confluence tools — combines independently-detected setup
 * signals (e.g. from sfp_scan + divergence_scan) into a single execution
 * decision. Encodes the curriculum's repeated guidance that techniques
 * COMPLEMENT each other for more accurate setups: requires 2+ independently-
 * coded strategies to agree on direction before treating a setup as
 * execution-worthy, and stands down (rather than guessing) on disagreement.
 */
export function registerConfluenceTools(server) {
  server.tool(
    'confluence_assess',
    'Assess whether independently-detected candidate signals (one per strategy, e.g. an SFP hit + an RSI divergence ' +
    'hit on the same symbol/scan) agree on direction. Returns confluence:true with a combined execution plan only ' +
    'when 2+ strategies agree (the curriculum\'s "complementary confirmation -> more accurate setup" principle, made ' +
    'mechanical); returns confluence:false with conflict:true if they disagree (no rule resolves that — stand down ' +
    'rather than guess), or confluence:false with conflict:false if only one strategy fired (no confirmation yet).',
    {
      signals: z.array(signalSchema).min(1).describe('Candidate signals from this scan, one per strategy that fired (e.g. [{strategy:"sfp",plan:...},{strategy:"divergence",plan:...}])'),
    },
    async ({ signals }) => {
      try {
        return jsonResult({
          success: true,
          ...core.assessConfluence({ signals: signals.map(s => ({ strategy: s.strategy, plan: s.plan, confirmedAt: s.confirmed_at })) }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
