import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/sfp.js';

const barSchema = z.object({
  open: z.coerce.number(),
  high: z.coerce.number(),
  low: z.coerce.number(),
  close: z.coerce.number(),
}).passthrough();

/**
 * Swing Failure Pattern (SFP) detection tools — pure pattern-matching over
 * OHLC bar arrays (e.g. from binance_get_klines / data_get_ohlcv), no live
 * chart/exchange calls of their own. This is the curriculum's most
 * cross-validated single technique (identical mechanics independently
 * confirmed across three chapters), so it's the first setup-detection
 * pattern being encoded — still subject to the framework's testing-queue
 * validation before being trusted live.
 */
export function registerSfpTools(server) {
  server.tool('sfp_find_swing_highs', 'Find local swing-high points in a bar series (candidate "key" resistance levels for SFP detection)', {
    bars: z.array(barSchema).describe('OHLC candle array, oldest first (e.g. from binance klines)'),
    lookback: z.coerce.number().int().positive().optional().describe('Bars on each side that must be lower for a point to count as a swing high (default 2)'),
  }, async ({ bars, lookback }) => {
    try { return jsonResult({ success: true, swings: core.findSwingHighs(bars, { lookback }) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('sfp_find_swing_lows', 'Find local swing-low points in a bar series (candidate "key" support levels for SFP detection)', {
    bars: z.array(barSchema).describe('OHLC candle array, oldest first (e.g. from binance klines)'),
    lookback: z.coerce.number().int().positive().optional().describe('Bars on each side that must be higher for a point to count as a swing low (default 2)'),
  }, async ({ bars, lookback }) => {
    try { return jsonResult({ success: true, swings: core.findSwingLows(bars, { lookback }) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('sfp_is_doji', 'Check whether a candle qualifies as a doji (small body relative to its range — a filter for unreliable SFP sweep candles)', {
    bar: barSchema.describe('A single OHLC candle'),
    max_body_to_range_ratio: z.coerce.number().positive().optional().describe('Body/range ratio at or below which a candle counts as a doji (default 0.1)'),
  }, async ({ bar, max_body_to_range_ratio }) => {
    try { return jsonResult({ success: true, is_doji: core.isDoji(bar, { maxBodyToRangeRatio: max_body_to_range_ratio }) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool(
    'sfp_scan',
    'Scan a bar series for Swing Failure Patterns at a given key level: a candle that wicks beyond the level ' +
    'but CLOSES back on the origin side (close-based confirmation). Returns each confirmed hit tagged "first" ' +
    'or "retest" — per the curriculum, a retest sweep is HIGHER conviction, not a lesser consolation entry. ' +
    'Dojis are skipped by default since they signal unreliable market indecision.',
    {
      bars: z.array(barSchema).describe('OHLC candle array to scan, oldest first — should be the bars occurring AFTER the key level was established'),
      level: z.coerce.number().positive().describe('The key swing-high or swing-low price level to test for sweeps'),
      type: z.enum(['bullish', 'bearish']).describe('"bearish" = sweep of a key high/resistance (signals a potential short); "bullish" = sweep of a key low/support (signals a potential long)'),
      skip_dojis: z.coerce.boolean().optional().describe('Skip sweep candles that are dojis (default true)'),
    },
    async ({ bars, level, type, skip_dojis }) => {
      try { return jsonResult({ success: true, hits: core.scanForSFP(bars, { level, type, skipDojis: skip_dojis }) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'sfp_build_trade_plan',
    'Build a trade plan (entry/stop/target/side) from a confirmed SFP hit (from sfp_scan), in the exact shape ' +
    'consumed by risk_evaluate_trade_setup — closing the loop between setup detection and the deterministic risk gate. ' +
    'A bearish SFP produces a short plan; a bullish SFP produces a long plan (an SFP signals trend-failure/reversal). ' +
    'Per the curriculum, target = the last swing high/low and/or the range high/low; the nearer one in the favorable ' +
    'direction becomes the primary target, the other an alternate.',
    {
      hit: z.object({
        entry: z.coerce.number().positive(),
        stop: z.coerce.number().positive(),
        kind: z.enum(['first', 'retest']).optional(),
      }).passthrough().describe('A confirmed hit object from sfp_scan (must include entry and stop)'),
      type: z.enum(['bullish', 'bearish']).describe('The SFP type that produced this hit'),
      last_swing_level: z.coerce.number().positive().optional().describe('Price of the last swing high/low — a valid target option per the curriculum'),
      range_level: z.coerce.number().positive().optional().describe('Price of the range high/low — the other valid target option (at least one of the two target options is required)'),
    },
    async ({ hit, type, last_swing_level, range_level }) => {
      try {
        return jsonResult({
          success: true,
          plan: core.buildSFPTradePlan({ hit, type, lastSwingLevel: last_swing_level, rangeLevel: range_level }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
