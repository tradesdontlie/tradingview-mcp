import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/fibonacci.js';

const barSchema = z.object({
  open: z.coerce.number(),
  high: z.coerce.number(),
  low: z.coerce.number(),
  close: z.coerce.number(),
}).passthrough();

const swingPointSchema = z.object({
  index: z.coerce.number().int(),
  price: z.coerce.number(),
}).passthrough();

const zoneSchema = z.object({
  high: z.coerce.number(),
  low: z.coerce.number(),
}).passthrough();

const hitSchema = z.object({
  index: z.coerce.number().int(),
  kind: z.enum(['first', 'retest']),
  entry: z.coerce.number(),
  stop: z.coerce.number(),
  bar: barSchema,
}).passthrough();

/**
 * Fibonacci confluence tools — pure pattern-matching over OHLC bar arrays
 * (e.g. from binance_get_klines / data_get_ohlcv), no live chart/exchange
 * calls of their own. Encodes Chapters 7 and 9 ("Fibonacci", "Fibs Advanced"):
 * draws a retracement from the prior swing extreme to the most recent one,
 * focuses on the curriculum's single named, precisely-bounded reaction zone —
 * the "golden pocket" (0.618-0.66) — and reads a reaction the same close-based
 * sweep-and-reject way as an SFP, generalized from a level to a zone. Per the
 * curriculum's repeated caution that "it is not advisable to use fib
 * retracement on their own", this is one independently-coded signal among
 * several fed into confluence_assess — never acted on alone.
 */
export function registerFibonacciTools(server) {
  server.tool(
    'fibonacci_golden_pocket',
    'Compute the golden-pocket zone (0.618-0.66 retracement region — the curriculum\'s single named, highest-conviction ' +
    'Fibonacci reaction zone) for a swing from a prior extreme (start) to the most recent extreme (end).',
    {
      start: z.coerce.number().positive().describe('Price at the prior swing extreme (point A) — swing low for an uptrend, swing high for a downtrend'),
      end: z.coerce.number().positive().describe('Price at the most recent swing extreme (point B) — swing high for an uptrend, swing low for a downtrend'),
      ratios: z.array(z.coerce.number()).length(2).optional().describe('The two retracement ratios bounding the pocket (default [0.618, 0.66])'),
    },
    async ({ start, end, ratios }) => {
      try { return jsonResult({ success: true, zone: core.findGoldenPocket({ start, end, ratios }) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'fibonacci_scan_reaction',
    'Scan a bar series for a golden-pocket reaction: anchors a retracement on the most recent swing high/low (whichever ' +
    'point is more recent decides the trend and the zone\'s role — support in an uptrend, resistance in a downtrend), ' +
    'then looks for a bar that wicks INTO the zone but CLOSES back out the trend-continuation side — the same close-based ' +
    'sweep-and-reject mechanic as an SFP, applied to a zone instead of a single level. Hits are tagged "first"/"retest".',
    {
      bars: z.array(barSchema).describe('OHLC candle array, oldest first (e.g. from binance klines)'),
      swing_high: swingPointSchema.describe('The most recent confirmed swing high — {index, price}'),
      swing_low: swingPointSchema.describe('The most recent confirmed swing low — {index, price}'),
      ratios: z.array(z.coerce.number()).length(2).optional().describe('The two retracement ratios bounding the golden pocket (default [0.618, 0.66])'),
      skip_dojis: z.coerce.boolean().optional().describe('Ignore indecision candles when scanning for the reaction (default true)'),
    },
    async ({ bars, swing_high, swing_low, ratios, skip_dojis }) => {
      try {
        return jsonResult({
          success: true,
          ...core.scanForFibReaction(bars, { swingHigh: swing_high, swingLow: swing_low, ratios, skipDojis: skip_dojis }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'fibonacci_build_trade_plan',
    'Build a trade plan (entry/stop/target/side) from a confirmed golden-pocket reaction (from fibonacci_scan_reaction), ' +
    'in the exact shape consumed by risk_evaluate_trade_setup — identically to sfp_build_trade_plan / divergence_build_trade_plan ' +
    '/ levels_build_trade_plan. Bullish reaction (golden-pocket support) -> long; bearish (resistance) -> short. Entry = close ' +
    'of the reaction candle; stop = beyond that candle\'s wick (market-structure based — "it is not advisable to use fib levels ' +
    'for stops"); target = the nearer of the last-swing level and/or the range level.',
    {
      hit: hitSchema.describe('The confirmed reaction hit (from fibonacci_scan_reaction)'),
      direction: z.enum(['bullish', 'bearish']).describe('The reaction direction from fibonacci_scan_reaction — bullish (support) -> long, bearish (resistance) -> short'),
      last_swing_level: z.coerce.number().positive().optional().describe('Price of the swing point being retraced toward — the primary continuation target'),
      range_level: z.coerce.number().positive().optional().describe('Price of the range high/low — the other valid target option (at least one target option is required)'),
    },
    async ({ hit, direction, last_swing_level, range_level }) => {
      try {
        return jsonResult({
          success: true,
          plan: core.buildFibTradePlan({ hit, direction, lastSwingLevel: last_swing_level, rangeLevel: range_level }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
