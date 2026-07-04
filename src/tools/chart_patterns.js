import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/chart_patterns.js';

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

const patternSchema = z.object({
  type: z.string(),
}).passthrough();

const breakoutSchema = z.object({
  index: z.coerce.number().int(),
  bar: barSchema,
}).passthrough();

/**
 * Classic chart pattern tools — pure pattern-matching over OHLC bar arrays
 * and pre-identified swing points (e.g. from sfp_find_swing_highs/lows),
 * no live chart/exchange calls of their own. NOT from the PDF curriculum —
 * these are standard technical-analysis chart patterns (the "next layer" of
 * trader experience beyond the 13 encoded chapters): Double Top/Bottom,
 * Head & Shoulders/Inverse, Triangles (ascending/descending/symmetrical), and
 * Flags/Pennants. All breakouts/confirmations are CLOSE-based, matching the
 * close-based-confirmation standard used everywhere else in this bot. Like
 * the other setup-detection tools, this is one independently-coded signal
 * fed into confluence_assess — never acted on alone.
 */
export function registerChartPatternsTools(server) {
  server.tool(
    'chart_pattern_find_double_top_bottom',
    'Find Double Top / Double Bottom patterns from a bar series and its swing highs/lows. A double top is two ' +
    'consecutive swing highs within tolerance_percent of each other (an "M") with the neckline = the lowest swing ' +
    'low between them; a double bottom mirrors this with swing lows (a "W") and neckline = the highest swing high ' +
    'between the two troughs. Returns each pattern with its neckline level, breakout direction, side, height, and stop level.',
    {
      bars: z.array(barSchema).describe('OHLC candle array, oldest first (e.g. from binance klines)'),
      swing_highs: z.array(swingPointSchema).describe('Confirmed swing highs in chronological order — [{index, price}, ...]'),
      swing_lows: z.array(swingPointSchema).describe('Confirmed swing lows in chronological order — [{index, price}, ...]'),
      tolerance_percent: z.coerce.number().positive().optional().describe('Max % difference between the two peaks/troughs to count as "near-equal" (default 1.5)'),
    },
    async ({ bars, swing_highs, swing_lows, tolerance_percent }) => {
      try {
        return jsonResult({
          success: true,
          patterns: core.findDoubleTopBottom(bars, { swingHighs: swing_highs, swingLows: swing_lows, tolerancePercent: tolerance_percent }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'chart_pattern_scan_neckline_break',
    'Scan a bar series for the close-based break of a pattern\'s neckline — the confirmation event for Double Top/Bottom ' +
    'and Head & Shoulders/Inverse Head & Shoulders patterns (both share the same {necklineLevel, breakoutDirection, fromIndex} ' +
    'shape). Returns null if no break has occurred yet.',
    {
      bars: z.array(barSchema).describe('OHLC candle array, oldest first — should include bars after the pattern formed'),
      pattern: patternSchema.describe('A pattern result from chart_pattern_find_double_top_bottom or chart_pattern_find_head_and_shoulders'),
    },
    async ({ bars, pattern }) => {
      try { return jsonResult({ success: true, breakout: core.scanForNecklineBreak(bars, pattern) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'chart_pattern_build_double_top_bottom_plan',
    'Build a trade plan (entry/stop/target/side) from a confirmed Double Top/Bottom neckline break, in the exact shape ' +
    'consumed by risk_evaluate_trade_setup. entry = close of the break candle; stop = the pattern\'s extreme (the higher ' +
    'top / lower bottom); target = the measured move (pattern height projected from entry in the favorable direction).',
    {
      pattern: patternSchema.describe('A double_top/double_bottom result from chart_pattern_find_double_top_bottom'),
      breakout: breakoutSchema.describe('A confirmed neckline break from chart_pattern_scan_neckline_break'),
      range_level: z.coerce.number().optional().describe('Price of the range high/low — becomes the plan\'s alternate_target'),
    },
    async ({ pattern, breakout, range_level }) => {
      try { return jsonResult({ success: true, plan: core.buildDoubleTopBottomTradePlan({ pattern, breakout, rangeLevel: range_level }) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'chart_pattern_find_head_and_shoulders',
    'Find Head & Shoulders / Inverse Head & Shoulders patterns from a bar series and its swing highs/lows. H&S is three ' +
    'consecutive swing highs (Left Shoulder, Head, Right Shoulder) where the Head exceeds both shoulders and the shoulders ' +
    'are within shoulder_tolerance_percent of each other; the neckline = the HIGHER of the two swing lows flanking the head. ' +
    'Inverse H&S mirrors this with swing lows (Head is the lowest), neckline = the LOWER of the two flanking swing highs. ' +
    'Returns each pattern with its neckline level, breakout direction, side, height, and stop level (the head).',
    {
      bars: z.array(barSchema).describe('OHLC candle array, oldest first (e.g. from binance klines)'),
      swing_highs: z.array(swingPointSchema).describe('Confirmed swing highs in chronological order — [{index, price}, ...]'),
      swing_lows: z.array(swingPointSchema).describe('Confirmed swing lows in chronological order — [{index, price}, ...]'),
      shoulder_tolerance_percent: z.coerce.number().positive().optional().describe('Max % difference between the two shoulders (default 5)'),
    },
    async ({ bars, swing_highs, swing_lows, shoulder_tolerance_percent }) => {
      try {
        return jsonResult({
          success: true,
          patterns: core.findHeadAndShoulders(bars, { swingHighs: swing_highs, swingLows: swing_lows, shoulderTolerancePercent: shoulder_tolerance_percent }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'chart_pattern_build_head_and_shoulders_plan',
    'Build a trade plan (entry/stop/target/side) from a confirmed Head & Shoulders / Inverse Head & Shoulders neckline ' +
    'break, in the exact shape consumed by risk_evaluate_trade_setup. entry = close of the break candle; stop = beyond ' +
    'the head (the pattern\'s single most extreme point); target = the measured move (head-to-neckline height projected from entry).',
    {
      pattern: patternSchema.describe('A head_and_shoulders/inverse_head_and_shoulders result from chart_pattern_find_head_and_shoulders'),
      breakout: breakoutSchema.describe('A confirmed neckline break from chart_pattern_scan_neckline_break'),
      range_level: z.coerce.number().optional().describe('Price of the range high/low — becomes the plan\'s alternate_target'),
    },
    async ({ pattern, breakout, range_level }) => {
      try { return jsonResult({ success: true, plan: core.buildHeadAndShouldersTradePlan({ pattern, breakout, rangeLevel: range_level }) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'chart_pattern_find_triangle',
    'Classify the two most recent swing highs and two most recent swing lows into a triangle by their slopes: ascending ' +
    '(flat resistance, rising support -> breakout above is long), descending (flat support, falling resistance -> ' +
    'breakout below is short), or symmetrical (both lines converging -> side decided by whichever line breaks first). ' +
    '"Flat" means |slope| <= flat_slope_percent% of the latest close, per bar. Returns null if fewer than 2 swing highs/lows ' +
    'are available or the shape doesn\'t match one of the three triangle types (e.g. both lines rising = a channel, not a triangle).',
    {
      bars: z.array(barSchema).describe('OHLC candle array, oldest first (e.g. from binance klines)'),
      swing_highs: z.array(swingPointSchema).describe('Confirmed swing highs in chronological order — [{index, price}, ...]'),
      swing_lows: z.array(swingPointSchema).describe('Confirmed swing lows in chronological order — [{index, price}, ...]'),
      flat_slope_percent: z.coerce.number().positive().optional().describe('Max |slope| (as % of latest close per bar) to count as "flat" (default 0.02)'),
    },
    async ({ bars, swing_highs, swing_lows, flat_slope_percent }) => {
      try {
        return jsonResult({
          success: true,
          triangle: core.findTriangle(bars, { swingHighs: swing_highs, swingLows: swing_lows, flatSlopePercent: flat_slope_percent }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'chart_pattern_scan_triangle_breakout',
    'Scan a bar series for a confirmed close-based triangle breakout (from chart_pattern_find_triangle). Ascending ' +
    'triangles only check the upper (flat resistance) line; descending only the lower (flat support) line; symmetrical ' +
    'checks both and returns whichever breaks first chronologically. Returns null if no breakout has occurred yet.',
    {
      bars: z.array(barSchema).describe('OHLC candle array, oldest first — should include bars after the triangle formed'),
      triangle: patternSchema.describe('A triangle result from chart_pattern_find_triangle'),
    },
    async ({ bars, triangle }) => {
      try { return jsonResult({ success: true, breakout: core.scanForTriangleBreakout(bars, triangle) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'chart_pattern_build_triangle_plan',
    'Build a trade plan (entry/stop/target/side) from a confirmed triangle breakout, in the exact shape consumed by ' +
    'risk_evaluate_trade_setup. entry = close of the break candle; stop = the most recent swing point on the line that ' +
    'did NOT break; target = the measured move (the triangle\'s widest height projected from entry).',
    {
      triangle: patternSchema.describe('A triangle result from chart_pattern_find_triangle'),
      breakout: breakoutSchema.describe('A confirmed triangle breakout from chart_pattern_scan_triangle_breakout'),
      range_level: z.coerce.number().optional().describe('Price of the range high/low — becomes the plan\'s alternate_target'),
    },
    async ({ triangle, breakout, range_level }) => {
      try { return jsonResult({ success: true, plan: core.buildTriangleTradePlan({ triangle, breakout, rangeLevel: range_level }) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'chart_pattern_find_flag_pennant',
    'Find a Flag/Pennant continuation pattern: a sharp directional "flagpole" move over pole_lookback bars (net ' +
    'close-to-open move covering >= pole_directionality_ratio of the pole\'s high-low range), followed by a tight ' +
    'consolidation over flag_lookback bars (high-low range <= consolidation_max_ratio of the pole\'s range). Breakout ' +
    'direction = the flagpole\'s direction (continuation). Returns null if there isn\'t enough history, the pole isn\'t ' +
    'directional enough, or the consolidation isn\'t tight enough.',
    {
      bars: z.array(barSchema).describe('OHLC candle array, oldest first (e.g. from binance klines)'),
      pole_lookback: z.coerce.number().int().positive().optional().describe('Bars in the flagpole window, immediately before the flag window (default 10)'),
      flag_lookback: z.coerce.number().int().positive().optional().describe('Bars in the consolidation window, the most recent bars (default 8)'),
      pole_directionality_ratio: z.coerce.number().positive().optional().describe('Min net-move / range ratio for the pole to count as directional (default 0.6)'),
      consolidation_max_ratio: z.coerce.number().positive().optional().describe('Max flag-range / pole-range ratio for the consolidation to count as tight (default 0.5)'),
    },
    async ({ bars, pole_lookback, flag_lookback, pole_directionality_ratio, consolidation_max_ratio }) => {
      try {
        return jsonResult({
          success: true,
          pattern: core.findFlagPennant(bars, {
            poleLookback: pole_lookback,
            flagLookback: flag_lookback,
            poleDirectionalityRatio: pole_directionality_ratio,
            consolidationMaxRatio: consolidation_max_ratio,
          }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'chart_pattern_scan_flag_breakout',
    'Scan a bar series for the close-based break of a flag/pennant\'s consolidation range in the flagpole\'s direction ' +
    '(continuation confirmation). Returns null if no breakout has occurred yet.',
    {
      bars: z.array(barSchema).describe('OHLC candle array, oldest first — should include bars after the flag/pennant formed'),
      pattern: patternSchema.describe('A flag_pennant result from chart_pattern_find_flag_pennant'),
    },
    async ({ bars, pattern }) => {
      try { return jsonResult({ success: true, breakout: core.scanForFlagBreakout(bars, pattern) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'chart_pattern_build_flag_plan',
    'Build a trade plan (entry/stop/target/side) from a confirmed flag/pennant breakout, in the exact shape consumed by ' +
    'risk_evaluate_trade_setup. entry = close of the break candle; stop = the opposite edge of the consolidation range; ' +
    'target = the measured move (the flagpole\'s height projected from entry — "the flagpole repeats").',
    {
      pattern: patternSchema.describe('A flag_pennant result from chart_pattern_find_flag_pennant'),
      breakout: breakoutSchema.describe('A confirmed flag breakout from chart_pattern_scan_flag_breakout'),
      range_level: z.coerce.number().optional().describe('Price of the range high/low — becomes the plan\'s alternate_target'),
    },
    async ({ pattern, breakout, range_level }) => {
      try { return jsonResult({ success: true, plan: core.buildFlagTradePlan({ pattern, breakout, rangeLevel: range_level }) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
