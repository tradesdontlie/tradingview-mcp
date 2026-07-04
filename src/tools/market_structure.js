import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/market_structure.js';

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

const chochSchema = z.object({
  direction: z.enum(['bullish', 'bearish']),
  sequenceNumber: z.coerce.number().int(),
  index: z.coerce.number().int(),
  entry: z.coerce.number(),
  level: z.coerce.number(),
  pullbackExtreme: z.coerce.number(),
  bar: barSchema,
}).passthrough();

/**
 * Market Structure (BOS/CHoCH) tools — pure pattern-matching over OHLC bar
 * arrays and pre-identified swing points (e.g. from sfp_find_swing_highs/lows
 * or binance klines), no live chart/exchange calls of their own. Encodes
 * Chapters 4 and 5 ("PA Part 1 Market Structure", "Completing the
 * Foundation"): labels swing points HH/HL/LH/LL, confirms BOS via a
 * close-based break of the prior same-type extreme, then tracks the CHoCH
 * cycle within that leg's substructure — the first CHoCH opposes the trend
 * ("the first sign of weakness, not a guarantee"), the second realigns with
 * it and is the curriculum's actual entry trigger ("we enter on the first
 * green candle closing above the bullish CHoCH"). Per "use it in confluence
 * with other tools", this is one independently-coded signal among several
 * fed into confluence_assess — never acted on alone.
 */
export function registerMarketStructureTools(server) {
  server.tool(
    'market_structure_detect',
    'Detect market structure (HH/HL/LH/LL labeling, confirmed Break-of-Structure events, and the Change-of-Character cycle ' +
    'within the most recent leg) from a bar series and its swing highs/lows. BOS = a close-based break of the prior same-type ' +
    'swing extreme (a new HH or LL). CHoCH = a close-based break of a minor (substructure) pivot that formed after the BOS leg\'s ' +
    'deep counter-point — the first CHoCH opposes the established trend (a warning, not a trigger), the second realigns with it ' +
    '(the entry trigger). Returns the labeled sequence, all confirmed BOS events, all CHoCH events, and the current trend.',
    {
      bars: z.array(barSchema).describe('OHLC candle array, oldest first (e.g. from binance klines)'),
      swing_highs: z.array(swingPointSchema).describe('Confirmed swing highs in chronological order — [{index, price}, ...]'),
      swing_lows: z.array(swingPointSchema).describe('Confirmed swing lows in chronological order — [{index, price}, ...]'),
    },
    async ({ bars, swing_highs, swing_lows }) => {
      try {
        return jsonResult({ success: true, ...core.detectMarketStructure(bars, { swingHighs: swing_highs, swingLows: swing_lows }) });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'market_structure_build_trade_plan',
    'Build a trade plan (entry/stop/target/side) from a CHoCH event that REALIGNS with the established trend (from ' +
    'market_structure_detect) — the curriculum\'s actual entry trigger, in the exact shape consumed by risk_evaluate_trade_setup, ' +
    'identically to sfp_build_trade_plan / divergence_build_trade_plan / levels_build_trade_plan / fibonacci_build_trade_plan. ' +
    'Bullish CHoCH realigning with a bullish trend -> long; bearish realigning with bearish -> short. A CHoCH that OPPOSES the ' +
    'trend is rejected — it is "merely the first sign of weakness, not a signal". Entry = close of the break candle; stop = ' +
    'beyond the pullback\'s extreme; target = the nearer of the last-swing level and/or the range level.',
    {
      choch: chochSchema.describe('A confirmed CHoCH event from market_structure_detect (must match the trend to be tradeable)'),
      trend: z.enum(['bullish', 'bearish']).describe('The current trend from market_structure_detect'),
      last_swing_level: z.coerce.number().optional().describe('Price of the swing point being targeted (e.g. "target the previous HH") — the primary continuation target'),
      range_level: z.coerce.number().optional().describe('Price of the range high/low — the other valid target option (at least one target option is required)'),
    },
    async ({ choch, trend, last_swing_level, range_level }) => {
      try {
        return jsonResult({
          success: true,
          plan: core.buildStructureTradePlan({ choch, trend, lastSwingLevel: last_swing_level, rangeLevel: range_level }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
