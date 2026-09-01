import { z } from 'zod';

import { RSI_BULLISH_CONDITIONS } from '../core/rsi-attention.js';
import { SMA_FIB_ATTENTION_CONDITIONS } from '../core/sma-fib-attention.js';
import { scanUnifiedAttention } from '../core/unified-attention-scan.js';
import { jsonResult } from './_format.js';

const ATTENTION_CONDITIONS = Object.freeze([
  ...SMA_FIB_ATTENTION_CONDITIONS,
  ...RSI_BULLISH_CONDITIONS,
]);

function errorPayload(error) {
  const payload = {
    success: false,
    code: error?.code ?? 'investment_attention_scan_failed',
    error: error instanceof Error ? error.message : String(error),
  };
  if (error?.partial_result) payload.partial_result = error.partial_result;
  return payload;
}

export function registerUnifiedAttentionScanTools(server, {
  scan = scanUnifiedAttention,
} = {}) {
  server.tool(
    'watchlist_scan_investment_attention',
    'Scan the complete active watchlist, or explicit exchange-qualified symbols, for independent Daily/Weekly prior-200 MA, causal golden-pocket Fib, and bullish RSI states. Supports AND/OR filtering and overlap ranking. It requires standard/non-synthetic chart data and exclusive chart use; restores the symbol, timeframe, horizontal range, bar spacing, and right offset with best-effort interference checks, and never changes alerts. MA is derived independently; Fib requires the exact applied V2 binding, while RSI requires exact applied-source and semantic-input binding.',
    {
      symbols: z.array(z.string().min(1)).optional()
        .describe('Optional exchange-qualified symbols such as ["NYSE:BE"]. Omit to scan the active watchlist.'),
      exclusive_chart_use_confirmed: z.literal(true)
        .describe('Required acknowledgement that no person, task, or other chart tool will use the active chart during this scan.'),
      price_buffer_pct: z.number().finite().nonnegative().default(5)
        .describe('Default independent MA and Fib current-price distance buffer in percent (default: 5)'),
      ma_buffer_pct: z.number().finite().nonnegative().optional()
        .describe('MA distance buffer in percent; defaults to price_buffer_pct'),
      fib_buffer_pct: z.number().finite().nonnegative().optional()
        .describe('Fib-pocket distance buffer in percent; defaults to price_buffer_pct'),
      alignment_tolerance_pct: z.number().finite().nonnegative().default(0)
        .describe('Maximum structural SMA-to-pocket gap for derived SMA/Fib confluence (default: 0)'),
      conditions: z.array(z.enum(ATTENTION_CONDITIONS)).min(1).optional()
        .describe('Optional exact conditions, e.g. ["FIB_INSIDE", "RSI_DEVELOPING_HIDDEN_BULL"]'),
      families: z.array(z.enum(['ma', 'fib', 'rsi'])).min(1).optional()
        .describe('Optional primitive families to require or match'),
      condition_operator: z.enum(['and', 'or']).default('or')
        .describe('Applied to condition and family lists (default: or)'),
      minimum_family_count: z.number().int().min(0).max(3).optional()
        .describe('Minimum independently active primitive families among MA, Fib, and RSI'),
      timeframes: z.array(z.enum(['D', 'W'])).min(1).optional()
        .describe('Optional Daily/Weekly filter'),
      observation_kinds: z.array(z.enum(['current', 'last_closed'])).min(1).optional()
        .describe('Filter current, last-closed, or both; when another filter is supplied, omission means current only'),
      include_provisional: z.boolean().default(true)
        .describe('Whether unclosed Daily/Weekly observations remain eligible (default: true)'),
      require_complete_sources: z.boolean().default(false)
        .describe('Require both SMA/Fib and RSI observations for the exact same target bar'),
      rsi_kinds: z.array(z.enum(['regular', 'hidden'])).min(1).optional()
        .describe('Optional bullish RSI divergence kind filter'),
      rsi_stages: z.array(z.enum([
        'WATCH',
        'DEVELOPING_ACTIVE',
        'NEW_DEVELOPING',
        'CONFIRMED',
      ])).min(1).optional().describe('Optional bullish RSI lifecycle-stage filter'),
    },
    async ({
      symbols,
      exclusive_chart_use_confirmed,
      price_buffer_pct = 5,
      ma_buffer_pct,
      fib_buffer_pct,
      alignment_tolerance_pct = 0,
      conditions,
      families,
      condition_operator = 'or',
      minimum_family_count,
      timeframes,
      observation_kinds,
      include_provisional = true,
      require_complete_sources = false,
      rsi_kinds,
      rsi_stages,
    } = {}) => {
      try {
        const options = {
          priceBufferPct: price_buffer_pct,
          alignmentTolerancePct: alignment_tolerance_pct,
          exclusiveChartUseConfirmed: exclusive_chart_use_confirmed,
        };
        if (symbols !== undefined) options.symbols = symbols;
        if (ma_buffer_pct !== undefined) options.maBufferPct = ma_buffer_pct;
        if (fib_buffer_pct !== undefined) options.fibBufferPct = fib_buffer_pct;

        const queryRequested = conditions !== undefined
          || families !== undefined
          || minimum_family_count !== undefined
          || timeframes !== undefined
          || observation_kinds !== undefined
          || include_provisional === false
          || require_complete_sources === true
          || rsi_kinds !== undefined
          || rsi_stages !== undefined;
        if (queryRequested) {
          const query = {
            operator: condition_operator,
            includeProvisional: include_provisional,
            requireCompleteSources: require_complete_sources,
            observationKinds: observation_kinds ?? ['current'],
          };
          if (conditions !== undefined) query.conditions = conditions;
          if (families !== undefined) query.families = families;
          if (minimum_family_count !== undefined) {
            query.minimumFamilyCount = minimum_family_count;
          }
          if (timeframes !== undefined) query.timeframes = timeframes;
          if (rsi_kinds !== undefined) query.rsiKinds = rsi_kinds;
          if (rsi_stages !== undefined) query.rsiStages = rsi_stages;
          options.query = query;
        }
        return jsonResult(await scan(options));
      } catch (error) {
        return jsonResult(errorPayload(error), true);
      }
    },
  );
}
