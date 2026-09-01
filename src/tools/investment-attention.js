import { z } from 'zod';

import {
  DEFAULT_ATTENTION_STATE_DIR,
  DEFAULT_ATTENTION_INBOX_PATH,
  sourceBindingFor,
} from '../core/investment-attention-config.js';
import {
  collectInboxOnce,
  collectorSourceBindings,
} from '../core/investment-attention-collector.js';
import {
  assessInvestmentAttentionAlertHealth,
  buildInvestmentAttentionWeeklyReview,
  buildRouteCoverageReceipt,
  readInvestmentAttentionReceipt,
  writeInvestmentAttentionHealthReceipt,
} from '../core/investment-attention-health.js';
import { queryInvestmentAttention } from '../core/investment-attention-query.js';
import { jsonResult } from './_format.js';

function failure(error, code) {
  return {
    success: false,
    code: error?.code ?? code,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function registerInvestmentAttentionTools(server) {
  server.tool(
    'watchlist_query_investment_attention',
    'Read the append-only four-family Investment Attention state for the active watchlist or one exact symbol/timeframe. Returns Cup current lifecycle/latest event and an unchanged flag; reads never notify again.',
    {
      state_dir: z.string().optional().describe('Absolute local ledger state directory.'),
      symbol: z.string().optional().describe('Optional exchange-qualified symbol, such as NASDAQ:NVDA.'),
      timeframe: z.enum(['D', 'W', '4H', '1D', '1W', '240']).optional(),
      family: z.enum(['sma_fib', 'rsi', 'cup_and_handle', 'cup']).optional(),
      since_revision: z.number().int().nonnegative().optional(),
    },
    async ({ state_dir = DEFAULT_ATTENTION_STATE_DIR, symbol, timeframe, family, since_revision } = {}) => {
      try {
        return jsonResult(queryInvestmentAttention({
          stateDir: state_dir,
          symbol,
          timeframe,
          family,
          sinceRevision: since_revision,
        }));
      } catch (error) {
        return jsonResult(failure(error, 'investment_attention_query_failed'), true);
      }
    },
  );

  server.tool(
    'investment_attention_collect_once',
    'Consume complete payload lines from the local append-only attention inbox and persist them with stable IDs. No network endpoint is opened.',
    {
      state_dir: z.string().optional(),
      inbox_path: z.string().optional(),
      bootstrap: z.boolean().optional().default(false),
    },
    async ({ state_dir = DEFAULT_ATTENTION_STATE_DIR, inbox_path = DEFAULT_ATTENTION_INBOX_PATH, bootstrap = false } = {}) => {
      try {
        return jsonResult(await collectInboxOnce({
          stateDir: state_dir,
          inboxPath: inbox_path,
          sourceBindings: collectorSourceBindings(),
          bootstrap,
        }));
      } catch (error) {
        return jsonResult(failure(error, 'investment_attention_collect_failed'), true);
      }
    },
  );

  server.tool(
    'investment_attention_health',
    'Return the last stored route-coverage and alert-health receipts, without changing TradingView or ledger state.',
    { state_dir: z.string().optional() },
    async ({ state_dir = DEFAULT_ATTENTION_STATE_DIR } = {}) => jsonResult({
      route_coverage: readInvestmentAttentionReceipt(state_dir, 'route-coverage.json'),
      alert_health: readInvestmentAttentionReceipt(state_dir, 'alert-health.json'),
      collector_heartbeat: readInvestmentAttentionReceipt(state_dir, 'collector-heartbeat.json'),
      source_bindings: collectorSourceBindings(),
      source_binding_contracts: {
        sma_fib: sourceBindingFor('sma_fib'),
        rsi: sourceBindingFor('rsi', 1),
        cup_and_handle: sourceBindingFor('cup_and_handle'),
      },
    }),
  );

  server.tool(
    'investment_attention_weekly_review',
    'Read or build the bounded weekly usefulness/noise/duplicates/invalidations/misses/outcomes review. Predictive efficacy and trading-return claims remain disabled.',
    {
      state_dir: z.string().optional(),
      week_start: z.string(),
      week_end: z.string(),
      family_canaries: z.array(z.object({ family: z.string(), passed: z.boolean(), evidence_ref: z.string().nullable().optional() })).optional(),
      miss_sampling_passed: z.boolean().optional().default(false),
      miss_sampling_count: z.number().int().nonnegative().optional().default(0),
    },
    async ({ state_dir = DEFAULT_ATTENTION_STATE_DIR, week_start, week_end, family_canaries = [], miss_sampling_passed = false, miss_sampling_count = 0 } = {}) => {
      try {
        const health = readInvestmentAttentionReceipt(state_dir, 'alert-health.json');
        return jsonResult(buildInvestmentAttentionWeeklyReview({
          stateDir: state_dir,
          weekStart: week_start,
          weekEnd: week_end,
          familyCanaries: family_canaries,
          missSampling: { passed: miss_sampling_passed, candidates: Array.from({ length: miss_sampling_count }, (_, index) => ({ id: index })) },
          health,
        }));
      } catch (error) {
        return jsonResult(failure(error, 'investment_attention_weekly_review_failed'), true);
      }
    },
  );
}

export {
  assessInvestmentAttentionAlertHealth,
  buildInvestmentAttentionWeeklyReview,
  buildRouteCoverageReceipt,
  writeInvestmentAttentionHealthReceipt,
};
