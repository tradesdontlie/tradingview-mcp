import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/levels.js';

const barSchema = z.object({
  open: z.coerce.number(),
  high: z.coerce.number(),
  low: z.coerce.number(),
  close: z.coerce.number(),
}).passthrough();

const zoneSchema = z.object({
  type: z.enum(['support', 'resistance']),
  classification: z.enum(['continuation', 'reversal']),
  high: z.coerce.number(),
  low: z.coerce.number(),
  breakout_index: z.coerce.number().int(),
}).passthrough();

const hitSchema = z.object({
  index: z.coerce.number().int(),
  kind: z.enum(['first', 'retest']),
  bar: barSchema,
}).passthrough();

/**
 * Key Levels / Zones detection tools — pure pattern-matching over OHLC bar
 * arrays (e.g. from binance_get_klines / data_get_ohlcv), no live chart/
 * exchange calls of their own. Encodes Chapters 2, 6 and 8 ("Trading: Level
 * to Level", "Levels Final", "Support and Resistance Zones"): a zone is a
 * tight consolidation range that price broke out of, classified support/
 * resistance by breakout direction and continuation/reversal by what the
 * breakout did to the prior trend. The trade trigger is price RETURNING to
 * retest a confirmed zone — buy support zones, sell resistance zones.
 */
export function registerLevelsTools(server) {
  server.tool(
    'levels_find_consolidation_ranges',
    'Find tight consolidation ranges (adjacent swing-high/swing-low pairs close enough together to read as one zone) — the raw material zones are built from',
    {
      bars: z.array(barSchema).describe('OHLC candle array, oldest first (e.g. from binance klines)'),
      swing_lookback: z.coerce.number().int().positive().optional().describe('Bars on each side required to confirm a swing point (default 2)'),
      max_range_percent: z.coerce.number().positive().optional().describe('Max percent gap between the swing high and low for the pair to count as one tight range (default 3)'),
    },
    async ({ bars, swing_lookback, max_range_percent }) => {
      try { return jsonResult({ success: true, ranges: core.findConsolidationRanges(bars, { swingLookback: swing_lookback, maxRangePercent: max_range_percent }) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'levels_detect_zones',
    'Scan a bar series for confirmed support/resistance zones: finds tight consolidation ranges, confirms each one\'s ' +
    'close-based breakout, and classifies it support (broke up) or resistance (broke down), continuation (matches the ' +
    'prior trend) or reversal (opposes it) — per the curriculum\'s Support & Resistance Zones chapter. Zones with no ' +
    'confirmed breakout yet, or no clear prior trend to compare against, are excluded.',
    {
      bars: z.array(barSchema).describe('OHLC candle array to scan, oldest first'),
      swing_lookback: z.coerce.number().int().positive().optional().describe('Bars on each side required to confirm a swing point (default 2)'),
      max_range_percent: z.coerce.number().positive().optional().describe('Max percent gap between the swing high and low for a tight range (default 3)'),
      trend_lookback: z.coerce.number().int().positive().optional().describe('Bars to look back from the range start to read the prior trend (default 5)'),
    },
    async ({ bars, swing_lookback, max_range_percent, trend_lookback }) => {
      try {
        return jsonResult({
          success: true,
          zones: core.detectZones(bars, { swingLookback: swing_lookback, maxRangePercent: max_range_percent, trendLookback: trend_lookback }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'levels_find_zone_retests',
    'Find bars (after a zone\'s breakout) whose range overlaps the zone — i.e. price RETURNING to retest it, the ' +
    'curriculum\'s actual trade trigger ("if price never returns to our zone, we never jump into the trade"). ' +
    'Hits are tagged "first" (freshest, highest conviction) or "retest" (repeat touch, weaker).',
    {
      bars: z.array(barSchema).describe('OHLC candle array, oldest first — same series the zone was detected on'),
      zone: zoneSchema.describe('A confirmed zone object from levels_detect_zones'),
    },
    async ({ bars, zone }) => {
      try { return jsonResult({ success: true, hits: core.findZoneRetests(bars, zone) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'levels_build_trade_plan',
    'Build a trade plan (entry/stop/target/side) from a confirmed zone retest (from levels_find_zone_retests), in the ' +
    'exact shape consumed by risk_evaluate_trade_setup — identically to sfp_build_trade_plan / divergence_build_trade_plan. ' +
    'Support zone retest -> long ("buy support zones"); resistance zone retest -> short ("sell resistance zones"). ' +
    'Entry = close of the retest candle; stop = the zone\'s far boundary (crossing all the way through invalidates the read); ' +
    'target = the nearer of the next opposing zone\'s level ("First Trouble Area") and/or the range level.',
    {
      zone: zoneSchema.describe('The confirmed zone being retested (from levels_detect_zones)'),
      hit: hitSchema.describe('The confirmed retest hit (from levels_find_zone_retests)'),
      opposite_zone_level: z.coerce.number().positive().optional().describe('Price of the next opposing zone — the curriculum\'s "First Trouble Area" target'),
      range_level: z.coerce.number().positive().optional().describe('Price of the range high/low — the other valid target option (at least one target option is required)'),
    },
    async ({ zone, hit, opposite_zone_level, range_level }) => {
      try {
        return jsonResult({
          success: true,
          plan: core.buildZoneTradePlan({ zone, hit, oppositeZoneLevel: opposite_zone_level, rangeLevel: range_level }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
