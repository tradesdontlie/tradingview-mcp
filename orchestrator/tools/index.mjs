/**
 * In-process custom tools for the orchestrator agent, built on the Anthropic SDK
 * tool runner (betaZodTool + client.beta.messages.toolRunner). The agent reads
 * data, evaluates candidate configs (dry-run, no side effects), then commits ONE
 * decision through the autonomy gate.
 *
 * Win%/expectancy is estimated from the LIVE-MODEL trade logs: the live futures
 * ledger when it has ≥ MIN_SAMPLE retained trades, else the confluence-bot
 * backtest (which includes `levels` and the bias stack, on the objective's scale).
 * The strategy matrix is kept only as a relative ranking aid (lookup_matrix).
 *
 * Every guardrail lives in lib/ — these tools are thin typed wrappers so the
 * enforcement is unit-testable without the model in the loop.
 */
import { z } from 'zod';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { readFileSync } from 'node:fs';

import { readResolvedTrades, aggregateByCombo, ledgerTradesNormalized } from '../lib/ledger.mjs';
import { readBacktestTrades, aggregateTradesByCombo } from '../lib/backtest.mjs';
import { readEvents, summarizeEvents } from '../lib/events.mjs';
import { readMatrix, lookupCombo } from '../lib/matrix.mjs';
import { estimatePerformance } from '../lib/estimate.mjs';
import { validateProposal } from '../lib/guardrails.mjs';
import { applyDecision } from '../lib/apply.mjs';
import { UNIVERSE, THRESHOLDS } from '../config.mjs';

const filterSchema = z.object({
  enabled: z.boolean().optional(),
  bins: z.number().int().optional(),
  value_area_percent: z.number().optional(),
});
const candidateSchema = z.object({
  active_strategies: z.array(z.string()),
  active_filters: z.record(z.string(), filterSchema).optional(),
  param_overrides: z.record(z.string(), z.number()).optional(),
});

function readJsonSafe(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } }

export function buildTools({ paths, sinceMs = 0 }) {
  const matrixRows = readMatrix(paths.matrix);

  // Live-model trade logs, by bot.
  const ledgerCloses = readResolvedTrades(paths.ledger, { sinceMs });
  const ledgerTrades = ledgerTradesNormalized(ledgerCloses);          // futures only
  const backtestByBot = {
    spot: readBacktestTrades(paths.backtestSpot),
    futures: readBacktestTrades(paths.backtestFutures),
  };

  const tradesFor = (bot) => ({
    ledgerTrades: bot === 'futures' ? ledgerTrades : [],
    backtestTrades: backtestByBot[bot] ?? [],
  });
  const estimateFor = (bot, candidate) => estimatePerformance(candidate, tradesFor(bot));
  const currentSection = (bot) => (readJsonSafe(paths.config)[bot] ?? {});

  return [
    betaZodTool({
      name: 'read_backtest',
      description: 'Per-combo win% and expectancy from the confluence-bot backtest for a bot (the live-model baseline — includes levels and the bias stack). This is the primary win%/expectancy source for spot.',
      inputSchema: z.object({ bot: z.enum(['spot', 'futures']) }),
      run: async ({ bot }) => JSON.stringify(aggregateTradesByCombo(backtestByBot[bot] ?? {})),
    }),

    betaZodTool({
      name: 'read_live_ledger',
      description: 'Per-combo win%/expectancy from the futures bot\'s resolved trades (live). Preferred over the backtest for futures once a combo has ≥ 20 trades. Spot has no live ledger.',
      inputSchema: z.object({}),
      run: async () => JSON.stringify(Object.fromEntries(aggregateByCombo(ledgerCloses))),
    }),

    betaZodTool({
      name: 'read_events',
      description: 'Recent bot escalation events (scan errors, order failures, config fail-open, trade lifecycle) since the cycle cursor. Summarized.',
      inputSchema: z.object({ minSeverity: z.enum(['info', 'warn', 'error']).optional() }),
      run: async ({ minSeverity = 'info' }) =>
        JSON.stringify(summarizeEvents(readEvents(paths.events, { sinceMs, minSeverity }))),
    }),

    betaZodTool({
      name: 'lookup_matrix',
      description: 'RANKING AID ONLY. Neutral raw-edge sim stats for a combo (e.g. "divergence+sfp", or "+vwap" filter rows). Use for relative ranking of triggers/filters — its absolute win% is NOT on the objective\'s scale and excludes the levels strategy. Do not use it as the win%/expectancy of record.',
      inputSchema: z.object({ combo: z.string(), timeframe: z.string().optional(), filter: z.string().nullable().optional() }),
      run: async ({ combo, timeframe = '15m', filter = null }) =>
        JSON.stringify(lookupCombo(matrixRows, combo, { timeframe, filter }) ?? { error: 'not found' }),
    }),

    betaZodTool({
      name: 'evaluate_candidate',
      description: 'DRY RUN. Estimate a candidate config\'s win%/expectancy/sample (from the live-model trade logs) and run it through the guardrails. Returns classification (auto|approval|reject), violations, the clamped config, and the change list. No side effects. Iterate until a candidate passes.',
      inputSchema: z.object({ bot: z.enum(['spot', 'futures']), candidate: candidateSchema }),
      run: async ({ bot, candidate }) => {
        const estimate = estimateFor(bot, candidate);
        const result = validateProposal({ bot, current: currentSection(bot), candidate, estimate });
        return JSON.stringify({ estimate, ...result });
      },
    }),

    betaZodTool({
      name: 'commit_decision',
      description: 'Commit ONE decision through the autonomy gate. auto → writes orchestrator_config.json (versioned) + rationale. approval → stages to decisions/pending/. reject → records only. Re-validates server-side; you cannot bypass the guardrails by calling this directly.',
      inputSchema: z.object({ bot: z.enum(['spot', 'futures']), candidate: candidateSchema, rationale: z.string() }),
      run: async ({ bot, candidate, rationale }) => {
        const estimate = estimateFor(bot, candidate);
        const v = validateProposal({ bot, current: currentSection(bot), candidate, estimate });
        const out = applyDecision({
          bot, classification: v.classification, clamped: v.clamped, changes: v.changes,
          rationaleText: rationale, configPath: paths.config, decisionsDir: paths.decisions,
        });
        return JSON.stringify({ ...out, violations: v.violations, changes: v.changes });
      },
    }),
  ];
}

export const META = { UNIVERSE, THRESHOLDS };
