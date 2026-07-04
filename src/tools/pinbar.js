import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pinbar.js';

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

const hitSchema = z.object({
  index: z.coerce.number().int(),
  direction: z.enum(['bullish', 'bearish']),
  level: z.coerce.number(),
  entry: z.coerce.number(),
  stop: z.coerce.number(),
  biasIndex: z.coerce.number().int(),
  bar: barSchema,
}).passthrough();

/**
 * Pinbar Reversal Bias tools — pure pattern-matching over OHLC bar arrays and
 * pre-identified swing points (e.g. from sfp_find_swing_highs/lows or binance
 * klines), no live chart/exchange calls of their own. Encodes Chapter 3
 * ("HTF Bias and LTF Execution"), Type 1 (Pinbar/Reversal candles): a pinbar
 * forming AT the most recent swing extreme ("the end of a trend or a swing")
 * with a long dominant wick and minimal opposite wick, traded on the
 * close-based retest of the candle-before's level ("the best entry... is the
 * retest of the low of the candle before the pinbar"), stop beyond the
 * pinbar's defining wick on a closing basis. Deliberately scoped to Pinbar
 * only — the chapter's other pattern (Engulfing) depends on an externally
 * located HTF level with no mechanical spec, so it's left uncoded. Per
 * "trading reversals inherently has some risk... always be looking for
 * confluence", this is one independently-coded signal among several fed into
 * confluence_assess — never acted on alone.
 */
export function registerPinbarTools(server) {
  server.tool(
    'pinbar_scan',
    'Scan for a Pinbar reversal-bias setup: a pinbar candle forming AT the most recent confirmed swing extreme ' +
    '("the end of a trend or a swing" — a bullish pinbar must BE the latest swing low, a bearish one the latest swing high), ' +
    'with a long dominant wick and minimal opposite wick, followed by a close-based retest of the candle-before\'s level ' +
    '("the best entry for a pinbar is the retest of the low of the candle before the pinbar"). Returns ready-to-trade hits ' +
    'with entry (the retest candle\'s close), stop (beyond the pinbar\'s defining wick — "on a closing basis"), and the bias candle.',
    {
      bars: z.array(barSchema).describe('OHLC candle array, oldest first (e.g. from binance klines)'),
      swing_highs: z.array(swingPointSchema).describe('Confirmed swing highs in chronological order — [{index, price}, ...]'),
      swing_lows: z.array(swingPointSchema).describe('Confirmed swing lows in chronological order — [{index, price}, ...]'),
      skip_dojis: z.boolean().optional().describe('Skip doji-shaped candles when scanning (default true — a doji cannot be a genuine pinbar)'),
    },
    async ({ bars, swing_highs, swing_lows, skip_dojis }) => {
      try {
        return jsonResult({
          success: true,
          ...core.scanForPinbarSetup(bars, { swingHighs: swing_highs, swingLows: swing_lows, skipDojis: skip_dojis }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'pinbar_build_trade_plan',
    'Build a trade plan (entry/stop/target/side) from a confirmed Pinbar retest setup (from pinbar_scan), in the exact shape ' +
    'consumed by risk_evaluate_trade_setup, identically to sfp_build_trade_plan / divergence_build_trade_plan / ' +
    'levels_build_trade_plan / fibonacci_build_trade_plan / market_structure_build_trade_plan. Bullish pinbar at a swing low -> ' +
    'long; bearish at a swing high -> short. Entry = close of the retest candle; stop = beyond the pinbar\'s defining wick on a ' +
    'closing basis ("stop is to be placed below the low of the pinbar"); target = the nearer of the last-swing level and/or the ' +
    'range level — "it becomes a level to level trade".',
    {
      hit: hitSchema.describe('A confirmed pinbar retest setup from pinbar_scan'),
      last_swing_level: z.coerce.number().optional().describe('Price of the swing point being targeted — the primary continuation target'),
      range_level: z.coerce.number().optional().describe('Price of the range high/low — the other valid target option (at least one target option is required)'),
    },
    async ({ hit, last_swing_level, range_level }) => {
      try {
        return jsonResult({
          success: true,
          plan: core.buildPinbarTradePlan({ hit, lastSwingLevel: last_swing_level, rangeLevel: range_level }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
