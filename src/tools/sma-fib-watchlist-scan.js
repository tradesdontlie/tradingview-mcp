import { z } from 'zod';
import { jsonResult } from './_format.js';
import {
  scanCurrentSmaFibWatchlist,
  scanSmaFibWatchlist,
} from '../core/sma-fib-watchlist-scan.js';
import { SMA_FIB_ATTENTION_CONDITIONS } from '../core/sma-fib-attention.js';

function errorPayload(error) {
  const payload = {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
  if (typeof error?.code === 'string' && error.code) payload.code = error.code;
  if (error?.partial_result !== undefined) payload.partial_result = error.partial_result;
  return payload;
}

export function registerSmaFibWatchlistScanTools(server, {
  scanCurrent = scanCurrentSmaFibWatchlist,
  scanExplicit = scanSmaFibWatchlist,
} = {}) {
  server.tool(
    'watchlist_scan_sma_fib_confluence',
    'On-demand Daily/Weekly scan of either the complete current watchlist or explicit exchange-qualified symbols. Returns independent 200D/200W MA and causal Fib observations plus derived confluence. Requires standard/non-synthetic chart data and exclusive chart use; restores the symbol, timeframe, horizontal range, bar spacing, and right offset with best-effort interference checks, and creates no alerts or persistent chart objects.',
    {
      symbols: z.array(z.string().min(1)).optional()
        .describe('Optional exchange-qualified symbols such as ["NYSE:BE"]. Omit to scan the active watchlist.'),
      exclusive_chart_use_confirmed: z.literal(true)
        .describe('Required acknowledgement that no person, task, or other chart tool will use the active chart during this scan.'),
      price_buffer_pct: z.number().finite().nonnegative().default(5)
        .describe('Legacy strict-confluence price buffer, in percent (default: 5)'),
      ma_buffer_pct: z.number().finite().nonnegative().optional()
        .describe('Independent price/range distance from the prior 200D/200W SMA; defaults to price_buffer_pct'),
      fib_buffer_pct: z.number().finite().nonnegative().optional()
        .describe('Independent price/range distance from the eligible golden pocket; defaults to price_buffer_pct'),
      alignment_tolerance_pct: z.number().finite().nonnegative().default(0)
        .describe('Maximum SMA-to-pocket structural gap, in percent (default: 0)'),
      conditions: z.array(z.enum(SMA_FIB_ATTENTION_CONDITIONS)).min(1).optional()
        .describe('Optional independent conditions to filter, for example ["MA_NEAR", "FIB_INSIDE"]'),
      condition_operator: z.enum(['and', 'or']).default('or')
        .describe('How multiple conditions are combined (default: or)'),
      minimum_family_count: z.number().int().min(0).max(2).default(0)
        .describe('Minimum independently active primitive families: 0, 1, or 2'),
      timeframes: z.array(z.enum(['D', 'W'])).min(1).optional()
        .describe('Optional Daily/Weekly filter'),
      observation_kinds: z.array(z.enum(['current', 'last_closed'])).min(1).optional()
        .describe('Choose current, last-closed, or both; when another filter is supplied, omission means current only'),
      include_provisional: z.boolean().default(true)
        .describe('Whether current unclosed Daily/Weekly observations remain eligible'),
    },
    async ({
      symbols,
      exclusive_chart_use_confirmed,
      price_buffer_pct = 5,
      ma_buffer_pct,
      fib_buffer_pct,
      alignment_tolerance_pct = 0,
      conditions,
      condition_operator = 'or',
      minimum_family_count = 0,
      timeframes,
      observation_kinds,
      include_provisional = true,
    } = {}) => {
      try {
        const options = {
          priceBufferPct: price_buffer_pct,
          alignmentTolerancePct: alignment_tolerance_pct,
          exclusiveChartUseConfirmed: exclusive_chart_use_confirmed,
        };
        if (ma_buffer_pct !== undefined) options.maBufferPct = ma_buffer_pct;
        if (fib_buffer_pct !== undefined) options.fibBufferPct = fib_buffer_pct;
        const queryRequested = conditions !== undefined
          || timeframes !== undefined
          || observation_kinds !== undefined
          || minimum_family_count > 0
          || include_provisional === false;
        if (queryRequested) {
          const structuredQuery = {
            operator: condition_operator,
            minimumFamilyCount: minimum_family_count,
            includeProvisional: include_provisional,
            observationKinds: observation_kinds ?? ['current'],
          };
          if (conditions !== undefined) structuredQuery.conditions = conditions;
          if (timeframes !== undefined) structuredQuery.timeframes = timeframes;
          options.query = structuredQuery;
        }
        if (symbols !== undefined) {
          return jsonResult(await scanExplicit({ ...options, symbols }));
        }
        return jsonResult(await scanCurrent(options));
      } catch (error) {
        return jsonResult(errorPayload(error), true);
      }
    },
  );
}
